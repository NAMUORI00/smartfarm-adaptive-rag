from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class ActorRole(StrEnum):
    ADMIN = "admin"
    OPERATOR = "operator"
    VIEWER = "viewer"


class ControlAction(StrEnum):
    SET_ROOF_VENT_OPEN_PERCENT = "set_roof_vent_open_percent"
    SET_SIDE_VENT_OPEN_PERCENT = "set_side_vent_open_percent"
    SET_THERMAL_CURTAIN_PERCENT = "set_thermal_curtain_percent"
    SET_CIRCULATION_FAN_PERCENT = "set_circulation_fan_percent"
    START_IRRIGATION_CYCLE = "start_irrigation_cycle"
    SET_HEATING_ENABLED = "set_heating_enabled"
    SET_COOLING_ENABLED = "set_cooling_enabled"
    RECALIBRATE_AIR_TEMPERATURE_SENSOR = "recalibrate_air_temperature_sensor"


BOOLEAN_ACTIONS = {
    ControlAction.START_IRRIGATION_CYCLE,
    ControlAction.SET_HEATING_ENABLED,
    ControlAction.SET_COOLING_ENABLED,
}

PRODUCT_TARGET_BY_ACTION = {
    ControlAction.SET_ROOF_VENT_OPEN_PERCENT: "roof_vent",
    ControlAction.SET_SIDE_VENT_OPEN_PERCENT: "side_vent",
    ControlAction.SET_THERMAL_CURTAIN_PERCENT: "shade_curtain",
    ControlAction.SET_CIRCULATION_FAN_PERCENT: "ventilation_fan",
    ControlAction.START_IRRIGATION_CYCLE: "irrigation_pump",
    ControlAction.SET_HEATING_ENABLED: "heater",
    ControlAction.SET_COOLING_ENABLED: "root_zone_chiller",
    ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR: "air_temperature_sensor_reset",
}


class ProposalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    FAILED = "failed"


class RequestContext(BaseModel):
    """Trusted internal caller context, injected by the product API/proxy."""

    farm_id: str = Field(min_length=1, max_length=128)
    actor_id: str = Field(min_length=1, max_length=128)
    actor_role: ActorRole
    correlation_id: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=1, max_length=128)


class ControlProposalCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: ControlAction
    target_value: float | bool
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    rationale: str = Field(min_length=3, max_length=1_000)
    requested_action: Literal[
        "set_actuator_state",
        "recalibrate_air_temperature_sensor",
    ] = "set_actuator_state"
    requested_target: Literal[
        "ventilation_fan",
        "roof_vent",
        "side_vent",
        "irrigation_pump",
        "heater",
        "root_zone_chiller",
        "shade_curtain",
        "air_temperature_sensor_reset",
    ] | None = None
    origin: Literal["verified_telemetry_rule", "manual"] | None = None
    advisor_run_id: str | None = Field(default=None, min_length=1, max_length=128)
    evidence_ids: list[str] = Field(default_factory=list, max_length=20)
    alert_id: str | None = Field(default=None, min_length=1, max_length=200)
    alert_occurrence_id: str | None = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_target_value(self) -> "ControlProposalCreate":
        if self.action is ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR:
            if self.target_value is not True:
                raise ValueError(f"{self.action} requires target_value=true")
            if (
                self.requested_action != "recalibrate_air_temperature_sensor"
                or self.requested_target != "air_temperature_sensor_reset"
            ):
                raise ValueError(
                    "Sensor recalibration requires requested_action=recalibrate_air_temperature_sensor "
                    "and requested_target=air_temperature_sensor_reset"
                )
            if self.origin is not None and (
                self.origin != "verified_telemetry_rule"
                or not self.alert_id
                or not self.alert_id.lower().endswith(":air_temperature_c:sensor-health")
            ):
                raise ValueError("Sensor recalibration requires verified air-temperature sensor-health provenance")
        elif self.action in BOOLEAN_ACTIONS:
            if not isinstance(self.target_value, bool):
                raise ValueError(f"{self.action} requires a boolean target_value")
        else:
            if isinstance(self.target_value, bool) or not isinstance(self.target_value, (int, float)):
                raise ValueError(f"{self.action} requires a percentage target_value")
            if not 0 <= float(self.target_value) <= 100:
                raise ValueError("percentage target_value must be between 0 and 100")
        if self.action is not ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR:
            if self.requested_action != "set_actuator_state":
                raise ValueError("Actuator controls require requested_action=set_actuator_state")
            if self.requested_target == "air_temperature_sensor_reset":
                raise ValueError("air_temperature_sensor_reset is reserved for sensor recalibration")
        if self.requested_target is not None and self.requested_target != PRODUCT_TARGET_BY_ACTION[self.action]:
            raise ValueError(f"{self.action} does not match requested_target={self.requested_target}")
        if self.origin is None:
            if self.advisor_run_id or self.evidence_ids or self.alert_id or self.alert_occurrence_id:
                raise ValueError("Advisor provenance requires an origin")
        elif not self.advisor_run_id or not self.evidence_ids:
            raise ValueError("Advisor provenance requires advisor_run_id and evidence_ids")
        elif self.origin == "verified_telemetry_rule" and (not self.alert_id or not self.alert_occurrence_id):
            raise ValueError(
                "Advisor provenance requires advisor_run_id, evidence_ids, alert_id, and alert_occurrence_id"
            )
        elif self.origin == "manual" and (self.alert_id is not None or self.alert_occurrence_id is not None):
            raise ValueError("Manual advisor provenance cannot include alert fields")
        return self


class ControlProposalReject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str | None = Field(default=None, min_length=2, max_length=1_000)


class SimulatedExecution(BaseModel):
    """The only execution record this demo service may return."""

    execution_id: str
    executed_at: datetime | None = None
    actuator_state: dict[str, Any] | None = None
    device_command_status: dict[str, Any] | None = None
    correlation_id: str
    simulated_only: bool = True


class ControlProposal(BaseModel):
    proposal_id: str
    farm_id: str
    action: ControlAction
    target_value: float | bool
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    rationale: str
    requested_action: Literal[
        "set_actuator_state",
        "recalibrate_air_temperature_sensor",
    ] = "set_actuator_state"
    requested_target: str | None = None
    origin: Literal["verified_telemetry_rule", "manual"] | None = None
    advisor_run_id: str | None = None
    evidence_ids: list[str] = Field(default_factory=list)
    alert_id: str | None = None
    alert_occurrence_id: str | None = None
    proposed_by: str
    proposed_at: datetime
    status: ProposalStatus = ProposalStatus.PENDING
    approved_by: str | None = None
    approved_at: datetime | None = None
    rejected_by: str | None = None
    rejected_at: datetime | None = None
    rejection_reason: str | None = None
    execution_id: str | None = None
    failure_reason: str | None = None
    correlation_id: str
    execution: SimulatedExecution | None = None
    simulated_only: bool = True


class AuditEvent(BaseModel):
    event_id: str
    farm_id: str
    actor_id: str
    action: str
    occurred_at: datetime
    correlation_id: str
    detail: dict[str, Any] = Field(default_factory=dict)
    simulated_only: bool = True


class ToolCallRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)


class TimeseriesToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric: str = Field(min_length=1)
    start: datetime
    end: datetime
    interval_minutes: int = Field(default=10, ge=1, le=60)
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"

    @model_validator(mode="after")
    def validate_range(self) -> "TimeseriesToolArguments":
        if self.end <= self.start:
            raise ValueError("end must be after start")
        return self


class AlertToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["open", "acknowledged"] | None = None


class ApprovalToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: str = Field(min_length=1, max_length=128)


class RejectionToolArguments(ApprovalToolArguments):
    reason: str | None = Field(default=None, min_length=2, max_length=1_000)


class DeviceCapabilityToolArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    device_id: str | None = Field(default=None, min_length=1, max_length=128)


class ControlImpactPreviewArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: ControlAction
    target_value: float | bool
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"


class ExecutionTrackingArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal_id: str | None = Field(default=None, min_length=1, max_length=128)
    limit: int = Field(default=10, ge=1, le=50)


class JsonRpcRequest(BaseModel):
    jsonrpc: Literal["2.0"]
    id: str | int | None = None
    method: str = Field(min_length=1)
    params: dict[str, Any] = Field(default_factory=dict)
