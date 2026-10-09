from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.contracts import ActorRole, ControlProposalCreate, RequestContext
from app.service import FarmOperationsService
from app.telemetry_client import (
    HttpTelemetryGateway,
    TelemetryGateway,
    TelemetryGatewayConflictError,
    TelemetryGatewayError,
)


class FakeTelemetry(TelemetryGateway):
    def __init__(self) -> None:
        self.executed: list[dict[str, Any]] = []
        self.timeseries_calls: list[dict[str, Any]] = []

    async def snapshot(self, farm_id: str) -> dict[str, Any]:
        return {"farm": {"farm_id": farm_id}, "readings": [], "simulated_only": True}

    async def timeseries(
        self,
        farm_id: str,
        metric: str,
        start: str,
        end: str,
        interval_minutes: int,
        zone_id: str = "zone-a",
    ) -> dict[str, Any]:
        self.timeseries_calls.append(
            {
                "farm_id": farm_id,
                "metric": metric,
                "start": start,
                "end": end,
                "interval_minutes": interval_minutes,
                "zone_id": zone_id,
            }
        )
        return {
            "farm_id": farm_id,
            "metric": metric,
            "zone_id": zone_id,
            "points": [],
            "simulated_only": True,
        }

    async def alerts(self, farm_id: str, status: str | None = None) -> list[dict[str, Any]]:
        return [{"farm_id": farm_id, "status": status or "open"}]

    async def execute_simulated_control(self, proposal: Any) -> dict[str, Any]:
        payload = {"execution_id": f"sim-{proposal.proposal_id}", "simulated_only": True}
        self.executed.append(
            {
                **payload,
                "action": proposal.action.value,
                "target_value": proposal.target_value,
                "zone_id": proposal.zone_id,
            }
        )
        return {
            **payload,
            "proposal_id": proposal.proposal_id,
            "farm_id": proposal.farm_id,
            "action": proposal.action.value,
            "zone_id": proposal.zone_id,
            "correlation_id": proposal.correlation_id,
        }


class LedgerTelemetry(FakeTelemetry):
    def __init__(self, *, lose_first_response: bool = False) -> None:
        super().__init__()
        self.calls = 0
        self.effects = 0
        self.lose_first_response = lose_first_response
        self.ledger: dict[str, dict[str, Any]] = {}

    async def execute_simulated_control(self, proposal: Any) -> dict[str, Any]:
        self.calls += 1
        execution = self.ledger.get(proposal.proposal_id)
        if execution is None:
            self.effects += 1
            execution = {
                "execution_id": f"sim-{proposal.proposal_id}",
                "proposal_id": proposal.proposal_id,
                "farm_id": proposal.farm_id,
                "action": proposal.action.value,
                "correlation_id": proposal.correlation_id,
                "simulated_only": True,
            }
            self.ledger[proposal.proposal_id] = execution
            await asyncio.sleep(0)
            if self.lose_first_response:
                self.lose_first_response = False
                raise TelemetryGatewayError("response lost after telemetry committed the command")
        return execution


class ConflictingLedgerTelemetry(FakeTelemetry):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    async def execute_simulated_control(self, proposal: Any) -> dict[str, Any]:
        self.calls += 1
        raise TelemetryGatewayConflictError(
            "proposal_id was already executed with a different control payload"
        )


def headers(actor_id: str = "advisor-service", role: str = "operator", farm_id: str = "farm-wasabi-a") -> dict[str, str]:
    return {
        "X-Farm-Id": farm_id,
        "X-Actor-Id": actor_id,
        "X-Actor-Role": role,
        "X-Internal-Service-Token": "local-mcp-development-token",
    }


def test_authenticated_health_endpoint_supports_compose_probe() -> None:
    client = TestClient(create_app(FakeTelemetry()))

    response = client.get(
        "/health",
        headers={"X-Internal-Service-Token": "local-mcp-development-token"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "service": "farm-mcp",
        "simulated_only": True,
    }


def test_http_telemetry_gateway_forwards_zone_id(monkeypatch) -> None:
    gateway = HttpTelemetryGateway(base_url="http://telemetry:8001")
    captured: dict[str, Any] = {}

    async def fake_request(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        captured.update({"method": method, "path": path, **kwargs})
        return {"farm_id": "farm-wasabi-a", "metric": "root_zone_temperature_c", "zone_id": "zone-b"}

    monkeypatch.setattr(gateway, "_request", fake_request)
    result = asyncio.run(
        gateway.timeseries(
            "farm-wasabi-a",
            "root_zone_temperature_c",
            "2026-07-30T00:00:00Z",
            "2026-07-30T01:00:00Z",
            10,
            "zone-b",
        )
    )

    assert result["zone_id"] == "zone-b"
    assert captured["params"]["zone_id"] == "zone-b"

    proposal = FarmOperationsService(FakeTelemetry()).propose_control(
        RequestContext(
            farm_id="farm-wasabi-a",
            actor_id="operator-01",
            actor_role=ActorRole.OPERATOR,
            correlation_id="zone-forwarding",
        ),
        ControlProposalCreate(
            action="set_cooling_enabled",
            target_value=True,
            zone_id="zone-b",
            rationale="2구역 냉각기 가동 요청",
        ),
    )
    asyncio.run(gateway.execute_simulated_control(proposal))

    assert captured["json"]["zone_id"] == "zone-b"


def test_mcp_initialize_and_tools_omit_farm_id() -> None:
    client = TestClient(create_app(FakeTelemetry()))

    initialized = client.post("/mcp", headers=headers(), json={"jsonrpc": "2.0", "id": 1, "method": "initialize"})
    tools = client.post("/mcp", headers=headers(), json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})

    assert initialized.status_code == 200
    assert initialized.json()["result"]["capabilities"] == {"tools": {}}
    assert tools.status_code == 200
    schemas = tools.json()["result"]["tools"]
    assert all("farm_id" not in item["inputSchema"]["properties"] for item in schemas)
    timeseries_tool = next(item for item in schemas if item["name"] == "get_sensor_timeseries")
    assert timeseries_tool["inputSchema"]["properties"]["zone_id"] == {
        "type": "string",
        "enum": ["zone-a", "zone-b"],
        "default": "zone-a",
        "description": "Optional cultivation zone identifier.",
    }
    proposal_tool = next(item for item in schemas if item["name"] == "propose_control_action")
    assert proposal_tool["inputSchema"]["properties"]["zone_id"] == {
        "type": "string",
        "enum": ["zone-a", "zone-b"],
        "default": "zone-a",
        "description": "Cultivation zone containing the target device instance.",
    }
    assert "recalibrate_air_temperature_sensor" in proposal_tool["inputSchema"]["properties"]["action"]["enum"]
    assert proposal_tool["inputSchema"]["properties"]["requested_action"]["enum"] == [
        "set_actuator_state",
        "recalibrate_air_temperature_sensor",
    ]
    assert proposal_tool["inputSchema"]["properties"]["origin"]["enum"] == [
        "verified_telemetry_rule",
        "manual",
    ]


def test_manual_mcp_proposal_requires_approval_before_execution() -> None:
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry))

    proposed = client.post(
        "/mcp",
        headers=headers(actor_id="operator-01"),
        json={
            "jsonrpc": "2.0",
            "id": "manual-proposal-1",
            "method": "tools/call",
            "params": {
                "name": "propose_control_action",
                "arguments": {
                    "action": "set_circulation_fan_percent",
                    "target_value": 60,
                    "rationale": "운영자가 환기팬 60% 조정을 요청했습니다.",
                    "requested_action": "set_actuator_state",
                    "requested_target": "ventilation_fan",
                    "origin": "manual",
                    "advisor_run_id": "advisor-manual-1",
                    "evidence_ids": ["farm-wasabi-a:device:ventilation_fan"],
                },
            },
        },
    )

    payload = proposed.json()["result"]["structuredContent"]
    assert proposed.status_code == 200
    assert payload["status"] == "pending"
    assert payload["origin"] == "manual"
    assert payload["alert_id"] is None
    assert payload["alert_occurrence_id"] is None
    assert telemetry.executed == []

    approved = client.post(
        "/mcp",
        headers=headers(actor_id="operator-01"),
        json={
            "jsonrpc": "2.0",
            "id": "manual-approval-1",
            "method": "tools/call",
            "params": {
                "name": "approve_control_proposal",
                "arguments": {"proposal_id": payload["proposal_id"]},
            },
        },
    )

    approved_payload = approved.json()["result"]["structuredContent"]
    assert approved_payload["status"] == "approved"
    assert telemetry.executed == [
        {
            "execution_id": f"sim-{payload['proposal_id']}",
            "simulated_only": True,
            "action": "set_circulation_fan_percent",
            "target_value": 60.0,
            "zone_id": "zone-a",
        }
    ]


def test_mcp_snapshot_uses_trusted_header_context() -> None:
    client = TestClient(create_app(FakeTelemetry()))

    response = client.post(
        "/mcp",
        headers=headers(farm_id="farm-wasabi-a"),
        json={
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "get_farm_snapshot", "arguments": {}},
        },
    )

    payload = response.json()["result"]["structuredContent"]
    assert response.status_code == 200
    assert payload["farm"]["farm_id"] == "farm-wasabi-a"
    assert payload["simulated_only"] is True
    assert payload["correlation_id"] == response.headers["X-Correlation-Id"]


def test_mcp_timeseries_forwards_the_requested_zone_to_telemetry() -> None:
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry))

    response = client.post(
        "/mcp",
        headers=headers(farm_id="farm-wasabi-a"),
        json={
            "jsonrpc": "2.0",
            "id": "zone-b-series",
            "method": "tools/call",
            "params": {
                "name": "get_sensor_timeseries",
                "arguments": {
                    "metric": "root_zone_temperature_c",
                    "start": "2026-07-30T00:00:00Z",
                    "end": "2026-07-30T01:00:00Z",
                    "zone_id": "zone-b",
                },
            },
        },
    )

    payload = response.json()["result"]["structuredContent"]
    assert response.status_code == 200
    assert payload["zone_id"] == "zone-b"
    assert telemetry.timeseries_calls[0]["zone_id"] == "zone-b"


def test_mcp_rejects_farm_id_in_tool_arguments() -> None:
    client = TestClient(create_app(FakeTelemetry()))

    response = client.post(
        "/mcp",
        headers=headers(farm_id="farm-wasabi-a"),
        json={
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "get_sensor_timeseries", "arguments": {
                "farm_id": "farm-not-authorized",
                "metric": "root_zone_temperature_c",
                "start": "2026-07-16T00:00:00Z",
                "end": "2026-07-16T01:00:00Z",
            }},
        },
    )

    result = response.json()["result"]
    assert response.status_code == 200
    assert result["isError"] is True


def test_single_operator_proposes_approves_and_executes_only_in_simulator() -> None:
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry))
    proposal_response = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
        json={
            "action": "set_cooling_enabled",
            "target_value": True,
            "zone_id": "zone-a",
            "rationale": "근권 냉각 장애 경보에 따른 냉각기 가동 제안",
        },
    )
    proposal_id = proposal_response.json()["proposal_id"]

    assert proposal_response.status_code == 200
    assert proposal_response.json()["status"] == "pending"
    assert proposal_response.json()["proposed_by"] == "operator-01"
    assert telemetry.executed == []

    approval = client.post(
        f"/v1/control/proposals/{proposal_id}/approve",
        headers=headers(actor_id="operator-01"),
    )
    audit = client.get("/v1/audit/events", headers=headers(actor_id="operator-01"))

    assert telemetry.executed == [
        {
            "execution_id": f"sim-{proposal_id}",
                "simulated_only": True,
                "action": "set_cooling_enabled",
                "target_value": True,
                "zone_id": "zone-a",
        }
    ]
    assert approval.status_code == 200
    assert approval.json()["status"] == "approved"
    assert approval.json()["approved_by"] == "operator-01"
    assert approval.json()["simulated_only"] is True
    assert approval.json()["execution"]["simulated_only"] is True
    assert approval.json()["action"] == "set_cooling_enabled"
    proposal_events = [event for event in audit.json() if event["detail"].get("proposal_id") == proposal_id]
    assert {event["action"] for event in proposal_events} == {
        "control.proposed",
        "control.approved_and_simulated",
    }
    assert {event["actor_id"] for event in proposal_events} == {"operator-01"}


def test_sensor_recalibration_uses_product_target_and_approval_contract() -> None:
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry))
    proposal = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
        json={
            "action": "recalibrate_air_temperature_sensor",
            "target_value": True,
            "zone_id": "zone-a",
            "rationale": "공기 온도 센서 드리프트 경보에 따른 재보정 제안",
            "requested_action": "recalibrate_air_temperature_sensor",
            "requested_target": "air_temperature_sensor_reset",
        },
    )

    assert proposal.status_code == 200
    assert proposal.json()["status"] == "pending"
    assert proposal.json()["requested_action"] == "recalibrate_air_temperature_sensor"
    assert proposal.json()["requested_target"] == "air_temperature_sensor_reset"
    assert telemetry.executed == []

    approved = client.post(
        f"/v1/control/proposals/{proposal.json()['proposal_id']}/approve",
        headers=headers(actor_id="operator-01"),
    )

    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"
    assert approved.json()["simulated_only"] is True
    assert approved.json()["execution"]["simulated_only"] is True
    assert telemetry.executed == [
        {
            "execution_id": f"sim-{proposal.json()['proposal_id']}",
                "simulated_only": True,
                "action": "recalibrate_air_temperature_sensor",
                "target_value": True,
                "zone_id": "zone-a",
        }
    ]


@pytest.mark.parametrize("target_value", [False, 1])
def test_sensor_recalibration_rejects_values_other_than_true(target_value: bool | int) -> None:
    client = TestClient(create_app(FakeTelemetry()))

    response = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="advisor-service"),
        json={
            "action": "recalibrate_air_temperature_sensor",
            "target_value": target_value,
            "rationale": "공기 온도 센서 드리프트 경보에 따른 재보정 제안",
            "requested_action": "recalibrate_air_temperature_sensor",
            "requested_target": "air_temperature_sensor_reset",
        },
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("action", "requested_action", "requested_target"),
    [
        (
            "recalibrate_air_temperature_sensor",
            "set_actuator_state",
            "air_temperature_sensor_reset",
        ),
        (
            "recalibrate_air_temperature_sensor",
            "recalibrate_air_temperature_sensor",
            "heater",
        ),
        (
            "recalibrate_air_temperature_sensor",
            "recalibrate_air_temperature_sensor",
            None,
        ),
        (
            "set_cooling_enabled",
            "recalibrate_air_temperature_sensor",
            "air_temperature_sensor_reset",
        ),
        (
            "set_cooling_enabled",
            "set_actuator_state",
            "air_temperature_sensor_reset",
        ),
        (
            "set_cooling_enabled",
            "set_actuator_state",
            "heater",
        ),
        (
            "set_heating_enabled",
            "set_actuator_state",
            "root_zone_chiller",
        ),
    ],
)
def test_control_http_contract_rejects_mismatched_action_and_product_target(
    action: str,
    requested_action: str,
    requested_target: str | None,
) -> None:
    client = TestClient(create_app(FakeTelemetry()))

    response = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="advisor-service"),
        json={
            "action": action,
            "target_value": True,
            "rationale": "요청 동작과 제품 대상의 교차 검증",
            "requested_action": requested_action,
            "requested_target": requested_target,
        },
    )

    assert response.status_code == 422


def test_control_and_audit_preserve_supplied_correlation_id() -> None:
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry))
    correlation_id = "demo-flow-20260716"
    proposal_headers = {**headers(actor_id="operator-01"), "X-Correlation-Id": correlation_id}
    proposal_response = client.post(
        "/v1/control/proposals",
        headers=proposal_headers,
        json={
            "action": "set_cooling_enabled",
            "target_value": True,
            "rationale": "근권 냉각 장애 시나리오에 대한 냉각기 가동 제안",
        },
    )
    proposal_id = proposal_response.json()["proposal_id"]
    approval = client.post(
        f"/v1/control/proposals/{proposal_id}/approve",
        headers={**headers(actor_id="operator-01"), "X-Correlation-Id": correlation_id},
    )
    audit = client.get("/v1/audit/events", headers={**headers(actor_id="operator-01"), "X-Correlation-Id": correlation_id})

    assert proposal_response.status_code == 200
    assert proposal_response.headers["X-Correlation-Id"] == correlation_id
    assert proposal_response.json()["correlation_id"] == correlation_id
    assert approval.status_code == 200
    assert approval.json()["execution"]["correlation_id"] == correlation_id
    assert audit.status_code == 200
    assert all(event["correlation_id"] == correlation_id for event in audit.json())
    execution_event = next(event for event in audit.json() if event["action"] == "control.approved_and_simulated")
    assert execution_event["detail"]["execution"]["simulated_only"] is True


def test_propose_retry_with_same_correlation_and_payload_returns_existing_proposal() -> None:
    client = TestClient(create_app(FakeTelemetry()))
    correlation_id = "control-propose-retry-001"
    request_headers = {**headers(actor_id="operator-01"), "X-Correlation-Id": correlation_id}
    payload = {
        "action": "set_cooling_enabled",
        "target_value": True,
        "rationale": "동일 제어 요청 재시도",
    }

    created = client.post("/v1/control/proposals", headers=request_headers, json=payload)
    retried = client.post("/v1/control/proposals", headers=request_headers, json=payload)
    listed = client.get("/v1/control/proposals", headers=request_headers)
    audit = client.get("/v1/audit/events", headers=request_headers)

    assert created.status_code == 200
    assert retried.status_code == 200
    assert retried.json() == created.json()
    assert [item["proposal_id"] for item in listed.json()] == [created.json()["proposal_id"]]
    proposed_events = [event for event in audit.json() if event["action"] == "control.proposed"]
    assert len(proposed_events) == 1


def test_propose_retry_with_same_correlation_and_different_payload_conflicts() -> None:
    client = TestClient(create_app(FakeTelemetry()))
    correlation_id = "control-propose-retry-conflict-001"
    request_headers = {**headers(actor_id="operator-01"), "X-Correlation-Id": correlation_id}
    original_payload = {
        "action": "set_cooling_enabled",
        "target_value": True,
        "rationale": "냉각기 가동 요청",
    }

    created = client.post("/v1/control/proposals", headers=request_headers, json=original_payload)
    conflicted = client.post(
        "/v1/control/proposals",
        headers=request_headers,
        json={**original_payload, "target_value": False},
    )
    listed = client.get("/v1/control/proposals", headers=request_headers)

    assert created.status_code == 200
    assert conflicted.status_code == 409
    assert conflicted.json()["detail"] == "Correlation ID is already used for a different control proposal"
    assert listed.json() == [created.json()]


def test_zone_b_proposal_roundtrip_is_persisted_and_part_of_idempotency(tmp_path: Any) -> None:
    state_path = tmp_path / "zone-proposal-state.json"
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry, state_path=str(state_path)))
    request_headers = {
        **headers(actor_id="operator-01"),
        "X-Correlation-Id": "zone-b-proposal-001",
    }
    payload = {
        "action": "set_cooling_enabled",
        "target_value": True,
        "zone_id": "zone-b",
        "rationale": "2구역 근권 냉각기를 가동합니다.",
    }

    created = client.post("/v1/control/proposals", headers=request_headers, json=payload)
    retried = client.post("/v1/control/proposals", headers=request_headers, json=payload)
    conflict = client.post(
        "/v1/control/proposals",
        headers=request_headers,
        json={**payload, "zone_id": "zone-a"},
    )
    approved = client.post(
        f"/v1/control/proposals/{created.json()['proposal_id']}/approve",
        headers=headers(actor_id="operator-01"),
    )
    restarted = TestClient(create_app(FakeTelemetry(), state_path=str(state_path)))
    restored = restarted.get(
        f"/v1/control/proposals/{created.json()['proposal_id']}",
        headers=headers(role="viewer"),
    )

    assert created.status_code == 200
    assert retried.json() == created.json()
    assert conflict.status_code == 409
    assert approved.status_code == 200
    assert approved.json()["zone_id"] == "zone-b"
    assert approved.json()["execution"]["device_command_status"]["zone_id"] == "zone-b"
    assert telemetry.executed[-1]["zone_id"] == "zone-b"
    assert restored.json()["zone_id"] == "zone-b"


def test_legacy_persisted_proposal_without_zone_defaults_to_zone_a(tmp_path: Any) -> None:
    state_path = tmp_path / "legacy-zone-proposal-state.json"
    context = RequestContext(
        farm_id="farm-wasabi-a",
        actor_id="operator-01",
        actor_role=ActorRole.OPERATOR,
        correlation_id="legacy-zone-proposal",
    )
    service = FarmOperationsService(FakeTelemetry(), state_path=state_path)
    proposal = service.propose_control(
        context,
        ControlProposalCreate(
            action="set_cooling_enabled",
            target_value=True,
            rationale="구버전 제안 저장 형식을 검증합니다.",
        ),
    )
    persisted = json.loads(state_path.read_text(encoding="utf-8"))
    persisted["version"] = 2
    persisted["proposals"][0].pop("zone_id")
    state_path.write_text(json.dumps(persisted, ensure_ascii=False), encoding="utf-8")

    restored = FarmOperationsService(FakeTelemetry(), state_path=state_path)

    assert restored.get_proposal(context, proposal.proposal_id).zone_id == "zone-a"


def test_response_loss_replays_ledger_command_and_restart_keeps_same_execution(tmp_path: Any) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    telemetry = LedgerTelemetry(lose_first_response=True)
    client = TestClient(create_app(telemetry, state_path=str(state_path)))
    correlation_id = "response-loss-control-001"
    created = client.post(
        "/v1/control/proposals",
        headers={
            **headers(actor_id="proposal-author"),
            "X-Correlation-Id": correlation_id,
        },
        json={
            "action": "set_cooling_enabled",
            "target_value": True,
            "rationale": "응답 손실 뒤 동일 실행으로 수렴해야 합니다.",
        },
    ).json()

    approved = client.post(
        f"/v1/control/proposals/{created['proposal_id']}/approve",
        headers={
            **headers(actor_id="approving-operator"),
            "X-Correlation-Id": "approval-request-correlation",
        },
    )
    repeated = client.post(
        f"/v1/control/proposals/{created['proposal_id']}/approve",
        headers=headers(actor_id="repeating-admin", role="admin"),
    )

    assert approved.status_code == 200
    assert approved.json()["status"] == "approved"
    assert approved.json()["execution_id"] == f"sim-{created['proposal_id']}"
    assert repeated.status_code == 200
    assert repeated.json() == approved.json()
    assert telemetry.calls == 2
    assert telemetry.effects == 1

    restarted = TestClient(create_app(telemetry, state_path=str(state_path)))
    after_restart = restarted.post(
        f"/v1/control/proposals/{created['proposal_id']}/approve",
        headers=headers(actor_id="post-restart-admin", role="admin"),
    )
    audit = restarted.get("/v1/audit/events", headers=headers(role="viewer")).json()

    assert after_restart.json() == approved.json()
    assert telemetry.calls == 2
    completion = [event for event in audit if event["action"] == "control.approved_and_simulated"]
    assert len(completion) == 1
    assert completion[0]["farm_id"] == "farm-wasabi-a"
    assert completion[0]["actor_id"] == "approving-operator"
    assert completion[0]["correlation_id"] == correlation_id


def test_concurrent_approvals_share_one_telemetry_effect_and_audit_event() -> None:
    telemetry = LedgerTelemetry()
    service = FarmOperationsService(telemetry)
    proposal_context = RequestContext(
        farm_id="farm-wasabi-a",
        actor_id="proposal-author",
        actor_role=ActorRole.OPERATOR,
        correlation_id="concurrent-approval-001",
    )
    proposal = service.propose_control(
        proposal_context,
        ControlProposalCreate(
            action="set_heating_enabled",
            target_value=True,
            rationale="동시 승인 요청의 단일 효과를 검증합니다.",
        ),
    )
    first_context = proposal_context.model_copy(update={"actor_id": "operator-01"})
    second_context = proposal_context.model_copy(update={"actor_id": "admin-01", "actor_role": ActorRole.ADMIN})

    async def approve_concurrently() -> tuple[Any, Any]:
        first, second = await asyncio.gather(
            service.approve_control(first_context, proposal.proposal_id),
            service.approve_control(second_context, proposal.proposal_id),
        )
        return first, second

    first, second = asyncio.run(approve_concurrently())
    audit = service.audit_events(proposal_context)

    assert first.execution_id == second.execution_id == f"sim-{proposal.proposal_id}"
    assert first.approved_by == second.approved_by == "operator-01"
    assert telemetry.calls == 2
    assert telemetry.effects == 1
    completion = [event for event in audit if event.action == "control.approved_and_simulated"]
    assert len(completion) == 1
    assert completion[0].actor_id == "operator-01"


def test_conflicting_telemetry_ledger_payload_is_rejected_idempotently() -> None:
    telemetry = ConflictingLedgerTelemetry()
    client = TestClient(create_app(telemetry))
    created = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
        json={
            "action": "set_cooling_enabled",
            "target_value": True,
            "rationale": "원장의 다른 payload와 충돌해야 합니다.",
        },
    ).json()

    conflicted = client.post(
        f"/v1/control/proposals/{created['proposal_id']}/approve",
        headers=headers(actor_id="operator-01"),
    )
    repeated = client.post(
        f"/v1/control/proposals/{created['proposal_id']}/approve",
        headers=headers(actor_id="admin-01", role="admin"),
    )
    stored = client.get(
        f"/v1/control/proposals/{created['proposal_id']}",
        headers=headers(role="viewer"),
    )

    assert conflicted.status_code == 409
    assert repeated.status_code == 409
    assert "different control payload" in conflicted.json()["detail"]
    assert stored.json()["status"] == "failed"
    assert stored.json()["execution"] is None
    assert telemetry.calls == 1


def test_failed_atomic_create_leaves_no_proposal_or_audit_after_restart(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    service = FarmOperationsService(FakeTelemetry(), state_path=state_path)
    context = RequestContext(
        farm_id="farm-wasabi-a",
        actor_id="operator-01",
        actor_role=ActorRole.OPERATOR,
        correlation_id="atomic-create-001",
    )

    def fail_persist() -> None:
        raise OSError("injected crash before state replacement")

    monkeypatch.setattr(service, "_persist_state_locked", fail_persist)

    with pytest.raises(OSError, match="injected crash"):
        service.propose_control(
            context,
            ControlProposalCreate(
                action="set_cooling_enabled",
                target_value=True,
                rationale="제안과 감사 이벤트가 함께 저장되어야 합니다.",
            ),
        )

    assert service.list_proposals(context) == []
    assert service.audit_events(context) == []
    restarted = FarmOperationsService(FakeTelemetry(), state_path=state_path)
    assert restarted.list_proposals(context) == []
    assert restarted.audit_events(context) == []


def test_completion_commit_failure_replays_one_effect_and_one_audit_after_restart(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    telemetry = LedgerTelemetry()
    service = FarmOperationsService(telemetry, state_path=state_path)
    context = RequestContext(
        farm_id="farm-wasabi-a",
        actor_id="operator-01",
        actor_role=ActorRole.OPERATOR,
        correlation_id="atomic-completion-001",
    )
    proposal = service.propose_control(
        context,
        ControlProposalCreate(
            action="set_heating_enabled",
            target_value=True,
            rationale="완료 저장 실패 뒤 재시작 복구를 검증합니다.",
        ),
    )
    original_persist = service._persist_state_locked
    writes = 0

    def fail_completion_persist() -> None:
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("injected crash before completion replacement")
        original_persist()

    monkeypatch.setattr(service, "_persist_state_locked", fail_completion_persist)

    with pytest.raises(OSError, match="injected crash"):
        asyncio.run(service.approve_control(context, proposal.proposal_id))

    assert telemetry.effects == 1
    assert service.get_proposal(context, proposal.proposal_id).execution is None
    assert not any(
        event.action == "control.approved_and_simulated"
        for event in service.audit_events(context)
    )

    restarted = FarmOperationsService(telemetry, state_path=state_path)
    recovered = asyncio.run(restarted.approve_control(context, proposal.proposal_id))
    completion_events = [
        event
        for event in restarted.audit_events(context)
        if event.action == "control.approved_and_simulated"
    ]

    assert recovered.execution_id == f"sim-{proposal.proposal_id}"
    assert telemetry.effects == 1
    assert len(completion_events) == 1

    restarted_again = FarmOperationsService(telemetry, state_path=state_path)
    calls_before_replay = telemetry.calls
    replayed = asyncio.run(restarted_again.approve_control(context, proposal.proposal_id))
    completion_events = [
        event
        for event in restarted_again.audit_events(context)
        if event.action == "control.approved_and_simulated"
    ]
    assert replayed == recovered
    assert telemetry.calls == calls_before_replay
    assert len(completion_events) == 1


def test_initial_approval_commit_failure_keeps_memory_and_restart_pending(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    telemetry = LedgerTelemetry()
    service = FarmOperationsService(telemetry, state_path=state_path)
    context = RequestContext(
        farm_id="farm-wasabi-a",
        actor_id="operator-01",
        actor_role=ActorRole.OPERATOR,
        correlation_id="atomic-initial-approval-001",
    )
    proposal = service.propose_control(
        context,
        ControlProposalCreate(
            action="set_heating_enabled",
            target_value=True,
            rationale="최초 승인 저장 실패가 pending 상태를 보존해야 합니다.",
        ),
    )

    def fail_persist() -> None:
        raise OSError("injected crash before initial approval replacement")

    monkeypatch.setattr(service, "_persist_state_locked", fail_persist)
    with pytest.raises(OSError, match="injected crash"):
        asyncio.run(service.approve_control(context, proposal.proposal_id))

    assert service.get_proposal(context, proposal.proposal_id).status.value == "pending"
    assert telemetry.calls == 0
    assert telemetry.effects == 0

    restarted = FarmOperationsService(telemetry, state_path=state_path)
    restored = restarted.get_proposal(context, proposal.proposal_id)
    assert restored.status.value == "pending"
    assert restored.approved_by is None
    assert restored.approved_at is None
    assert telemetry.calls == 0


def test_completed_replay_repairs_legacy_missing_audit_without_reexecution(tmp_path: Any) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    telemetry = LedgerTelemetry()
    service = FarmOperationsService(telemetry, state_path=state_path)
    context = RequestContext(
        farm_id="farm-wasabi-a",
        actor_id="operator-01",
        actor_role=ActorRole.OPERATOR,
        correlation_id="legacy-completion-gap-001",
    )
    proposal = service.propose_control(
        context,
        ControlProposalCreate(
            action="set_cooling_enabled",
            target_value=True,
            rationale="이전 분리 저장에서 누락된 감사를 복구합니다.",
        ),
    )
    completed = asyncio.run(service.approve_control(context, proposal.proposal_id))
    payload = json.loads(state_path.read_text(encoding="utf-8"))
    payload["audit_events"] = [
        event
        for event in payload["audit_events"]
        if event["action"] != "control.approved_and_simulated"
    ]
    state_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    restarted = FarmOperationsService(telemetry, state_path=state_path)
    calls_before_replay = telemetry.calls
    replayed = asyncio.run(restarted.approve_control(context, proposal.proposal_id))
    completion_events = [
        event
        for event in restarted.audit_events(context)
        if event.action == "control.approved_and_simulated"
    ]

    assert replayed == completed
    assert telemetry.calls == calls_before_replay
    assert len(completion_events) == 1
    assert completion_events[0].actor_id == "operator-01"
    assert completion_events[0].correlation_id == "legacy-completion-gap-001"


def test_rejection_and_reset_commit_failures_roll_back_across_restart(
    tmp_path: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    context = RequestContext(
        farm_id="farm-wasabi-a",
        actor_id="operator-01",
        actor_role=ActorRole.OPERATOR,
        correlation_id="atomic-rejection-001",
    )
    service = FarmOperationsService(FakeTelemetry(), state_path=state_path)
    rejected_candidate = service.propose_control(
        context,
        ControlProposalCreate(
            action="set_heating_enabled",
            target_value=True,
            rationale="거절 저장 실패를 검증합니다.",
        ),
    )

    def fail_persist() -> None:
        raise OSError("injected transition crash")

    monkeypatch.setattr(service, "_persist_state_locked", fail_persist)
    with pytest.raises(OSError, match="injected transition crash"):
        service.reject_control(context, rejected_candidate.proposal_id, "지금은 불필요합니다.")

    restarted = FarmOperationsService(FakeTelemetry(), state_path=state_path)
    assert restarted.get_proposal(context, rejected_candidate.proposal_id).status.value == "pending"
    assert not any(event.action == "control.rejected" for event in restarted.audit_events(context))

    rejected = restarted.reject_control(context, rejected_candidate.proposal_id, "지금은 불필요합니다.")
    pending_context = context.model_copy(update={"correlation_id": "atomic-reset-001"})
    pending = restarted.propose_control(
        pending_context,
        ControlProposalCreate(
            action="set_cooling_enabled",
            target_value=True,
            rationale="초기화 저장 실패를 검증합니다.",
        ),
    )
    monkeypatch.setattr(restarted, "_persist_state_locked", fail_persist)
    with pytest.raises(OSError, match="injected transition crash"):
        restarted.reset_demo_state(context)

    restarted_again = FarmOperationsService(FakeTelemetry(), state_path=state_path)
    restored = {item.proposal_id: item for item in restarted_again.list_proposals(context)}
    assert restored[rejected.proposal_id].status.value == "rejected"
    assert restored[pending.proposal_id].status.value == "pending"
    assert not any(event.action == "demo.state_reset" for event in restarted_again.audit_events(context))

    assert restarted_again.reset_demo_state(context) == 1
    final = FarmOperationsService(FakeTelemetry(), state_path=state_path)
    assert [item.proposal_id for item in final.list_proposals(context)] == [rejected.proposal_id]
    assert len([event for event in final.audit_events(context) if event.action == "control.rejected"]) == 1
    assert len([event for event in final.audit_events(context) if event.action == "demo.state_reset"]) == 1


def test_durable_audit_log_is_farm_scoped_and_retention_bounded(tmp_path: Any) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    client = TestClient(
        create_app(FakeTelemetry(), state_path=str(state_path), audit_retention=3)
    )
    for index in range(4):
        response = client.get(
            "/v1/farm/snapshot",
            headers={
                **headers(actor_id=f"operator-{index}"),
                "X-Correlation-Id": f"audit-correlation-{index}",
            },
        )
        assert response.status_code == 200

    restarted = TestClient(
        create_app(FakeTelemetry(), state_path=str(state_path), audit_retention=3)
    )
    own_farm = restarted.get("/v1/audit/events", headers=headers(role="viewer"))
    other_farm = restarted.get(
        "/v1/audit/events",
        headers=headers(farm_id="farm-tomato-b", role="viewer"),
    )

    assert own_farm.status_code == 200
    assert [event["actor_id"] for event in own_farm.json()] == [
        "operator-3",
        "operator-2",
        "operator-1",
    ]
    assert [event["correlation_id"] for event in own_farm.json()] == [
        "audit-correlation-3",
        "audit-correlation-2",
        "audit-correlation-1",
    ]
    assert all(event["farm_id"] == "farm-wasabi-a" for event in own_farm.json())
    assert other_farm.json() == []


def test_advisor_provenance_survives_create_list_approval_and_audit() -> None:
    client = TestClient(create_app(FakeTelemetry()))
    provenance = {
        "origin": "verified_telemetry_rule",
        "advisor_run_id": "advisor-run-20260720-01",
        "evidence_ids": ["chunk-wasabi-001", "sensor-root-temp-001"],
        "alert_id": "alert-root-zone-high-001",
        "alert_occurrence_id": "alert-occurrence-root-zone-high-001",
    }
    created = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
        json={
            "action": "set_cooling_enabled",
            "target_value": True,
            "rationale": "검증된 근권 고온 경보와 지식 근거에 따른 냉각 가동 제안",
            **provenance,
        },
    )
    proposal_id = created.json()["proposal_id"]
    listed = client.get("/v1/control/proposals", headers=headers(actor_id="operator-01"))
    approved = client.post(
        f"/v1/control/proposals/{proposal_id}/approve",
        headers=headers(actor_id="operator-01"),
    )
    audit = client.get("/v1/audit/events", headers=headers(actor_id="operator-01"))

    assert created.status_code == 200
    assert listed.status_code == 200
    assert approved.status_code == 200
    assert {field: created.json()[field] for field in provenance} == provenance
    listed_proposal = next(item for item in listed.json() if item["proposal_id"] == proposal_id)
    assert {field: listed_proposal[field] for field in provenance} == provenance
    assert {field: approved.json()[field] for field in provenance} == provenance
    relevant_events = [
        event
        for event in audit.json()
        if event["detail"].get("proposal_id") == proposal_id
    ]
    assert {event["action"] for event in relevant_events} == {
        "control.proposed",
        "control.approved_and_simulated",
    }
    assert all(
        {field: event["detail"][field] for field in provenance} == provenance
        for event in relevant_events
    )
    assert "evidence_text" not in created.text
    assert "evidence_text" not in audit.text


def test_rejection_closes_the_authoritative_mcp_proposal_without_execution() -> None:
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry))
    proposal = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
        json={
            "action": "set_thermal_curtain_percent",
            "target_value": 100,
            "rationale": "야간 저온 위험 전 커튼 제안을 보류합니다.",
        },
    ).json()

    rejected = client.post(
        f"/v1/control/proposals/{proposal['proposal_id']}/reject",
        headers=headers(actor_id="admin-01", role="admin"),
        json={"reason": "현장 확인 후 시뮬레이션이 불필요합니다."},
    )
    approval = client.post(
        f"/v1/control/proposals/{proposal['proposal_id']}/approve",
        headers=headers(actor_id="admin-01", role="admin"),
    )

    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert rejected.json()["rejected_by"] == "admin-01"
    assert rejected.json()["execution"] is None
    assert approval.status_code == 409
    assert telemetry.executed == []


def test_demo_reset_clears_pending_proposals_and_preserves_completed_history() -> None:
    telemetry = FakeTelemetry()
    client = TestClient(create_app(telemetry))

    def create_proposal(rationale: str) -> dict[str, Any]:
        return client.post(
            "/v1/control/proposals",
            headers=headers(actor_id="operator-01"),
            json={
                "action": "set_cooling_enabled",
                "target_value": True,
                "rationale": rationale,
            },
        ).json()

    approved = create_proposal("완료 이력으로 보존할 승인 제안입니다.")
    client.post(
        f"/v1/control/proposals/{approved['proposal_id']}/approve",
        headers=headers(actor_id="operator-01"),
    )
    rejected = create_proposal("완료 이력으로 보존할 거절 제안입니다.")
    client.post(
        f"/v1/control/proposals/{rejected['proposal_id']}/reject",
        headers=headers(actor_id="operator-01"),
        json={"reason": "현장 판단으로 실행하지 않습니다."},
    )

    async def unconfirmed_execution(_proposal: Any) -> dict[str, Any]:
        return {"execution_id": "unconfirmed", "simulated_only": False}

    telemetry.execute_simulated_control = unconfirmed_execution
    failed = create_proposal("완료 이력으로 보존할 실패 제안입니다.")
    client.post(
        f"/v1/control/proposals/{failed['proposal_id']}/approve",
        headers=headers(actor_id="operator-01"),
    )
    pending = create_proposal("반복 시연 전에 제거할 승인 대기 제안입니다.")
    assert pending["status"] == "pending"

    reset = client.post(
        "/v1/internal/demo-reset",
        headers=headers(actor_id="operator-01"),
    )
    remaining = client.get("/v1/control/proposals", headers=headers(actor_id="operator-01"))

    assert reset.status_code == 200
    assert reset.json() == {"farm_id": "farm-wasabi-a", "reset_proposals": 1, "simulated_only": True}
    assert {item["status"] for item in remaining.json()} == {"approved", "rejected", "failed"}
    assert {item["proposal_id"] for item in remaining.json()} == {
        approved["proposal_id"],
        rejected["proposal_id"],
        failed["proposal_id"],
    }


def test_proposal_history_survives_restart_and_pending_reset(tmp_path: Any) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    telemetry = FakeTelemetry()
    first_client = TestClient(create_app(telemetry, state_path=str(state_path)))

    def create_proposal(rationale: str) -> dict[str, Any]:
        return first_client.post(
            "/v1/control/proposals",
            headers=headers(actor_id="operator-01"),
            json={
                "action": "set_cooling_enabled",
                "target_value": True,
                "rationale": rationale,
            },
        ).json()

    approved = create_proposal("재시작 후에도 보존할 승인 이력입니다.")
    approved = first_client.post(
        f"/v1/control/proposals/{approved['proposal_id']}/approve",
        headers=headers(actor_id="operator-01"),
    ).json()
    rejected = create_proposal("재시작 후에도 보존할 거절 이력입니다.")
    rejected = first_client.post(
        f"/v1/control/proposals/{rejected['proposal_id']}/reject",
        headers=headers(actor_id="operator-01"),
        json={"reason": "현장 판단으로 실행하지 않습니다."},
    ).json()

    async def unconfirmed_execution(_proposal: Any) -> dict[str, Any]:
        return {"execution_id": "unconfirmed", "simulated_only": False}

    telemetry.execute_simulated_control = unconfirmed_execution
    failed = create_proposal("재시작 후에도 보존할 실패 이력입니다.")
    failed = first_client.post(
        f"/v1/control/proposals/{failed['proposal_id']}/approve",
        headers=headers(actor_id="operator-01"),
    ).json()
    pending = create_proposal("초기화 시 제거할 승인 대기 요청입니다.")

    restarted_client = TestClient(create_app(FakeTelemetry(), state_path=str(state_path)))
    restored = restarted_client.get(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
    ).json()
    restored_by_id = {item["proposal_id"]: item for item in restored}

    assert set(restored_by_id) == {
        approved["proposal_id"],
        rejected["proposal_id"],
        failed["proposal_id"],
        pending["proposal_id"],
    }
    assert restored_by_id[approved["proposal_id"]]["execution"] == approved["execution"]
    assert restored_by_id[rejected["proposal_id"]]["rejection_reason"] == rejected["rejection_reason"]
    assert restored_by_id[failed["proposal_id"]]["failure_reason"] == failed["failure_reason"]

    reset = restarted_client.post(
        "/v1/internal/demo-reset",
        headers=headers(actor_id="operator-01"),
    )
    after_second_restart = TestClient(create_app(FakeTelemetry(), state_path=str(state_path))).get(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
    ).json()

    assert reset.json()["reset_proposals"] == 1
    assert {item["proposal_id"] for item in after_second_restart} == {
        approved["proposal_id"],
        rejected["proposal_id"],
        failed["proposal_id"],
    }


def test_single_proposal_read_preserves_the_product_control_contract() -> None:
    client = TestClient(create_app(FakeTelemetry()))
    created = client.post(
        "/v1/control/proposals",
        headers=headers(actor_id="operator-01"),
        json={
            "action": "set_heating_enabled",
            "target_value": True,
            "rationale": "저온 경보에 대한 난방 시뮬레이터 제안",
            "requested_action": "set_actuator_state",
            "requested_target": "heater",
        },
    ).json()

    fetched = client.get(
        f"/v1/control/proposals/{created['proposal_id']}",
        headers=headers(actor_id="viewer-01", role="viewer"),
    )

    assert fetched.status_code == 200
    assert fetched.json()["proposal_id"] == created["proposal_id"]
    assert fetched.json()["requested_action"] == "set_actuator_state"
    assert fetched.json()["requested_target"] == "heater"


def test_viewer_cannot_propose_and_context_is_required() -> None:
    client = TestClient(create_app(FakeTelemetry()))
    request = {
        "action": "set_cooling_enabled",
        "target_value": True,
        "rationale": "근권 온도 상승 대응 냉각기 가동 제안",
    }

    missing_context = client.post("/v1/control/proposals", json=request)
    viewer = client.post("/v1/control/proposals", headers=headers(role="viewer"), json=request)

    assert missing_context.status_code == 401
    assert viewer.status_code == 403


def test_internal_token_is_required_before_context_is_trusted() -> None:
    client = TestClient(create_app(FakeTelemetry()))
    trusted_headers = headers()
    missing_token = {key: value for key, value in trusted_headers.items() if key != "X-Internal-Service-Token"}
    invalid_token = {**trusted_headers, "X-Internal-Service-Token": "not-the-service-token"}

    missing = client.post("/mcp", headers=missing_token, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    invalid = client.post("/mcp", headers=invalid_token, json={"jsonrpc": "2.0", "id": 2, "method": "tools/list"})

    assert missing.status_code == 401
    assert invalid.status_code == 401


def test_uncertain_scope_blocks_other_clients_but_not_independent_devices():
    telemetry=FakeTelemetry(); client=TestClient(create_app(telemetry))
    original=telemetry.execute_simulated_control
    async def unknown(proposal): return {"execution_id":"unknown", "simulated_only":False}
    telemetry.execute_simulated_control=unknown
    def create(action,value):
        response=client.post("/v1/control/proposals",headers=headers(actor_id="another-device"),json={"action":action,"target_value":value,"rationale":"Independent client scope verification"})
        assert response.status_code==200
        return response.json()["proposal_id"]
    def approve(identity):return client.post(f"/v1/control/proposals/{identity}/approve",headers=headers(actor_id="another-operator"))
    first=create("set_cooling_enabled",True);approve(first)
    telemetry.execute_simulated_control=original
    assert approve(create("set_cooling_enabled",False)).status_code==409
    assert approve(create("set_heating_enabled",True)).status_code==409
    assert approve(create("set_circulation_fan_percent",80)).status_code==200
