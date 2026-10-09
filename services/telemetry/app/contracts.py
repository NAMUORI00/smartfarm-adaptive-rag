from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class SensorMetric(StrEnum):
    AIR_TEMPERATURE = "air_temperature_c"
    RELATIVE_HUMIDITY = "relative_humidity_pct"
    ROOT_ZONE_TEMPERATURE = "root_zone_temperature_c"
    SUPPLY_EC = "supply_ec_ds_m"
    DRAIN_EC = "drain_ec_ds_m"
    SUPPLY_PH = "supply_ph"
    DRAIN_PH = "drain_ph"
    SUBSTRATE_MOISTURE = "substrate_moisture_pct"
    IRRIGATION_FLOW = "irrigation_flow_l_min"
    IRRIGATION_PRESSURE = "irrigation_pressure_bar"
    TANK_LEVEL = "tank_level_pct"
    PPFD = "ppfd_umol_m2_s"
    CO2 = "co2_ppm"
    PUMP_CURRENT = "pump_current_a"

    # Compatibility metrics used by the existing Product API and chart routes.
    SOLAR_RADIATION = "solar_radiation_w_m2"
    SUBSTRATE_EC = "substrate_ec_ms_cm"
    NUTRIENT_PH = "nutrient_ph"
    SUBSTRATE_TEMPERATURE = "substrate_temperature_c"
    OUTSIDE_WIND_SPEED = "outside_wind_speed_m_s"
    RAIN_DETECTED = "rain_detected"


METRIC_UNITS: dict[SensorMetric, str] = {
    SensorMetric.AIR_TEMPERATURE: "°C",
    SensorMetric.RELATIVE_HUMIDITY: "%",
    SensorMetric.ROOT_ZONE_TEMPERATURE: "°C",
    SensorMetric.SUPPLY_EC: "dS/m",
    SensorMetric.DRAIN_EC: "dS/m",
    SensorMetric.SUPPLY_PH: "pH",
    SensorMetric.DRAIN_PH: "pH",
    SensorMetric.SUBSTRATE_MOISTURE: "%",
    SensorMetric.IRRIGATION_FLOW: "L/min",
    SensorMetric.IRRIGATION_PRESSURE: "bar",
    SensorMetric.TANK_LEVEL: "%",
    SensorMetric.PPFD: "µmol/m²/s",
    SensorMetric.CO2: "ppm",
    SensorMetric.PUMP_CURRENT: "A",
    SensorMetric.SOLAR_RADIATION: "W/m²",
    SensorMetric.SUBSTRATE_EC: "mS/cm",
    SensorMetric.NUTRIENT_PH: "pH",
    SensorMetric.SUBSTRATE_TEMPERATURE: "°C",
    SensorMetric.OUTSIDE_WIND_SPEED: "m/s",
    SensorMetric.RAIN_DETECTED: "boolean",
}


class AlertSeverity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class AlertStatus(StrEnum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"


class SensorQuality(StrEnum):
    GOOD = "good"
    SUSPECT = "suspect"
    BAD = "bad"
    STALE = "stale"
    MISSING = "missing"


class ActuatorMode(StrEnum):
    SCHEDULED = "scheduled"
    MANUAL = "manual"
    ASSISTED = "assisted"
    OFF = "off"


class ActuatorHealth(StrEnum):
    NORMAL = "normal"
    DEGRADED = "degraded"
    FAULT = "fault"
    OFFLINE = "offline"


class IncidentStatus(StrEnum):
    OPEN = "open"
    ACKNOWLEDGED = "acknowledged"
    RECOVERING = "recovering"
    RESOLVED = "resolved"


class DemoScenarioId(StrEnum):
    """Named, deterministic conditions available in the local demo simulator."""

    NORMAL = "normal"
    ROOT_COOLING_FAULT = "root_cooling_fault"
    IRRIGATION_BLOCKAGE = "irrigation_blockage"
    HIGH_HUMIDITY_STAGNATION = "high_humidity_stagnation"
    EC_DRIFT = "ec_drift"
    TEMPERATURE_SENSOR_DRIFT = "temperature_sensor_drift"
    TANK_LOW = "tank_low"
    VENTILATION_STUCK = "ventilation_stuck"
    SENSOR_DROPOUT = "sensor_dropout"
    PUMP_FLOW_MISMATCH = "pump_flow_mismatch"

    # Accepted for older local clients; omitted from the current scenario list.
    HIGH_TEMPERATURE = "high_temperature"
    EC_RISE = "ec_rise"
    MOISTURE_LOW = "moisture_low"
    TEMPERATURE_SENSOR_FAULT = "temperature_sensor_fault"


class DemoScenarioPhase(StrEnum):
    """Time-based phase of the active deterministic demo scenario."""

    NORMAL = "normal"
    RAMP = "ramp"
    HOLD = "hold"
    RECOVERY = "recovery"
    RECOVERED = "recovered"


class ControlAction(StrEnum):
    SET_ROOF_VENT_OPEN_PERCENT = "set_roof_vent_open_percent"
    SET_SIDE_VENT_OPEN_PERCENT = "set_side_vent_open_percent"
    SET_THERMAL_CURTAIN_PERCENT = "set_thermal_curtain_percent"
    SET_CIRCULATION_FAN_PERCENT = "set_circulation_fan_percent"
    START_IRRIGATION_CYCLE = "start_irrigation_cycle"
    SET_HEATING_ENABLED = "set_heating_enabled"
    SET_COOLING_ENABLED = "set_cooling_enabled"
    RECALIBRATE_AIR_TEMPERATURE_SENSOR = "recalibrate_air_temperature_sensor"


class FarmInfo(BaseModel):
    farm_id: str
    name_ko: str
    crop: str = "고추냉이"
    greenhouse_type: str = "펄라이트 2단 고설베드 시설온실"
    production_goal: str = "잎·잎자루"
    cultivation_profile: str = "perlite_leaf_kr_v1"
    simulated_only: bool = True


class SensorReading(BaseModel):
    expected_interval_seconds: int = Field(default=60, ge=1, le=86400)
    metric: SensorMetric
    value: float = Field(allow_inf_nan=False)
    unit: str
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    sensor_id: str | None = Field(default=None, min_length=1, max_length=128)
    quality: SensorQuality = SensorQuality.GOOD
    source: str | None = Field(default=None, min_length=1, max_length=128)
    observed_at: datetime | None = None


class ActuatorState(BaseModel):
    roof_vent_open_pct: float = Field(ge=0, le=100)
    side_vent_open_pct: float = Field(ge=0, le=100)
    thermal_curtain_pct: float = Field(ge=0, le=100)
    circulation_fan_pct: float = Field(ge=0, le=100)
    irrigation_active: bool
    heating_enabled: bool
    cooling_enabled: bool


class ActuatorTwinState(BaseModel):
    device_id: str
    instance_id: str
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    desired_value: float | bool
    reported_value: float | bool
    effective_value: float | bool
    unit: str
    mode: ActuatorMode = ActuatorMode.SCHEDULED
    health: ActuatorHealth = ActuatorHealth.NORMAL
    command_id: str | None = None
    commanded_at: datetime | None = None
    reported_at: datetime
    effective_at: datetime
    source: str = "deterministic-simulator"
    simulated_only: bool = True

    @model_validator(mode="before")
    @classmethod
    def default_legacy_instance_id(cls, value: object) -> object:
        if isinstance(value, dict) and not value.get("instance_id") and value.get("device_id"):
            zone_id = value.get("zone_id") or "zone-a"
            return {**value, "instance_id": f"{zone_id}:{value['device_id']}"}
        return value


class DerivedIndicators(BaseModel):
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    vpd_kpa: float = Field(ge=0)
    dli_mol_m2_day: float = Field(ge=0)
    ec_delta_ds_m: float
    root_heat_exposure_degree_minutes: float = Field(ge=0)
    source: str = "physics-lite-derived"
    simulated_only: bool = True


class VirtualClockState(BaseModel):
    farm_id: str = Field(default="farm-wasabi-a", min_length=1, max_length=128)
    speed: Literal[1, 5, 10] = 1
    paused: bool = False
    wall_anchor: datetime
    virtual_anchor: datetime
    seed: int = Field(default=1024, ge=0, le=2_147_483_647)
    revision: int = Field(default=0, ge=0)


class VirtualClockUpdateRequest(BaseModel):
    farm_id: str = Field(min_length=1, max_length=128)
    speed: Literal[1, 5, 10] | None = None
    paused: bool | None = None
    reset_to: datetime | None = None
    seed: int | None = Field(default=None, ge=0, le=2_147_483_647)


class IncidentRecord(BaseModel):
    incident_id: str
    alert_id: str
    occurrence_id: str
    farm_id: str
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    metric: SensorMetric
    severity: AlertSeverity
    status: IncidentStatus
    message_ko: str
    opened_at: datetime
    last_observed_at: datetime
    acknowledged_at: datetime | None = None
    recovering_at: datetime | None = None
    resolved_at: datetime | None = None
    simulated_only: bool = True


class TelemetryAlert(BaseModel):
    alert_id: str
    occurrence_id: str
    farm_id: str
    metric: SensorMetric
    severity: AlertSeverity
    status: AlertStatus = AlertStatus.OPEN
    message_ko: str
    observed_value: float
    threshold: float
    occurred_at: datetime
    alert_kind: str = "threshold"
    simulated_only: bool = True
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"


class FarmSnapshot(BaseModel):
    farm: FarmInfo
    sampled_at: datetime
    scenario_id: DemoScenarioId = DemoScenarioId.NORMAL
    scenario_applied_at: datetime | None = None
    scenario_phase: DemoScenarioPhase = DemoScenarioPhase.NORMAL
    scenario_elapsed_seconds: int = Field(default=0, ge=0)
    scenario_phase_started_at: datetime | None = None
    readings: list[SensorReading]
    actuator_state: ActuatorState
    alerts: list[TelemetryAlert]
    data_source: str = "deterministic-simulator"
    simulated_only: bool = True
    state_revision: int = Field(default=0, ge=0)
    ingress_metadata: TelemetryIngressMetadata | None = None
    active_scenario_ids: list[DemoScenarioId] = Field(default_factory=list, max_length=2)
    zones: list[Literal["zone-a", "zone-b"]] = Field(default_factory=lambda: ["zone-a"], max_length=2)
    device_twins: list[ActuatorTwinState] = Field(default_factory=list)
    derived_indicators: list[DerivedIndicators] = Field(default_factory=list)
    incidents: list[IncidentRecord] = Field(default_factory=list)
    clock: VirtualClockState | None = None


class TelemetryIngressMetadata(BaseModel):
    message_id: str | None = None
    sequence: int | None = None
    observed_at: datetime
    source: str
    metric_count: int = Field(ge=1)
    complete: bool
    mixed: bool
    read_only: bool = True
    zones: list[Literal["zone-a", "zone-b"]] = Field(default_factory=lambda: ["zone-a"], max_length=2)
    quality_counts: dict[str, int] = Field(default_factory=dict)


class GatewayStatus(BaseModel):
    farm_id: str
    state: Literal["not_connected", "ready", "degraded", "stale"]
    read_only: bool = True
    source: str | None = None
    observed_at: datetime | None = None
    age_seconds: int | None = Field(default=None, ge=0)
    message_id: str | None = None
    sequence: int | None = None
    metric_count: int = Field(default=0, ge=0)
    expected_metric_count: int = Field(default=0, ge=0)
    completeness_percent: float = Field(default=0, ge=0, le=100)
    missing_metrics: list[str] = Field(default_factory=list)
    quality_counts: dict[str, int] = Field(default_factory=dict)
    duplicate_sensor_metrics: int = Field(default=0, ge=0)
    unit_errors: int = Field(default=0, ge=0)
    rejected_message_count: int = Field(default=0, ge=0)
    rejection_counts: dict[str, int] = Field(default_factory=dict)
    last_rejection_at: datetime | None = None
    last_rejection_reason: str | None = None
    simulated_only: bool = True


class TelemetryIngressValidationResponse(BaseModel):
    valid: bool
    farm_id: str | None = None
    source: str | None = None
    message_id: str | None = None
    issues: list[str] = Field(default_factory=list)


class StrategyThreshold(BaseModel):
    metric: SensorMetric
    lower: float | None = Field(default=None, allow_inf_nan=False)
    upper: float | None = Field(default=None, allow_inf_nan=False)
    unit: str = Field(min_length=1, max_length=32)

    @model_validator(mode="after")
    def validate_range(self) -> "StrategyThreshold":
        if self.lower is None and self.upper is None:
            raise ValueError("at least one threshold bound is required")
        if self.lower is not None and self.upper is not None and self.lower >= self.upper:
            raise ValueError("lower must be less than upper")
        if self.unit != METRIC_UNITS[self.metric]:
            raise ValueError(
                f"{self.metric} requires canonical unit {METRIC_UNITS[self.metric]!r}"
            )
        return self


class CultivationStrategyRuntime(BaseModel):
    farm_id: str
    version_id: str
    growth_stage: str
    thresholds: list[StrategyThreshold]
    evidence_source_ids: list[str] = Field(default_factory=list)
    change_note: str
    applied_by: str
    applied_at: datetime


class CultivationStrategyUpdateRequest(BaseModel):
    farm_id: str = Field(min_length=1, max_length=128)
    version_id: str = Field(min_length=1, max_length=80)
    growth_stage: str = Field(min_length=1, max_length=80)
    thresholds: list[StrategyThreshold] = Field(min_length=1, max_length=30)
    evidence_source_ids: list[str] = Field(default_factory=list, max_length=30)
    change_note: str = Field(min_length=2, max_length=500)
    applied_by: str = Field(min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_metrics(self) -> "CultivationStrategyUpdateRequest":
        metrics = [item.metric for item in self.thresholds]
        if len(metrics) != len(set(metrics)):
            raise ValueError("strategy thresholds must use unique metrics")
        return self


class TelemetryIngressRequest(BaseModel):
    """Stable adapter contract for a future gateway, broker, or device collector.

    The local prototype only accepts this on an internal token-protected route;
    callers can mark their feed as simulated while integration work is ongoing.
    """

    farm_id: str = Field(min_length=1, max_length=128)
    sampled_at: datetime | None = None
    observed_at: datetime | None = None
    message_id: str | None = Field(default=None, min_length=1, max_length=128)
    sequence: int | None = Field(default=None, ge=0)
    readings: list[SensorReading] = Field(min_length=1, max_length=100)
    source: str = Field(default="telemetry-adapter", min_length=2, max_length=128)
    simulated_only: bool = True

    @model_validator(mode="after")
    def validate_ingress(self) -> "TelemetryIngressRequest":
        if self.sampled_at is None and self.observed_at is None:
            raise ValueError("observed_at or sampled_at is required")
        if (
            self.sampled_at is not None
            and self.observed_at is not None
            and self.sampled_at != self.observed_at
        ):
            raise ValueError("observed_at and sampled_at must match when both are supplied")
        timestamp = self.observed_at or self.sampled_at
        self.observed_at = timestamp
        self.sampled_at = timestamp
        identities = [
            (reading.zone_id, reading.sensor_id or reading.metric.value, reading.metric)
            for reading in self.readings
        ]
        if len(identities) != len(set(identities)):
            raise ValueError("readings must not contain duplicate sensor metrics")
        for reading in self.readings:
            if reading.unit != METRIC_UNITS[reading.metric]:
                raise ValueError(
                    f"{reading.metric} requires canonical unit {METRIC_UNITS[reading.metric]!r}"
                )
        return self

    @property
    def timestamp(self) -> datetime:
        assert self.observed_at is not None
        return self.observed_at


class TimeseriesPoint(BaseModel):
    timestamp: datetime
    value: float
    quality: SensorQuality = SensorQuality.GOOD
    source: str = "deterministic-simulator"
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    sensor_id: str | None = None
    simulated_only: bool = True


class TimeseriesResponse(BaseModel):
    farm_id: str
    scenario_id: DemoScenarioId = DemoScenarioId.NORMAL
    scenario_applied_at: datetime | None = None
    scenario_phase: DemoScenarioPhase = DemoScenarioPhase.NORMAL
    scenario_elapsed_seconds: int = Field(default=0, ge=0)
    scenario_phase_started_at: datetime | None = None
    metric: SensorMetric
    unit: str
    start: datetime
    end: datetime
    interval_minutes: int
    points: list[TimeseriesPoint]
    data_source: str = "deterministic-simulator"
    simulated_only: bool = True
    state_revision: int = Field(default=0, ge=0)
    ingress_metadata: TelemetryIngressMetadata | None = None
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    source_counts: dict[str, int] = Field(default_factory=dict)


class SimulatedControlCommand(BaseModel):
    proposal_id: str = Field(min_length=1, max_length=128)
    farm_id: str = Field(min_length=1, max_length=128)
    action: ControlAction
    target_value: float | bool
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    requested_by: str = Field(min_length=1, max_length=128)
    alert_id: str | None = Field(default=None, min_length=1, max_length=200)
    alert_occurrence_id: str | None = Field(default=None, min_length=1, max_length=128)
    correlation_id: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_alert_occurrence(self) -> "SimulatedControlCommand":
        if bool(self.alert_id) != bool(self.alert_occurrence_id):
            raise ValueError("alert_id and alert_occurrence_id must be supplied together")
        return self


class ControlExecution(BaseModel):
    execution_id: str
    proposal_id: str
    farm_id: str
    action: ControlAction
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    executed_at: datetime
    correlation_id: str
    actuator_state: ActuatorState
    simulated_only: bool = True
    state_revision: int = Field(default=0, ge=0)


class DemoScenarioDefinition(BaseModel):
    scenario_id: DemoScenarioId
    name_ko: str
    description_ko: str
    simulated_only: bool = True
    category: str = "environment"
    supported_zones: list[Literal["zone-a", "zone-b"]] = Field(default_factory=lambda: ["zone-a"])
    recovery_actions: list[ControlAction] = Field(default_factory=list)
    provenance_refs: list[str] = Field(default_factory=list)


class DemoScenarioActivationRequest(BaseModel):
    farm_id: str = Field(min_length=1, max_length=128)
    scenario_id: DemoScenarioId
    scenario_ids: list[DemoScenarioId] | None = Field(default=None, min_length=1, max_length=2)
    zone_ids: list[Literal["zone-a", "zone-b"]] = Field(default_factory=lambda: ["zone-a"], min_length=1, max_length=2)
    seed: int = Field(default=1024, ge=0, le=2_147_483_647)
    correlation_id: str = Field(default_factory=lambda: str(uuid.uuid4()), min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_scenarios(self) -> "DemoScenarioActivationRequest":
        scenario_ids = self.scenario_ids or [self.scenario_id]
        if self.scenario_id not in scenario_ids:
            raise ValueError("scenario_id must be included in scenario_ids")
        if DemoScenarioId.NORMAL in scenario_ids and len(scenario_ids) > 1:
            raise ValueError("normal cannot be combined with a fault scenario")
        if len(set(scenario_ids)) != len(scenario_ids):
            raise ValueError("scenario_ids must be unique")
        if len(set(self.zone_ids)) != len(self.zone_ids):
            raise ValueError("zone_ids must be unique")
        return self


class DemoScenarioState(BaseModel):
    farm_id: str
    scenario_id: DemoScenarioId
    applied_at: datetime | None = None
    correlation_id: str | None = None
    phase: DemoScenarioPhase = DemoScenarioPhase.NORMAL
    elapsed_seconds: int = Field(default=0, ge=0)
    phase_started_at: datetime | None = None
    simulated_only: bool = True
    state_revision: int = Field(default=0, ge=0)
    scenario_ids: list[DemoScenarioId] = Field(default_factory=list, max_length=2)
    zone_ids: list[Literal["zone-a", "zone-b"]] = Field(default_factory=lambda: ["zone-a"], max_length=2)
    seed: int = Field(default=1024, ge=0, le=2_147_483_647)


class TelemetryReplayRequest(BaseModel):
    farm_id: str = Field(min_length=1, max_length=128)
    observations: list[TelemetryIngressRequest] = Field(min_length=1, max_length=10_000)
    reset_clock_to_first_observation: bool = True

    @model_validator(mode="after")
    def validate_observation_farms(self) -> "TelemetryReplayRequest":
        if any(item.farm_id != self.farm_id for item in self.observations):
            raise ValueError("all replay observations must belong to farm_id")
        return self


class TelemetryReplayResponse(BaseModel):
    farm_id: str
    accepted_observations: int = Field(ge=0)
    first_observed_at: datetime
    last_observed_at: datetime
    state_revision: int = Field(ge=0)
    simulated_only: bool


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "telemetry"
    simulated_only: bool = True
