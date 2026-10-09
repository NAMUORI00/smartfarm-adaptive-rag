from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from .contracts import (
    ActorRole,
    ApprovalToolArguments,
    AuditEvent,
    ControlProposal,
    ControlProposalCreate,
    ControlImpactPreviewArguments,
    DeviceCapabilityToolArguments,
    ExecutionTrackingArguments,
    PRODUCT_TARGET_BY_ACTION,
    ProposalStatus,
    RejectionToolArguments,
    RequestContext,
    SimulatedExecution,
    TimeseriesToolArguments,
)
from .device_adapter import (
    DeviceCommandAdapter,
    SimulatorDeviceCommandAdapter,
    preview_control_impact,
    summarize_devices,
)
from .telemetry_client import (
    TelemetryGateway,
    TelemetryGatewayConflictError,
    TelemetryGatewayError,
)


class ToolInputError(ValueError):
    pass


class FarmOperationsService:
    def __init__(
        self,
        telemetry: TelemetryGateway,
        state_path: str | Path | None = None,
        audit_retention: int = 1_000,
        device_adapter: DeviceCommandAdapter | None = None,
    ) -> None:
        if audit_retention < 1:
            raise ValueError("audit_retention must be positive")
        self._telemetry = telemetry
        self._device_adapter = device_adapter or SimulatorDeviceCommandAdapter(telemetry)
        self._state_path = Path(state_path) if state_path else None
        self._audit_retention = audit_retention
        self._proposals: dict[str, ControlProposal] = {}
        self._audit_events: list[AuditEvent] = []
        self._lock = threading.Lock()
        self._load_state()

    async def snapshot(self, context: RequestContext) -> dict[str, Any]:
        payload = await self._device_adapter.read_snapshot(context.farm_id)
        self._audit(context, "telemetry.snapshot")
        return self._with_correlation(payload, context.correlation_id)

    async def timeseries(self, context: RequestContext, arguments: TimeseriesToolArguments) -> dict[str, Any]:
        payload = await self._telemetry.timeseries(
            context.farm_id,
            arguments.metric,
            arguments.start.isoformat(),
            arguments.end.isoformat(),
            arguments.interval_minutes,
            arguments.zone_id,
        )
        self._audit(
            context,
            "telemetry.timeseries",
            {"metric": arguments.metric, "zone_id": arguments.zone_id},
        )
        return self._with_correlation(payload, context.correlation_id)

    async def alerts(self, context: RequestContext, alert_status: str | None = None) -> list[dict[str, Any]]:
        payload = await self._telemetry.alerts(context.farm_id, alert_status)
        self._audit(context, "telemetry.alerts", {"status": alert_status})
        return [self._with_correlation(alert, context.correlation_id) for alert in payload]

    def propose_control(self, context: RequestContext, request: ControlProposalCreate) -> ControlProposal:
        self._require_role(context, ActorRole.OPERATOR, ActorRole.ADMIN)
        request_payload = request.model_dump(mode="python")
        proposal = ControlProposal(
            proposal_id=str(uuid.uuid4()),
            farm_id=context.farm_id,
            action=request.action,
            target_value=request.target_value,
            zone_id=request.zone_id,
            rationale=request.rationale,
            requested_action=request.requested_action,
            requested_target=request.requested_target,
            origin=request.origin,
            advisor_run_id=request.advisor_run_id,
            evidence_ids=request.evidence_ids,
            alert_id=request.alert_id,
            alert_occurrence_id=request.alert_occurrence_id,
            proposed_by=context.actor_id,
            proposed_at=self._now(),
            correlation_id=context.correlation_id,
        )
        with self._lock:
            existing = next(
                (
                    item
                    for item in self._proposals.values()
                    if item.farm_id == context.farm_id and item.correlation_id == context.correlation_id
                ),
                None,
            )
            if existing is not None:
                existing_payload = {field: getattr(existing, field) for field in request_payload}
                if existing_payload == request_payload:
                    self._ensure_proposal_audit_locked(existing)
                    return existing
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Correlation ID is already used for a different control proposal",
                )
            event = self._audit_event(
                context,
                "control.proposed",
                {
                    "proposal_id": proposal.proposal_id,
                    "action": proposal.action.value,
                    "zone_id": proposal.zone_id,
                    **self._proposal_provenance(proposal),
                },
                correlation_id=proposal.correlation_id,
            )
            self._commit_state_locked(
                proposals={**self._proposals, proposal.proposal_id: proposal},
                audit_event=event,
            )
        return proposal

    async def approve_control(self, context: RequestContext, proposal_id: str) -> ControlProposal:
        self._require_role(context, ActorRole.OPERATOR, ActorRole.ADMIN)
        with self._lock:
            proposal = self._proposal_for_context(context, proposal_id)
            if proposal.execution is not None:
                self._ensure_completion_audit_locked(proposal)
                return proposal
            conflict = next((item for item in self._proposals.values()
                if item.proposal_id != proposal.proposal_id and item.farm_id == context.farm_id
                and item.zone_id == proposal.zone_id and (item.action == proposal.action or
                    {str(item.action),str(proposal.action)} <= {"set_heating_enabled","set_cooling_enabled"})
                and item.execution is None and item.status in {ProposalStatus.APPROVED, ProposalStatus.FAILED}), None)
            if conflict is not None:
                raise HTTPException(409, "같은 설비의 이전 요청 결과를 먼저 확인하세요.")
            if proposal.status is ProposalStatus.REJECTED:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Control proposal is no longer pending")
            if (
                proposal.status is ProposalStatus.FAILED
                and proposal.failure_reason
                and proposal.failure_reason.startswith("Control execution conflict: ")
            ):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=proposal.failure_reason.removeprefix("Control execution conflict: "),
                )
            if proposal.status is ProposalStatus.PENDING:
                approved = proposal.model_copy(
                    update={
                        "status": ProposalStatus.APPROVED,
                        "approved_by": context.actor_id,
                        "approved_at": self._now(),
                    }
                )
            else:
                approved = proposal.model_copy(
                    update={"status": ProposalStatus.APPROVED, "failure_reason": None}
                )
            self._commit_state_locked(
                proposals={**self._proposals, proposal_id: approved},
            )

        try:
            execution = await self._execute_with_reconciliation(approved)
            execution_info = SimulatedExecution(
                execution_id=str(execution["execution_id"]),
                executed_at=execution.get("executed_at"),
                actuator_state=execution.get("actuator_state"),
                device_command_status=execution.get("device_command_status"),
                correlation_id=str(execution.get("correlation_id", approved.correlation_id)),
                simulated_only=True,
            )
        except (KeyError, TelemetryGatewayError, TypeError, ValueError) as error:
            failure_reason = (
                f"Control execution conflict: {error}"
                if isinstance(error, TelemetryGatewayConflictError)
                else str(error)
            )
            with self._lock:
                current = self._proposal_for_context(context, proposal_id)
                if current.execution is not None:
                    return current
                if current.status is ProposalStatus.FAILED and current.failure_reason == failure_reason:
                    failed = current
                else:
                    failed = approved.model_copy(
                        update={"status": ProposalStatus.FAILED, "failure_reason": failure_reason}
                    )
                    event = self._audit_event(
                        self._approval_context(context, approved),
                        "control.execution_failed",
                        {
                            "proposal_id": proposal_id,
                            "failure_reason": failure_reason,
                            **self._proposal_provenance(approved),
                        },
                        correlation_id=approved.correlation_id,
                    )
                    self._commit_state_locked(
                        proposals={**self._proposals, proposal_id: failed},
                        audit_event=event,
                    )
            if isinstance(error, TelemetryGatewayConflictError):
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
            return failed

        completed = approved.model_copy(
            update={"execution_id": execution_info.execution_id, "execution": execution_info}
        )
        with self._lock:
            current = self._proposal_for_context(context, proposal_id)
            if current.execution is not None:
                self._ensure_completion_audit_locked(current)
                return current
            event = self._completion_audit_event(completed)
            self._commit_state_locked(
                proposals={**self._proposals, proposal_id: completed},
                audit_event=event,
            )
        return completed

    async def _execute_with_reconciliation(self, proposal: ControlProposal) -> dict[str, Any]:
        """Replay once so telemetry's proposal ledger can recover a lost response."""

        last_error: TelemetryGatewayError | None = None
        for _attempt in range(2):
            try:
                execution = await self._device_adapter.request_command(proposal)
                self._validate_execution(proposal, execution)
                return execution
            except TelemetryGatewayConflictError:
                raise
            except TelemetryGatewayError as error:
                last_error = error
        assert last_error is not None
        raise last_error

    @staticmethod
    def _validate_execution(proposal: ControlProposal, execution: dict[str, Any]) -> None:
        if execution.get("simulated_only") is not True:
            raise TelemetryGatewayError("Telemetry execution was not confirmed as simulated-only")
        expected = {
            "proposal_id": proposal.proposal_id,
            "farm_id": proposal.farm_id,
            "action": proposal.action.value,
            "zone_id": proposal.zone_id,
            "correlation_id": proposal.correlation_id,
        }
        actual = {**execution, "zone_id": execution.get("zone_id", "zone-a")}
        if any(actual.get(field) != value for field, value in expected.items()):
            raise TelemetryGatewayConflictError(
                "Telemetry execution does not match the approved control proposal"
            )
        if not isinstance(execution.get("execution_id"), str) or not execution["execution_id"]:
            raise TelemetryGatewayError("Telemetry execution_id was missing")

    def reject_control(self, context: RequestContext, proposal_id: str, reason: str | None = None) -> ControlProposal:
        """Close a pending proposal in the same authoritative MCP store.

        Rejection never reaches telemetry, but recording it here prevents a
        product-side rejection from leaving an executable MCP proposal behind.
        """

        self._require_role(context, ActorRole.OPERATOR, ActorRole.ADMIN)
        with self._lock:
            proposal = self._proposal_for_context(context, proposal_id)
            if proposal.status is not ProposalStatus.PENDING:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Control proposal is no longer pending")
            rejected = proposal.model_copy(
                update={
                    "status": ProposalStatus.REJECTED,
                    "rejected_by": context.actor_id,
                    "rejected_at": self._now(),
                    "rejection_reason": reason,
                }
            )
            event = self._audit_event(
                context,
                "control.rejected",
                {"proposal_id": proposal_id, "reason": reason, **self._proposal_provenance(rejected)},
                correlation_id=proposal.correlation_id,
            )
            self._commit_state_locked(
                proposals={**self._proposals, proposal_id: rejected},
                audit_event=event,
            )
        return rejected

    def list_proposals(self, context: RequestContext) -> list[ControlProposal]:
        with self._lock:
            proposals = [proposal for proposal in self._proposals.values() if proposal.farm_id == context.farm_id]
        return sorted(proposals, key=lambda proposal: proposal.proposed_at, reverse=True)

    def get_proposal(self, context: RequestContext, proposal_id: str) -> ControlProposal:
        """Return one proposal from the same authoritative, farm-scoped store."""

        with self._lock:
            return self._proposal_for_context(context, proposal_id)

    def reset_demo_state(self, context: RequestContext) -> int:
        """Clear this farm's pending proposals while preserving completed history."""

        self._require_role(context, ActorRole.OPERATOR, ActorRole.ADMIN)
        with self._lock:
            proposal_ids = [
                proposal_id
                for proposal_id, proposal in self._proposals.items()
                if proposal.farm_id == context.farm_id and proposal.status is ProposalStatus.PENDING
            ]
            proposals = {
                proposal_id: proposal
                for proposal_id, proposal in self._proposals.items()
                if proposal_id not in proposal_ids
            }
            event = self._audit_event(context, "demo.state_reset", {"reset_proposals": len(proposal_ids)})
            self._commit_state_locked(proposals=proposals, audit_event=event)
        return len(proposal_ids)

    def audit_events(self, context: RequestContext, limit: int = 100) -> list[AuditEvent]:
        with self._lock:
            events = [event for event in self._audit_events if event.farm_id == context.farm_id]
        return list(reversed(events[-limit:]))

    async def list_devices(self, context: RequestContext) -> dict[str, Any]:
        capabilities = self._device_adapter.describe_capabilities(context.farm_id)
        snapshot = await self._device_adapter.read_snapshot(context.farm_id)
        devices = summarize_devices(capabilities, snapshot)
        self._audit(context, "device.list", {"device_count": len(devices)})
        return {
            "farm_id": context.farm_id,
            "profile_id": capabilities["profile_id"],
            "devices": devices,
            "correlation_id": context.correlation_id,
            "simulated_only": True,
        }

    async def device_capabilities(
        self,
        context: RequestContext,
        arguments: DeviceCapabilityToolArguments,
    ) -> dict[str, Any]:
        capabilities = self._device_adapter.describe_capabilities(
            context.farm_id,
            arguments.device_id,
        )
        snapshot = await self._device_adapter.read_snapshot(context.farm_id)
        device_ids = {
            thing["x-smartfarm"]["deviceId"] for thing in capabilities["things"]
        }
        current_feedback = [
            item
            for item in snapshot.get("device_feedback", [])
            if isinstance(item, dict) and item.get("device_id") in device_ids
        ]
        self._audit(
            context,
            "device.capabilities",
            {"device_id": arguments.device_id, "device_count": len(capabilities["things"])},
        )
        return {
            **capabilities,
            "current_feedback": current_feedback,
            "correlation_id": context.correlation_id,
        }

    async def control_impact_preview(
        self,
        context: RequestContext,
        arguments: ControlImpactPreviewArguments,
    ) -> dict[str, Any]:
        capabilities = self._device_adapter.describe_capabilities(context.farm_id)
        snapshot = await self._device_adapter.read_snapshot(context.farm_id)
        preview = preview_control_impact(
            capabilities,
            snapshot,
            arguments.action,
            arguments.target_value,
            arguments.zone_id,
        )
        self._audit(
            context,
            "control.impact_previewed",
            {
                "action": arguments.action.value,
                "device_id": preview["device_id"],
                "zone_id": arguments.zone_id,
            },
        )
        return {**preview, "farm_id": context.farm_id, "correlation_id": context.correlation_id}

    async def recent_executions(
        self,
        context: RequestContext,
        arguments: ExecutionTrackingArguments,
    ) -> dict[str, Any]:
        with self._lock:
            proposals = [
                proposal
                for proposal in self._proposals.values()
                if proposal.farm_id == context.farm_id and proposal.execution is not None
            ]
            if arguments.proposal_id is not None:
                proposals = [
                    proposal for proposal in proposals if proposal.proposal_id == arguments.proposal_id
                ]
                if not proposals:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Completed control execution not found",
                    )
        proposals = sorted(proposals, key=lambda proposal: proposal.approved_at or proposal.proposed_at, reverse=True)
        records: list[dict[str, Any]] = []
        for proposal in proposals[: arguments.limit]:
            adapter_status = await self._device_adapter.read_command_status(
                context.farm_id,
                proposal.proposal_id,
            )
            stored_status = proposal.execution.device_command_status if proposal.execution else None
            status_payload = adapter_status or stored_status or {
                "proposal_id": proposal.proposal_id,
                "execution_id": proposal.execution_id,
                "farm_id": proposal.farm_id,
                "device_id": proposal.requested_target or PRODUCT_TARGET_BY_ACTION[proposal.action],
                "instance_id": f"{proposal.zone_id}:{proposal.requested_target or PRODUCT_TARGET_BY_ACTION[proposal.action]}",
                "zone_id": proposal.zone_id,
                "action": proposal.action.value,
                "status": "recorded",
                "commanded": proposal.target_value,
                "reported": None,
                "effective": None,
                "health": "unknown",
                "observed_at": proposal.execution.executed_at if proposal.execution else proposal.approved_at,
                "simulated_only": True,
            }
            record = {
                **status_payload,
                "tracking_source": "adapter" if adapter_status else "proposal_ledger",
                "outcome": None,
            }
            if arguments.proposal_id is not None:
                record["outcome"] = await self._device_adapter.confirm_outcome(proposal)
            records.append(record)
        self._audit(
            context,
            "control.executions_tracked",
            {"proposal_id": arguments.proposal_id, "execution_count": len(records)},
        )
        return {
            "farm_id": context.farm_id,
            "executions": records,
            "correlation_id": context.correlation_id,
            "simulated_only": True,
        }

    async def call_tool(self, context: RequestContext, name: str, arguments: dict[str, Any]) -> Any:
        if name == "get_farm_snapshot":
            self._reject_unexpected_arguments(arguments)
            return await self.snapshot(context)
        if name == "get_sensor_timeseries":
            return await self.timeseries(context, self._parse_timeseries_arguments(arguments))
        if name == "list_alerts":
            status_value = arguments.pop("status", None) if isinstance(arguments, dict) else None
            self._reject_unexpected_arguments(arguments)
            if status_value not in (None, "open", "acknowledged"):
                raise ToolInputError("status must be open or acknowledged")
            return await self.alerts(context, status_value)
        if name == "list_farm_devices":
            self._reject_unexpected_arguments(arguments)
            return await self.list_devices(context)
        if name == "get_device_capabilities":
            return await self.device_capabilities(
                context,
                self._parse_device_capability_arguments(arguments),
            )
        if name == "preview_control_impact":
            return await self.control_impact_preview(
                context,
                self._parse_control_impact_arguments(arguments),
            )
        if name == "track_recent_executions":
            return await self.recent_executions(
                context,
                self._parse_execution_tracking_arguments(arguments),
            )
        if name == "propose_control_action":
            return self.propose_control(context, self._parse_proposal(arguments))
        if name == "approve_control_proposal":
            return await self.approve_control(context, self._parse_approval(arguments).proposal_id)
        if name == "reject_control_proposal":
            rejection = self._parse_rejection(arguments)
            return self.reject_control(context, rejection.proposal_id, rejection.reason)
        raise ToolInputError(f"Unknown tool: {name}")

    @staticmethod
    def _parse_timeseries_arguments(arguments: dict[str, Any]) -> TimeseriesToolArguments:
        try:
            return TimeseriesToolArguments.model_validate(arguments)
        except Exception as error:
            raise ToolInputError(str(error)) from error

    @staticmethod
    def _parse_proposal(arguments: dict[str, Any]) -> ControlProposalCreate:
        try:
            return ControlProposalCreate.model_validate(arguments)
        except Exception as error:
            raise ToolInputError(str(error)) from error

    @staticmethod
    def _parse_approval(arguments: dict[str, Any]) -> ApprovalToolArguments:
        try:
            return ApprovalToolArguments.model_validate(arguments)
        except Exception as error:
            raise ToolInputError(str(error)) from error

    @staticmethod
    def _parse_rejection(arguments: dict[str, Any]) -> RejectionToolArguments:
        try:
            return RejectionToolArguments.model_validate(arguments)
        except Exception as error:
            raise ToolInputError(str(error)) from error

    @staticmethod
    def _parse_device_capability_arguments(
        arguments: dict[str, Any],
    ) -> DeviceCapabilityToolArguments:
        try:
            return DeviceCapabilityToolArguments.model_validate(arguments)
        except Exception as error:
            raise ToolInputError(str(error)) from error

    @staticmethod
    def _parse_control_impact_arguments(
        arguments: dict[str, Any],
    ) -> ControlImpactPreviewArguments:
        try:
            return ControlImpactPreviewArguments.model_validate(arguments)
        except Exception as error:
            raise ToolInputError(str(error)) from error

    @staticmethod
    def _parse_execution_tracking_arguments(
        arguments: dict[str, Any],
    ) -> ExecutionTrackingArguments:
        try:
            return ExecutionTrackingArguments.model_validate(arguments)
        except Exception as error:
            raise ToolInputError(str(error)) from error

    @staticmethod
    def _reject_unexpected_arguments(arguments: dict[str, Any]) -> None:
        if not isinstance(arguments, dict) or arguments:
            raise ToolInputError("This tool does not accept arguments")

    def _proposal_for_context(self, context: RequestContext, proposal_id: str) -> ControlProposal:
        proposal = self._proposals.get(proposal_id)
        if proposal is None or proposal.farm_id != context.farm_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Control proposal not found")
        return proposal

    def _load_state(self) -> None:
        if self._state_path is None or not self._state_path.exists():
            return
        payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        if payload.get("version") not in (1, 2, 3) or not isinstance(payload.get("proposals"), list):
            raise ValueError(f"Unsupported FarmOps state file: {self._state_path}")
        proposals = [ControlProposal.model_validate(item) for item in payload["proposals"]]
        audit_events = [AuditEvent.model_validate(item) for item in payload.get("audit_events", [])]
        self._proposals = {proposal.proposal_id: proposal for proposal in proposals}
        self._audit_events = audit_events[-self._audit_retention :]

    def _persist_state_locked(self) -> None:
        if self._state_path is None:
            return
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = self._state_path.with_name(f"{self._state_path.name}.tmp")
        payload = {
            "version": 3,
            "proposals": [proposal.model_dump(mode="json") for proposal in self._proposals.values()],
            "audit_events": [event.model_dump(mode="json") for event in self._audit_events],
        }
        temporary_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temporary_path.replace(self._state_path)

    def _commit_state_locked(
        self,
        *,
        proposals: dict[str, ControlProposal] | None = None,
        audit_event: AuditEvent | None = None,
    ) -> None:
        previous_proposals = self._proposals
        previous_audit_events = self._audit_events
        self._proposals = proposals if proposals is not None else previous_proposals
        if audit_event is not None:
            self._audit_events = [*previous_audit_events, audit_event][-self._audit_retention :]
        try:
            self._persist_state_locked()
        except Exception:
            self._proposals = previous_proposals
            self._audit_events = previous_audit_events
            raise

    def _has_proposal_audit_locked(self, proposal_id: str, action: str) -> bool:
        return any(
            event.action == action and event.detail.get("proposal_id") == proposal_id
            for event in self._audit_events
        )

    def _ensure_proposal_audit_locked(self, proposal: ControlProposal) -> None:
        if self._has_proposal_audit_locked(proposal.proposal_id, "control.proposed"):
            return
        context = RequestContext(
            farm_id=proposal.farm_id,
            actor_id=proposal.proposed_by,
            actor_role=ActorRole.OPERATOR,
            correlation_id=proposal.correlation_id,
        )
        event = self._audit_event(
            context,
            "control.proposed",
            {
                "proposal_id": proposal.proposal_id,
                "action": proposal.action.value,
                "zone_id": proposal.zone_id,
                **self._proposal_provenance(proposal),
            },
            correlation_id=proposal.correlation_id,
        )
        self._commit_state_locked(audit_event=event)

    def _ensure_completion_audit_locked(self, proposal: ControlProposal) -> None:
        if self._has_proposal_audit_locked(proposal.proposal_id, "control.approved_and_simulated"):
            return
        self._commit_state_locked(audit_event=self._completion_audit_event(proposal))

    def _completion_audit_event(self, proposal: ControlProposal) -> AuditEvent:
        assert proposal.execution is not None
        context = RequestContext(
            farm_id=proposal.farm_id,
            actor_id=proposal.approved_by or proposal.proposed_by,
            actor_role=ActorRole.OPERATOR,
            correlation_id=proposal.correlation_id,
        )
        return self._audit_event(
            context,
            "control.approved_and_simulated",
            {
                "proposal_id": proposal.proposal_id,
                "execution_id": proposal.execution_id,
                "zone_id": proposal.zone_id,
                "execution": proposal.execution.model_dump(mode="json"),
                **self._proposal_provenance(proposal),
            },
            correlation_id=proposal.correlation_id,
        )

    @staticmethod
    def _proposal_provenance(proposal: ControlProposal) -> dict[str, Any]:
        if proposal.origin is None:
            return {}
        return {
            "origin": proposal.origin,
            "advisor_run_id": proposal.advisor_run_id,
            "evidence_ids": list(proposal.evidence_ids),
            "alert_id": proposal.alert_id,
            "alert_occurrence_id": proposal.alert_occurrence_id,
        }

    @staticmethod
    def _require_role(context: RequestContext, *allowed: ActorRole) -> None:
        if context.actor_role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Operator approval is required")

    @staticmethod
    def _with_correlation(payload: dict[str, Any], correlation_id: str) -> dict[str, Any]:
        return {**payload, "correlation_id": correlation_id}

    @staticmethod
    def _approval_context(context: RequestContext, proposal: ControlProposal) -> RequestContext:
        return context.model_copy(update={"actor_id": proposal.approved_by or context.actor_id})

    def _audit(
        self,
        context: RequestContext,
        action: str,
        detail: dict[str, Any] | None = None,
        correlation_id: str | None = None,
    ) -> None:
        event = self._audit_event(context, action, detail, correlation_id)
        with self._lock:
            self._commit_state_locked(audit_event=event)

    def _audit_event(
        self,
        context: RequestContext,
        action: str,
        detail: dict[str, Any] | None = None,
        correlation_id: str | None = None,
    ) -> AuditEvent:
        return AuditEvent(
            event_id=str(uuid.uuid4()),
            farm_id=context.farm_id,
            actor_id=context.actor_id,
            action=action,
            occurred_at=self._now(),
            correlation_id=correlation_id or context.correlation_id,
            detail=detail or {},
        )

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc).replace(microsecond=0)
