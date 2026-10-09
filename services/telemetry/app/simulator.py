from __future__ import annotations

import json
import hashlib
import math
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock, RLock
from typing import Literal
from uuid import uuid4

from .contracts import (
    METRIC_UNITS,
    ActuatorHealth,
    ActuatorMode,
    ActuatorState,
    ActuatorTwinState,
    AlertSeverity,
    AlertStatus,
    ControlAction,
    ControlExecution,
    CultivationStrategyRuntime,
    CultivationStrategyUpdateRequest,
    DemoScenarioDefinition,
    DemoScenarioId,
    DemoScenarioPhase,
    DemoScenarioState,
    FarmInfo,
    FarmSnapshot,
    GatewayStatus,
    IncidentRecord,
    IncidentStatus,
    SensorMetric,
    SensorQuality,
    SensorReading,
    SimulatedControlCommand,
    TelemetryIngressRequest,
    TelemetryIngressMetadata,
    TelemetryReplayRequest,
    TelemetryReplayResponse,
    TelemetryAlert,
    TimeseriesPoint,
    TimeseriesResponse,
    VirtualClockState,
    VirtualClockUpdateRequest,
)
from .derived_metrics import derived_indicators
from .scenario_profiles import load_scenario_pack
from .state_store import SQLiteTelemetryStore
from .virtual_clock import VirtualClock


KST = timezone(timedelta(hours=9), name="KST")
SCENARIO_RAMP_SECONDS = 60
SCENARIO_RECOVERY_SECONDS = 90
IRRIGATION_CYCLE_SECONDS = 120

FARMS: dict[str, FarmInfo] = {
    "farm-wasabi-a": FarmInfo(
        farm_id="farm-wasabi-a",
        name_ko="고추냉이 고설베드 A동",
    ),
}

# Keep existing local integrations readable while the Product API migrates its
# farm context. These aliases are deliberately hidden from ``list_farms``.
LEGACY_FARMS: dict[str, FarmInfo] = {
    farm_id: FarmInfo(farm_id=farm_id, name_ko=f"고추냉이 고설베드 {building}동")
    for farm_id, building in (("farm-strawberry-a", "A"), ("farm-strawberry-b", "B"))
}


SCENARIO_DEFINITIONS: tuple[DemoScenarioDefinition, ...] = (
    DemoScenarioDefinition(
        scenario_id=DemoScenarioId.NORMAL,
        name_ko="정상 운영 상태",
        description_ko="장치와 센서가 기준 범위에서 연결된 상태입니다.",
    ),
    DemoScenarioDefinition(
        scenario_id=DemoScenarioId.ROOT_COOLING_FAULT,
        name_ko="냉각기 정지",
        description_ko="근권 냉각기가 멈춰 근권 온도가 상승한 상태입니다. 냉각기를 켜면 회복을 확인할 수 있습니다.",
    ),
    DemoScenarioDefinition(
        scenario_id=DemoScenarioId.IRRIGATION_BLOCKAGE,
        name_ko="관수 사이클 중단",
        description_ko="관수 펌프가 꺼져 유량·압력과 배지 수분이 낮아진 상태입니다. 관수 사이클을 시작하면 회복을 확인할 수 있습니다.",
    ),
    DemoScenarioDefinition(
        scenario_id=DemoScenarioId.HIGH_HUMIDITY_STAGNATION,
        name_ko="환기 설비 저출력",
        description_ko="천창·측창과 순환팬 출력이 낮아 습도와 공기가 정체된 상태입니다. 환기 출력을 높이면 회복을 확인할 수 있습니다.",
    ),
    DemoScenarioDefinition(
        scenario_id=DemoScenarioId.EC_DRIFT,
        name_ko="관수 부족·공급 편차",
        description_ko="관수가 부족하고 양액 공급 편차가 커져 공급·배액 EC가 상승한 상태입니다. 관수를 시작하면 회복을 확인할 수 있습니다.",
    ),
    DemoScenarioDefinition(
        scenario_id=DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
        name_ko="온도 센서 이상",
        description_ko="공기 온도 센서값이 근권 온도와 맞지 않게 이탈한 상태입니다. 센서를 다시 맞추면 정상값으로 돌아옵니다.",
    ),
)


class UnknownFarmError(ValueError):
    pass


class InvalidControlCommandError(ValueError):
    pass


class ControlProposalConflictError(ValueError):
    pass


class InvalidTelemetryIngressError(ValueError):
    pass


class TelemetryIngressConflictError(ValueError):
    pass


class KoreanGreenhouseSimulator:
    """A deterministic Korean facility-horticulture demo data source.

    The simulator never connects to a broker, PLC, or physical device. It is
    intentionally deterministic for repeatable local demos and automated tests.
    """

    def __init__(self, state_path: str | Path | None = None) -> None:
        self._scenario_pack = load_scenario_pack()
        self._scenario_profiles = self._scenario_pack.by_id()
        self._actuator_overrides: dict[
            str,
            dict[str, dict[str, list[tuple[datetime, float | bool | None]]]],
        ] = {}
        self._scenario_states: dict[str, DemoScenarioState] = {}
        self._scenario_history: dict[str, list[DemoScenarioState]] = {}
        self._operating_runs: dict[str, dict] = {}
        self._ingested_telemetry: dict[str, TelemetryIngressRequest] = {}
        self._control_executions: dict[str, tuple[str, ControlExecution]] = {}
        self._ingress_fingerprints: dict[str, str] = {}
        self._ingress_acceptances: dict[str, tuple[str, FarmSnapshot]] = {}
        self._ingress_rejections: dict[str, list[dict[str, str | None]]] = {}
        self._state_revision = 0
        self._state_lock = RLock()
        self._alert_occurrences: dict[str, dict[str, tuple[str, datetime]]] = {}
        self._alert_candidates: dict[str, dict[str, datetime]] = {}
        self._alert_clear_candidates: dict[str, dict[str, datetime]] = {}
        self._incidents: dict[str, dict[str, IncidentRecord]] = {}
        self._clock = VirtualClock()
        self._alert_occurrence_lock = Lock()
        self._recipe_thresholds = self._load_recipe_thresholds()
        self._active_strategies: dict[str, CultivationStrategyRuntime] = {}
        (
            self._alert_trigger_seconds,
            self._alert_clear_seconds,
            self._alert_hysteresis_ratio,
        ) = self._load_alert_policy()
        self._store = SQLiteTelemetryStore(state_path) if state_path else None
        self._restore_state()

    def _restore_state(self) -> None:
        if self._store is None:
            return
        revision, state = self._store.load_state()
        self._operating_runs = state.get("operating_runs", {})
        for runtime in self._operating_runs.values():
            if runtime["status"] == "running":
                runtime["status"] = "paused"
            runtime["stable_since"] = None
        self._state_revision = revision
        self._actuator_overrides = {}
        for farm_id, stored_scopes in state.get("actuator_overrides", {}).items():
            if not isinstance(stored_scopes, dict):
                continue
            zone_scopes = (
                stored_scopes
                if any(zone_id in stored_scopes for zone_id in ("zone-a", "zone-b"))
                else {"zone-a": stored_scopes}
            )
            self._actuator_overrides[farm_id] = {
                zone_id: {
                    field: [(datetime.fromisoformat(at), value) for at, value in events]
                    for field, events in fields.items()
                }
                for zone_id, fields in zone_scopes.items()
                if zone_id in {"zone-a", "zone-b"} and isinstance(fields, dict)
            }
        self._scenario_history = {
            farm_id: [DemoScenarioState.model_validate(item) for item in history]
            for farm_id, history in state.get("scenario_history", {}).items()
        }
        self._scenario_states = {
            farm_id: history[-1]
            for farm_id, history in self._scenario_history.items()
            if history
        }
        self._ingested_telemetry = {
            farm_id: TelemetryIngressRequest.model_validate(payload)
            for farm_id, payload in state.get("ingested_telemetry", {}).items()
        }
        self._alert_occurrences = {
            farm_id: {
                alert_id: (str(occurrence_id), datetime.fromisoformat(occurred_at))
                for alert_id, (occurrence_id, occurred_at) in occurrences.items()
            }
            for farm_id, occurrences in state.get("alert_occurrences", {}).items()
        }
        self._ingress_acceptances = {
            message_id: (
                str(acceptance["fingerprint"]),
                FarmSnapshot.model_validate(acceptance["result"]),
            )
            for message_id, acceptance in state.get("ingress_acceptances", {}).items()
        }
        self._alert_candidates = {
            farm_id: {alert_id: datetime.fromisoformat(started_at) for alert_id, started_at in items.items()}
            for farm_id, items in state.get("alert_candidates", {}).items()
        }
        self._alert_clear_candidates = {
            farm_id: {alert_id: datetime.fromisoformat(started_at) for alert_id, started_at in items.items()}
            for farm_id, items in state.get("alert_clear_candidates", {}).items()
        }
        self._incidents = {
            farm_id: {
                incident_id: IncidentRecord.model_validate(item)
                for incident_id, item in items.items()
            }
            for farm_id, items in state.get("incidents", {}).items()
        }
        self._active_strategies = {
            farm_id: CultivationStrategyRuntime.model_validate(payload)
            for farm_id, payload in state.get("active_strategies", {}).items()
        }
        clock_payload = state.get("virtual_clock")
        self._clock.restore(
            VirtualClockState.model_validate(clock_payload)
            if isinstance(clock_payload, dict)
            else None
        )

    def _serialized_state(
        self,
        pending_ingress_acceptance: tuple[str, str, FarmSnapshot] | None = None,
    ) -> dict[str, object]:
        ingress_acceptances = {
            message_id: {
                "fingerprint": fingerprint,
                "result": result.model_dump(mode="json"),
            }
            for message_id, (fingerprint, result) in self._ingress_acceptances.items()
        }
        if pending_ingress_acceptance is not None:
            message_id, fingerprint, result = pending_ingress_acceptance
            ingress_acceptances[message_id] = {
                "fingerprint": fingerprint,
                "result": result.model_dump(mode="json"),
            }
        return {
            "operating_runs": self._operating_runs,
            "actuator_overrides": {
                farm_id: {
                    zone_id: {
                        field: [[at.isoformat(), value] for at, value in events]
                        for field, events in fields.items()
                    }
                    for zone_id, fields in zones.items()
                }
                for farm_id, zones in self._actuator_overrides.items()
            },
            "scenario_history": {
                farm_id: [state.model_dump(mode="json") for state in history]
                for farm_id, history in self._scenario_history.items()
            },
            "ingested_telemetry": {
                farm_id: payload.model_dump(mode="json")
                for farm_id, payload in self._ingested_telemetry.items()
            },
            "alert_occurrences": {
                farm_id: {
                    alert_id: [occurrence_id, occurred_at.isoformat()]
                    for alert_id, (occurrence_id, occurred_at) in occurrences.items()
                }
                for farm_id, occurrences in self._alert_occurrences.items()
            },
            "ingress_acceptances": ingress_acceptances,
            "alert_candidates": {
                farm_id: {alert_id: started_at.isoformat() for alert_id, started_at in items.items()}
                for farm_id, items in self._alert_candidates.items()
            },
            "alert_clear_candidates": {
                farm_id: {alert_id: started_at.isoformat() for alert_id, started_at in items.items()}
                for farm_id, items in self._alert_clear_candidates.items()
            },
            "incidents": {
                farm_id: {
                    incident_id: item.model_dump(mode="json")
                    for incident_id, item in items.items()
                }
                for farm_id, items in self._incidents.items()
            },
            "active_strategies": {
                farm_id: strategy.model_dump(mode="json")
                for farm_id, strategy in self._active_strategies.items()
            },
            "virtual_clock": (
                self._clock.stored_state().model_dump(mode="json")
                if self._clock.stored_state() is not None
                else None
            ),
        }

    def _persist_state(
        self,
        *,
        execution: tuple[str, str, ControlExecution] | None = None,
        ingress_message: tuple[str, str] | None = None,
        ingress_acceptance: tuple[str, str, FarmSnapshot] | None = None,
        observations: list[dict[str, object]] | None = None,
        incident_events: list[dict[str, object]] | None = None,
    ) -> None:
        if self._store is None:
            return
        serialized_execution = None
        if execution is not None:
            proposal_id, fingerprint, result = execution
            serialized_execution = (proposal_id, fingerprint, result.model_dump(mode="json"))
        self._store.save_state(
            self._state_revision,
            self._serialized_state(ingress_acceptance),
            execution=serialized_execution,
            ingress_message=ingress_message,
            observations=observations,
            incident_events=incident_events,
        )

    @staticmethod
    def _fingerprint(payload: dict[str, object]) -> str:
        canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @staticmethod
    def _load_recipe_thresholds() -> dict[SensorMetric, tuple[float | None, float | None]]:
        candidates = [Path(os.getenv("CROP_PROFILE_PATH", "/app/data/crop-profiles/perlite-leaf-kr-v1.json"))]
        source_path = Path(__file__).resolve()
        if len(source_path.parents) > 3:
            candidates.append(source_path.parents[3] / "data" / "crop-profiles" / "perlite-leaf-kr-v1.json")
        for path in candidates:
            try:
                profile = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            thresholds: dict[SensorMetric, tuple[float | None, float | None]] = {}
            for item in profile.get("thresholds", []):
                try:
                    metric = SensorMetric(str(item["metric"]))
                    warning = item["warning"]
                    thresholds[metric] = (float(warning[0]), float(warning[1]))
                except (KeyError, TypeError, ValueError, IndexError):
                    continue
            if thresholds:
                return thresholds
        return {}

    @staticmethod
    def _load_alert_policy() -> tuple[int, int, float]:
        candidates = [Path(os.getenv("CROP_PROFILE_PATH", "/app/data/crop-profiles/perlite-leaf-kr-v1.json"))]
        source_path = Path(__file__).resolve()
        if len(source_path.parents) > 3:
            candidates.append(source_path.parents[3] / "data" / "crop-profiles" / "perlite-leaf-kr-v1.json")
        for path in candidates:
            try:
                profile = json.loads(path.read_text(encoding="utf-8"))
                policy = profile.get("simulator_policy", {})
                return (
                    max(0, int(policy.get("trigger_duration_seconds", 0))),
                    max(0, int(policy.get("clear_duration_seconds", 0))),
                    min(0.25, max(0.0, float(policy.get("hysteresis_ratio", 0.0)))),
                )
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                continue
        return (0, 0, 0.0)

    def _scenario_activation_at(self, farm_id: str, sampled_at: datetime) -> DemoScenarioState:
        """Return the activation that was effective at ``sampled_at``.

        Scenario and control history are evaluated against the requested time,
        so rendering a later point never rewrites an earlier chart point.
        """

        normalized_at = self._normalize_timestamp(sampled_at)
        applicable = [
            state
            for state in self._scenario_history.get(farm_id, [])
            if state.applied_at is None or normalized_at >= self._normalize_timestamp(state.applied_at)
        ]
        return applicable[-1] if applicable else DemoScenarioState(
            farm_id=farm_id,
            scenario_id=DemoScenarioId.NORMAL,
        )

    def _scenario_id_at(self, farm_id: str, sampled_at: datetime) -> DemoScenarioId:
        return self._scenario_activation_at(farm_id, sampled_at).scenario_id

    def _scenario_ids_at(self, farm_id: str, sampled_at: datetime) -> list[DemoScenarioId]:
        activation = self._scenario_activation_at(farm_id, sampled_at)
        return list(activation.scenario_ids or [activation.scenario_id])

    def _recovery_started_at(
        self,
        farm_id: str,
        activation: DemoScenarioState,
        sampled_at: datetime,
        scenario_id: DemoScenarioId | None = None,
        zone_id: str = "zone-a",
    ) -> datetime | None:
        if activation.applied_at is None or activation.scenario_id is DemoScenarioId.NORMAL:
            return None
        start = self._normalize_timestamp(activation.applied_at)
        end = self._normalize_timestamp(sampled_at)
        active_scenario_id = scenario_id or activation.scenario_id
        if active_scenario_id is DemoScenarioId.ROOT_COOLING_FAULT:
            controls = (("cooling_enabled", lambda value: value is True),)
        elif active_scenario_id is DemoScenarioId.IRRIGATION_BLOCKAGE:
            controls = (("irrigation_active", lambda value: value is True),)
        elif active_scenario_id in {
            DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
            DemoScenarioId.TEMPERATURE_SENSOR_FAULT,
        }:
            controls = (("air_temperature_sensor_recalibrated", lambda value: value is True),)
        elif active_scenario_id is DemoScenarioId.HIGH_HUMIDITY_STAGNATION:
            controls = (
                ("circulation_fan_pct", lambda value: float(value) >= 30),
                ("roof_vent_open_pct", lambda value: float(value) >= 30),
                ("side_vent_open_pct", lambda value: float(value) >= 30),
            )
        elif active_scenario_id is DemoScenarioId.VENTILATION_STUCK:
            controls = (
                ("circulation_fan_pct", lambda value: float(value) >= 30),
                ("side_vent_open_pct", lambda value: float(value) >= 30),
            )
        elif active_scenario_id in {DemoScenarioId.EC_DRIFT, DemoScenarioId.EC_RISE, DemoScenarioId.MOISTURE_LOW}:
            controls = (("irrigation_active", lambda value: value is True),)
        elif active_scenario_id is DemoScenarioId.HIGH_TEMPERATURE:
            controls = (
                ("cooling_enabled", lambda value: value is True),
                ("circulation_fan_pct", lambda value: float(value) >= 30),
                ("roof_vent_open_pct", lambda value: float(value) >= 30),
                ("side_vent_open_pct", lambda value: float(value) >= 30),
            )
        else:
            return None

        if zone_id not in set(activation.zone_ids or ["zone-a"]):
            return None
        overrides = self._actuator_overrides.get(farm_id, {}).get(zone_id, {})
        event_times = {end}
        for field, _accepts in controls:
            for effective_at, value in overrides.get(field, []):
                normalized_event = self._normalize_timestamp(effective_at)
                if start <= normalized_event <= end:
                    event_times.add(normalized_event)
                    if field == "irrigation_active" and value is True:
                        expires_at = normalized_event + timedelta(seconds=IRRIGATION_CYCLE_SECONDS)
                        if expires_at <= end:
                            event_times.add(expires_at)

        def recovery_control_active(at: datetime) -> bool:
            for field, accepts in controls:
                applicable = [
                    (self._normalize_timestamp(effective_at), value)
                    for effective_at, value in overrides.get(field, [])
                    if start <= self._normalize_timestamp(effective_at) <= at
                ]
                if not applicable:
                    continue
                effective_at, value = applicable[-1]
                if (
                    field == "irrigation_active"
                    and value is True
                    and (at - effective_at).total_seconds() >= IRRIGATION_CYCLE_SECONDS
                ):
                    value = False
                if value is not None and accepts(value):
                    return True
            return False

        active_since: datetime | None = None
        for event_at in sorted(event_times):
            if recovery_control_active(event_at):
                active_since = active_since or event_at
                continue
            if active_since is not None:
                recovery_seconds = (
                    self._scenario_profiles[active_scenario_id].recovery_seconds
                    if active_scenario_id in self._scenario_profiles
                    else SCENARIO_RECOVERY_SECONDS
                )
                if (event_at - active_since).total_seconds() >= recovery_seconds:
                    return active_since
                active_since = None
        return active_since

    def _scenario_runtime(self, farm_id: str, sampled_at: datetime) -> DemoScenarioState:
        normalized_at = self._normalize_timestamp(sampled_at)
        activation = self._scenario_activation_at(farm_id, normalized_at)
        if activation.scenario_id is DemoScenarioId.NORMAL or activation.applied_at is None:
            return activation.model_copy(
                update={
                    "phase": DemoScenarioPhase.NORMAL,
                    "elapsed_seconds": 0,
                    "phase_started_at": activation.applied_at,
                }
            )

        applied_at = self._normalize_timestamp(activation.applied_at)
        elapsed_seconds = max(0, int((normalized_at - applied_at).total_seconds()))
        profile = self._scenario_profiles.get(activation.scenario_id)
        ramp_seconds = profile.ramp_seconds if profile is not None else SCENARIO_RAMP_SECONDS
        recovery_seconds = profile.recovery_seconds if profile is not None else SCENARIO_RECOVERY_SECONDS
        recovery_starts = [
            self._recovery_started_at(
                farm_id,
                activation,
                normalized_at,
                zone_id=zone_id,
            )
            for zone_id in (activation.zone_ids or ["zone-a"])
        ]
        recovery_started_at = (
            max(started_at for started_at in recovery_starts if started_at is not None)
            if recovery_starts and all(started_at is not None for started_at in recovery_starts)
            else None
        )
        if recovery_started_at is not None:
            recovered_at = recovery_started_at + timedelta(seconds=recovery_seconds)
            if normalized_at >= recovered_at:
                phase = DemoScenarioPhase.RECOVERED
                phase_started_at = recovered_at
            else:
                phase = DemoScenarioPhase.RECOVERY
                phase_started_at = recovery_started_at
        elif elapsed_seconds < ramp_seconds:
            phase = DemoScenarioPhase.RAMP
            phase_started_at = applied_at
        else:
            phase = DemoScenarioPhase.HOLD
            phase_started_at = applied_at + timedelta(seconds=ramp_seconds)
        return activation.model_copy(
            update={
                "phase": phase,
                "elapsed_seconds": elapsed_seconds,
                "phase_started_at": phase_started_at,
            }
        )

    def _scenario_effect_factor(
        self,
        farm_id: str,
        sampled_at: datetime,
        zone_id: str = "zone-a",
    ) -> float:
        activation = self._scenario_activation_at(farm_id, sampled_at)
        if (
            activation.scenario_id is DemoScenarioId.NORMAL
            or activation.applied_at is None
            or zone_id not in set(activation.zone_ids or ["zone-a"])
        ):
            return 0.0
        normalized_at = self._normalize_timestamp(sampled_at)
        applied_at = self._normalize_timestamp(activation.applied_at)
        elapsed = max(0.0, (normalized_at - applied_at).total_seconds())
        profile = self._scenario_profiles.get(activation.scenario_id)
        ramp_seconds = profile.ramp_seconds if profile is not None else SCENARIO_RAMP_SECONDS
        recovery_seconds = profile.recovery_seconds if profile is not None else SCENARIO_RECOVERY_SECONDS
        ramp_factor = 1.0 if ramp_seconds == 0 else min(1.0, elapsed / ramp_seconds)
        recovery_started_at = self._recovery_started_at(
            farm_id,
            activation,
            normalized_at,
            zone_id=zone_id,
        )
        if recovery_started_at is None:
            return ramp_factor
        recovery_initial_factor = min(
            1.0,
            max(0.0, (recovery_started_at - applied_at).total_seconds() / max(1, ramp_seconds)),
        )
        recovery_elapsed = max(0.0, (normalized_at - recovery_started_at).total_seconds())
        return recovery_initial_factor * max(0.0, 1.0 - recovery_elapsed / recovery_seconds)

    def _scenario_profile_effect_factor(
        self,
        farm_id: str,
        scenario_id: DemoScenarioId,
        sampled_at: datetime,
        zone_id: str = "zone-a",
    ) -> float:
        profile = self._scenario_profiles.get(scenario_id)
        activation = self._scenario_activation_at(farm_id, sampled_at)
        if profile is None or activation.applied_at is None:
            return self._scenario_effect_factor(farm_id, sampled_at, zone_id)
        if zone_id not in set(activation.zone_ids or ["zone-a"]):
            return 0.0
        response_delay = max(
            (effect.response_delay_seconds for effect in profile.device_effects),
            default=0,
        )
        normalized_at = self._normalize_timestamp(sampled_at)
        applied_at = self._normalize_timestamp(activation.applied_at)
        elapsed = max(0.0, (normalized_at - applied_at).total_seconds() - response_delay)
        if elapsed <= 0 and response_delay > 0:
            return 0.0
        ramp_factor = 1.0 if profile.ramp_seconds == 0 else min(1.0, elapsed / profile.ramp_seconds)
        recovery_started_at = self._recovery_started_at(
            farm_id,
            activation,
            normalized_at,
            scenario_id=scenario_id,
            zone_id=zone_id,
        )
        if recovery_started_at is None:
            return ramp_factor
        recovery_initial_factor = (
            1.0
            if profile.ramp_seconds == 0
            else min(
                1.0,
                max(
                    0.0,
                    (
                        recovery_started_at - applied_at
                    ).total_seconds()
                    - response_delay,
                )
                / profile.ramp_seconds,
            )
        )
        recovery_elapsed = max(0.0, (normalized_at - recovery_started_at).total_seconds())
        return recovery_initial_factor * max(
            0.0,
            1.0 - recovery_elapsed / profile.recovery_seconds,
        )

    def list_farms(self) -> list[FarmInfo]:
        return list(FARMS.values())

    def virtual_time(self, wall_now: datetime) -> datetime:
        return wall_now if self._operating_runs else self._clock.now(wall_now)

    def clock_state(
        self,
        farm_id: str,
        wall_now: datetime,
        *,
        virtual_now: datetime | None = None,
    ) -> VirtualClockState:
        self._farm(farm_id)
        state = self._clock.state(wall_now)
        normalized_wall = self._normalize_timestamp(wall_now)
        return state.model_copy(
            update={
                "farm_id": farm_id,
                "wall_anchor": normalized_wall,
                "virtual_anchor": (
                    self._normalize_timestamp(virtual_now)
                    if virtual_now is not None
                    else self._clock.now(normalized_wall)
                ),
            }
        )

    def update_clock(
        self,
        request: VirtualClockUpdateRequest,
        wall_now: datetime,
    ) -> VirtualClockState:
        with self._state_lock:
            self._farm(request.farm_id)
            if self._operating_runs:
                raise ValueError("지속 운영에서는 시계 배속을 변경할 수 없습니다.")
            previous = self._clock.stored_state()
            updated = self._clock.update(wall_now, request).model_copy(
                update={"farm_id": request.farm_id}
            )
            try:
                self._persist_state()
            except Exception:
                self._clock.restore(previous)
                raise
            return updated

    def incident_history(self, farm_id: str, limit: int = 200) -> list[IncidentRecord]:
        self._farm(farm_id)
        items = list(self._incidents.get(farm_id, {}).values())
        return sorted(items, key=lambda item: item.opened_at, reverse=True)[:limit]

    def replay(
        self,
        request: TelemetryReplayRequest,
        wall_now: datetime,
    ) -> TelemetryReplayResponse:
        self._farm(request.farm_id)
        ordered = sorted(request.observations, key=lambda item: item.timestamp)
        if request.reset_clock_to_first_observation:
            self.update_clock(
                VirtualClockUpdateRequest(
                    farm_id=request.farm_id,
                    reset_to=ordered[0].timestamp,
                    paused=True,
                    seed=self._clock.state(wall_now).seed,
                ),
                wall_now,
            )
        accepted = 0
        for item in ordered:
            self.ingest_telemetry(item, received_at=max(wall_now, item.timestamp))
            accepted += 1
        return TelemetryReplayResponse(
            farm_id=request.farm_id,
            accepted_observations=accepted,
            first_observed_at=ordered[0].timestamp,
            last_observed_at=ordered[-1].timestamp,
            state_revision=self._state_revision,
            simulated_only=all(item.simulated_only for item in ordered),
        )

    def list_scenarios(self) -> list[DemoScenarioDefinition]:
        return [
            DemoScenarioDefinition(
                scenario_id=profile.scenario_id,
                name_ko=profile.name_ko,
                description_ko=profile.description_ko,
                category=profile.category,
                supported_zones=profile.supported_zones,
                recovery_actions=(profile.recovery.actions if profile.recovery is not None else []),
                provenance_refs=[item.source_id for item in profile.provenance],
            )
            for profile in self._scenario_pack.profiles
        ]

    def scenario_state(self, farm_id: str, sampled_at: datetime | None = None) -> DemoScenarioState:
        self._farm(farm_id)
        if sampled_at is not None:
            return self._scenario_runtime(farm_id, sampled_at).model_copy(
                update={"state_revision": self._state_revision}
            )
        state = self._scenario_states.get(
            farm_id,
            DemoScenarioState(farm_id=farm_id, scenario_id=DemoScenarioId.NORMAL),
        )
        return state.model_copy(update={"state_revision": self._state_revision})

    def activate_scenario(
        self,
        farm_id: str,
        scenario_id: DemoScenarioId,
        applied_at: datetime,
        correlation_id: str,
        *,
        scenario_ids: list[DemoScenarioId] | None = None,
        zone_ids: list[str] | None = None,
        seed: int = 1024,
    ) -> DemoScenarioState:
        with self._state_lock:
            self._farm(farm_id)
            if farm_id in self._operating_runs:
                raise ValueError("지속 운영 실행에 수동 시험 사건을 겹칠 수 없습니다.")
            active_scenarios = list(scenario_ids or [scenario_id])
            if scenario_id not in active_scenarios:
                raise ValueError("scenario_id must be included in scenario_ids")
            if len(active_scenarios) > self._scenario_pack.max_active_scenarios:
                raise ValueError("at most two scenarios can be active")
            if len(set(active_scenarios)) != len(active_scenarios):
                raise ValueError("active scenarios must be unique")
            if DemoScenarioId.NORMAL in active_scenarios and len(active_scenarios) > 1:
                raise ValueError("normal cannot be combined with a fault scenario")
            legacy_scenarios = {
                DemoScenarioId.HIGH_TEMPERATURE,
                DemoScenarioId.EC_RISE,
                DemoScenarioId.MOISTURE_LOW,
                DemoScenarioId.TEMPERATURE_SENSOR_FAULT,
            }
            if any(
                item not in self._scenario_profiles and item not in legacy_scenarios
                for item in active_scenarios
            ):
                raise ValueError("scenario is not available in the active scenario pack")
            if len(active_scenarios) > 1 and any(item in legacy_scenarios for item in active_scenarios):
                raise ValueError("legacy scenarios cannot be combined")
            active_zones = list(zone_ids or ["zone-a"])
            if len(active_zones) > self._scenario_pack.max_zones or any(
                item not in {"zone-a", "zone-b"} for item in active_zones
            ):
                raise ValueError("at most two supported zones can be active")
            if len(set(active_zones)) != len(active_zones):
                raise ValueError("active zones must be unique")
            normalized_at = self._normalize_timestamp(applied_at)
            previous_revision = self._state_revision
            previous_overrides = (
                {
                    zone_id: {field: list(events) for field, events in fields.items()}
                    for zone_id, fields in self._actuator_overrides[farm_id].items()
                }
                if farm_id in self._actuator_overrides
                else None
            )
            previous_ingress = self._ingested_telemetry.get(farm_id)
            had_ingress = farm_id in self._ingested_telemetry
            previous_state = self._scenario_states.get(farm_id)
            had_state = farm_id in self._scenario_states
            previous_history = list(self._scenario_history.get(farm_id, []))
            had_history = farm_id in self._scenario_history
            # A selected fault profile owns its initial device conditions. End any
            # earlier manual overrides at the activation boundary so the UI cannot
            # show a healthy device override while profile sensors model its fault.
            for zone_id in active_zones:
                for events in self._actuator_overrides.get(farm_id, {}).get(zone_id, {}).values():
                    events.append((normalized_at, None))
            if scenario_id is DemoScenarioId.NORMAL:
                self._ingested_telemetry.pop(farm_id, None)
            self._state_revision += 1
            state = DemoScenarioState(
                farm_id=farm_id,
                scenario_id=scenario_id,
                applied_at=normalized_at,
                correlation_id=correlation_id,
                phase=DemoScenarioPhase.NORMAL if scenario_id is DemoScenarioId.NORMAL else DemoScenarioPhase.RAMP,
                elapsed_seconds=0,
                phase_started_at=normalized_at,
                state_revision=self._state_revision,
                scenario_ids=active_scenarios,
                zone_ids=active_zones,
                seed=seed,
            )
            self._scenario_states[farm_id] = state
            self._scenario_history.setdefault(farm_id, []).append(state)
            try:
                self._persist_state()
            except Exception:
                self._state_revision = previous_revision
                if previous_overrides is None:
                    self._actuator_overrides.pop(farm_id, None)
                else:
                    self._actuator_overrides[farm_id] = previous_overrides
                if had_ingress:
                    assert previous_ingress is not None
                    self._ingested_telemetry[farm_id] = previous_ingress
                else:
                    self._ingested_telemetry.pop(farm_id, None)
                if had_state:
                    assert previous_state is not None
                    self._scenario_states[farm_id] = previous_state
                else:
                    self._scenario_states.pop(farm_id, None)
                if had_history:
                    self._scenario_history[farm_id] = previous_history
                else:
                    self._scenario_history.pop(farm_id, None)
                raise
            return state

    def snapshot(
        self,
        farm_id: str,
        sampled_at: datetime,
        *,
        wall_now: datetime | None = None,
        reconcile_alert_occurrences: bool = True,
    ) -> FarmSnapshot:
        with self._state_lock:
            if farm_id in self._operating_runs:
                reconcile_alert_occurrences = False
            return self._snapshot(
                farm_id,
                sampled_at,
                wall_now=wall_now,
                reconcile_alert_occurrences=reconcile_alert_occurrences,
            )

    def _snapshot(
        self,
        farm_id: str,
        sampled_at: datetime,
        *,
        wall_now: datetime | None = None,
        ingress: TelemetryIngressRequest | None = None,
        state_revision: int | None = None,
        persist_alert_occurrences: bool = True,
        reconcile_alert_occurrences: bool = True,
    ) -> FarmSnapshot:
        normalized_at = self._normalize_timestamp(sampled_at)
        farm = self._farm(farm_id)
        scenario = self.scenario_state(farm_id, normalized_at)
        readings = self.readings_at(farm_id, normalized_at)
        ingress = ingress or self._ingested_telemetry.get(farm_id)
        data_source = "deterministic-simulator"
        simulated_only = True
        if ingress is not None and abs((normalized_at - self._normalize_timestamp(ingress.timestamp)).total_seconds()) <= 300:
            incoming = {(reading.zone_id, reading.metric): reading for reading in ingress.readings}
            all_metrics_supplied = {
                (reading.zone_id, reading.metric) for reading in readings
            }.issubset(incoming)
            readings = [incoming.get((reading.zone_id, reading.metric), reading) for reading in readings]
            if all_metrics_supplied:
                if ingress.simulated_only:
                    data_source = f"ingress:{ingress.source}"
                else:
                    data_source = f"mixed:ingress:{ingress.source}+deterministic-actuators"
                simulated_only = True
            else:
                data_source = f"mixed:ingress:{ingress.source}+deterministic-simulator"
                simulated_only = True
        alerts = self.alerts_for(
            farm_id,
            readings,
            normalized_at,
            persist_occurrences=persist_alert_occurrences,
            reconcile_occurrences=reconcile_alert_occurrences,
            simulated_only=ingress is None or ingress.simulated_only,
        )
        active_scenario_ids = list(scenario.scenario_ids or [scenario.scenario_id])
        zones = sorted({reading.zone_id for reading in readings}) or ["zone-a"]
        exposure_minutes = max(0.0, scenario.elapsed_seconds / 60.0)
        return FarmSnapshot(
            farm=farm,
            sampled_at=normalized_at,
            scenario_id=scenario.scenario_id,
            scenario_applied_at=scenario.applied_at,
            scenario_phase=scenario.phase,
            scenario_elapsed_seconds=scenario.elapsed_seconds,
            scenario_phase_started_at=scenario.phase_started_at,
            readings=readings,
            actuator_state=self.actuator_state_at(farm_id, normalized_at),
            alerts=alerts,
            data_source=data_source,
            simulated_only=simulated_only,
            state_revision=self._state_revision if state_revision is None else state_revision,
            ingress_metadata=self._ingress_metadata(ingress),
            active_scenario_ids=active_scenario_ids,
            zones=zones,
            device_twins=self.device_twins_at(farm_id, normalized_at),
            derived_indicators=[
                derived_indicators(
                    readings,
                    normalized_at,
                    exposure_minutes=exposure_minutes,
                    zone_id=zone_id,
                )
                for zone_id in zones
            ],
            incidents=self.incident_history(farm_id, 50),
            clock=self.clock_state(
                farm_id,
                wall_now or normalized_at,
                virtual_now=normalized_at,
            ),
        )

    def _ingress_metadata(
        self,
        ingress: TelemetryIngressRequest | None,
    ) -> TelemetryIngressMetadata | None:
        if ingress is None:
            return None
        required_metrics = {
            SensorMetric.AIR_TEMPERATURE,
            SensorMetric.RELATIVE_HUMIDITY,
            SensorMetric.ROOT_ZONE_TEMPERATURE,
            SensorMetric.SUPPLY_EC,
            SensorMetric.SUPPLY_PH,
            SensorMetric.SUBSTRATE_MOISTURE,
            SensorMetric.IRRIGATION_FLOW,
        }
        zones = sorted({reading.zone_id for reading in ingress.readings})
        metrics_by_zone = {
            zone_id: {
                reading.metric for reading in ingress.readings if reading.zone_id == zone_id
            }
            for zone_id in zones
        }
        complete = bool(zones) and all(
            required_metrics.issubset(metrics) for metrics in metrics_by_zone.values()
        )
        quality_counts: dict[str, int] = {}
        for reading in ingress.readings:
            quality_counts[reading.quality.value] = quality_counts.get(reading.quality.value, 0) + 1
        return TelemetryIngressMetadata(
            message_id=ingress.message_id,
            sequence=ingress.sequence,
            observed_at=ingress.timestamp,
            source=ingress.source,
            metric_count=len(ingress.readings),
            complete=complete,
            mixed=True,
            zones=zones,
            quality_counts=quality_counts,
        )

    def gateway_status(self, farm_id: str, observed_at: datetime) -> GatewayStatus:
        self._farm(farm_id)
        ingress = self._ingested_telemetry.get(farm_id)
        rejection_summary = self.ingress_rejection_summary(farm_id)
        required = {
            SensorMetric.AIR_TEMPERATURE,
            SensorMetric.RELATIVE_HUMIDITY,
            SensorMetric.ROOT_ZONE_TEMPERATURE,
            SensorMetric.SUPPLY_EC,
            SensorMetric.SUPPLY_PH,
            SensorMetric.SUBSTRATE_MOISTURE,
            SensorMetric.IRRIGATION_FLOW,
        }
        if ingress is None:
            return GatewayStatus(
                farm_id=farm_id,
                state="not_connected",
                expected_metric_count=len(required),
                missing_metrics=sorted(item.value for item in required),
                duplicate_sensor_metrics=rejection_summary["counts"].get("duplicate_sensor", 0),
                unit_errors=rejection_summary["counts"].get("unit", 0),
                rejected_message_count=rejection_summary["count"],
                rejection_counts=rejection_summary["counts"],
                last_rejection_at=rejection_summary["last_rejection_at"],
                last_rejection_reason=rejection_summary["last_rejection_reason"],
            )
        timestamp = self._normalize_timestamp(observed_at)
        ingress_at = self._normalize_timestamp(ingress.timestamp)
        age_seconds = max(0, int((timestamp - ingress_at).total_seconds()))
        zones = sorted({reading.zone_id for reading in ingress.readings}) or ["zone-a"]
        received = {(reading.zone_id, reading.metric) for reading in ingress.readings}
        expected = {(zone_id, metric) for zone_id in zones for metric in required}
        missing = sorted(
            f"{zone_id}:{metric.value}"
            for zone_id, metric in expected - received
        )
        quality_counts: dict[str, int] = {}
        for reading in ingress.readings:
            quality_counts[reading.quality.value] = quality_counts.get(reading.quality.value, 0) + 1
        degraded_quality = sum(
            quality_counts.get(value, 0)
            for value in (SensorQuality.SUSPECT.value, SensorQuality.BAD.value, SensorQuality.STALE.value, SensorQuality.MISSING.value)
        )
        state = "stale" if age_seconds > 300 else "degraded" if missing or degraded_quality else "ready"
        return GatewayStatus(
            farm_id=farm_id,
            state=state,
            source=ingress.source,
            observed_at=ingress_at,
            age_seconds=age_seconds,
            message_id=ingress.message_id,
            sequence=ingress.sequence,
            metric_count=len(received),
            expected_metric_count=len(expected),
            completeness_percent=round(100 * len(received & expected) / len(expected), 1),
            missing_metrics=missing,
            quality_counts=quality_counts,
            duplicate_sensor_metrics=rejection_summary["counts"].get("duplicate_sensor", 0),
            unit_errors=rejection_summary["counts"].get("unit", 0),
            rejected_message_count=rejection_summary["count"],
            rejection_counts=rejection_summary["counts"],
            last_rejection_at=rejection_summary["last_rejection_at"],
            last_rejection_reason=rejection_summary["last_rejection_reason"],
            simulated_only=ingress.simulated_only,
        )

    def record_ingress_rejection(
        self,
        *,
        farm_id: str,
        source: str | None,
        message_id: str | None,
        rejected_at: datetime,
        reason_code: str,
        detail: str,
    ) -> None:
        self._farm(farm_id)
        item = {
            "source": source,
            "message_id": message_id,
            "rejected_at": self._normalize_timestamp(rejected_at).isoformat(),
            "reason_code": reason_code,
            "detail": detail[:500],
        }
        if self._store is not None:
            self._store.record_ingress_rejection(farm_id=farm_id, **item)
            return
        records = self._ingress_rejections.setdefault(farm_id, [])
        records.append(item)
        del records[:-500]

    def ingress_rejection_summary(self, farm_id: str) -> dict[str, object]:
        self._farm(farm_id)
        if self._store is not None:
            return self._store.ingress_rejection_summary(farm_id)
        records = self._ingress_rejections.get(farm_id, [])
        counts: dict[str, int] = {}
        for item in records:
            reason = str(item["reason_code"])
            counts[reason] = counts.get(reason, 0) + 1
        latest = records[-1] if records else None
        return {
            "count": len(records),
            "counts": counts,
            "last_rejection_at": None if latest is None else latest["rejected_at"],
            "last_rejection_reason": None if latest is None else latest["detail"],
        }

    def apply_cultivation_strategy(
        self,
        request: CultivationStrategyUpdateRequest,
        applied_at: datetime,
    ) -> CultivationStrategyRuntime:
        with self._state_lock:
            self._farm(request.farm_id)
            runtime = CultivationStrategyRuntime(
                **request.model_dump(),
                applied_at=self._normalize_timestamp(applied_at),
            )
            previous = self._active_strategies.get(request.farm_id)
            self._active_strategies[request.farm_id] = runtime
            self._state_revision += 1
            try:
                self._persist_state()
            except Exception:
                if previous is None:
                    self._active_strategies.pop(request.farm_id, None)
                else:
                    self._active_strategies[request.farm_id] = previous
                self._state_revision -= 1
                raise
            return runtime

    def active_cultivation_strategy(self, farm_id: str) -> CultivationStrategyRuntime | None:
        self._farm(farm_id)
        return self._active_strategies.get(farm_id)

    def ingest_telemetry(
        self,
        payload: TelemetryIngressRequest,
        received_at: datetime | None = None,
    ) -> FarmSnapshot:
        with self._state_lock:
            self._farm(payload.farm_id)
            if payload.farm_id in self._operating_runs:
                raise InvalidTelemetryIngressError("지속 시뮬레이션에 외부 관측을 혼합할 수 없습니다.")
            observed_at = self._normalize_timestamp(payload.timestamp)
            now = self._normalize_timestamp(received_at or datetime.now(timezone.utc))
            normalized = payload.model_copy(
                update={"sampled_at": observed_at, "observed_at": observed_at}
            )
            fingerprint_payload = normalized.model_dump(mode="json", exclude={"message_id"})
            fingerprint = self._fingerprint(fingerprint_payload)
            if normalized.message_id is not None:
                existing_acceptance = self._ingress_acceptances.get(normalized.message_id)
                if existing_acceptance is not None:
                    existing_fingerprint, result = existing_acceptance
                    if existing_fingerprint != fingerprint:
                        raise TelemetryIngressConflictError(
                            "message_id was already used with a different telemetry payload"
                        )
                    return result
                existing_fingerprint = self._ingress_fingerprints.get(normalized.message_id)
                if existing_fingerprint is None and self._store is not None:
                    existing_fingerprint = self._store.ingress_fingerprint(normalized.message_id)
                if existing_fingerprint is not None:
                    if existing_fingerprint != fingerprint:
                        raise TelemetryIngressConflictError(
                            "message_id was already used with a different telemetry payload"
                        )
                    return self._snapshot(
                        normalized.farm_id,
                        observed_at,
                        ingress=normalized,
                        persist_alert_occurrences=False,
                        reconcile_alert_occurrences=False,
                    )
            if observed_at > now:
                raise InvalidTelemetryIngressError("observed_at must not be in the future")
            previous = self._ingested_telemetry.get(normalized.farm_id)
            if previous is not None:
                previous_at = self._normalize_timestamp(previous.timestamp)
                if observed_at < previous_at:
                    raise InvalidTelemetryIngressError(
                        "observed_at is older than the latest accepted telemetry"
                    )
                if (
                    normalized.sequence is not None
                    and previous.sequence is not None
                    and normalized.sequence <= previous.sequence
                ):
                    raise InvalidTelemetryIngressError(
                        "sequence must increase beyond the latest accepted telemetry"
                    )
            had_previous = normalized.farm_id in self._ingested_telemetry
            previous_alert_occurrences = dict(
                self._alert_occurrences.get(normalized.farm_id, {})
            )
            self._ingested_telemetry[normalized.farm_id] = normalized
            self._state_revision += 1
            ingress_message = None
            if normalized.message_id is not None:
                ingress_message = (normalized.message_id, fingerprint)
            result = self._snapshot(
                normalized.farm_id,
                observed_at,
                ingress=normalized,
                state_revision=self._state_revision,
                persist_alert_occurrences=False,
                reconcile_alert_occurrences=True,
            )
            ingress_acceptance = None
            if normalized.message_id is not None:
                ingress_acceptance = (normalized.message_id, fingerprint, result)
            observations = [
                {
                    "farm_id": normalized.farm_id,
                    "zone_id": reading.zone_id,
                    "sensor_id": reading.sensor_id or f"{reading.zone_id}:{reading.metric.value}",
                    "metric": reading.metric.value,
                    "observed_at": self._normalize_timestamp(
                        reading.observed_at or normalized.timestamp
                    ).isoformat(),
                    "ingested_at": now.isoformat(),
                    "message_id": normalized.message_id,
                    "sequence": normalized.sequence,
                    "value": reading.value,
                    "unit": reading.unit,
                    "quality": reading.quality.value,
                    "source": reading.source or normalized.source,
                    "simulated_only": normalized.simulated_only,
                }
                for reading in normalized.readings
            ]
            try:
                self._persist_state(
                    ingress_message=ingress_message,
                    ingress_acceptance=ingress_acceptance,
                    observations=observations,
                )
            except Exception:
                if had_previous:
                    assert previous is not None
                    self._ingested_telemetry[normalized.farm_id] = previous
                else:
                    self._ingested_telemetry.pop(normalized.farm_id, None)
                self._state_revision -= 1
                if previous_alert_occurrences:
                    self._alert_occurrences[normalized.farm_id] = previous_alert_occurrences
                else:
                    self._alert_occurrences.pop(normalized.farm_id, None)
                raise
            if normalized.message_id is not None:
                self._ingress_fingerprints[normalized.message_id] = fingerprint
                self._ingress_acceptances[normalized.message_id] = (fingerprint, result)
            return result

    def _normal_reading_values(
        self,
        farm_id: str,
        sampled_at: datetime,
        zone_id: str,
    ) -> dict[SensorMetric, float]:
        local = self._normalize_timestamp(sampled_at).astimezone(KST)
        minutes = local.hour * 60 + local.minute + local.second / 60
        day_phase = 2 * math.pi * minutes / (24 * 60)
        solar = max(0.0, math.sin(math.pi * (minutes - 6 * 60) / (12 * 60)))
        state = self._actuator_state_at(
            farm_id,
            sampled_at,
            apply_scenario=False,
            zone_id=zone_id,
        )
        vent_fraction = (state.roof_vent_open_pct + state.side_vent_open_pct) / 200
        fan_fraction = state.circulation_fan_pct / 100
        temperature = 15.0 + 5.5 * solar + 0.4 * math.sin(day_phase)
        temperature -= 2.3 * vent_fraction + 0.8 * fan_fraction
        temperature += 2.0 if state.heating_enabled else 0.0
        temperature -= 0.6 if state.cooling_enabled else 0.0
        humidity = 79.0 - 12.0 * solar - 4.0 * vent_fraction - 3.0 * fan_fraction
        root_temperature = 15.2 + 3.5 * solar + 0.25 * math.sin(day_phase + 0.5)
        root_temperature += 0.8 if state.heating_enabled else 0.0
        root_temperature -= 2.4 if state.cooling_enabled else 0.0
        supply_ec = 2.08 + 0.05 * math.sin(day_phase + 0.4)
        supply_ph = 6.18 + 0.06 * math.sin(day_phase - 0.8)
        moisture = 61.0 - 4.0 * solar + 1.4 * math.sin(day_phase + 1.2)
        if state.irrigation_active:
            moisture += 3.0
        ppfd = 520.0 * solar * max(0.2, 1.0 - state.thermal_curtain_pct * 0.0065)
        return {
            SensorMetric.AIR_TEMPERATURE: temperature,
            SensorMetric.RELATIVE_HUMIDITY: humidity,
            SensorMetric.ROOT_ZONE_TEMPERATURE: root_temperature,
            SensorMetric.SUPPLY_EC: supply_ec,
            SensorMetric.DRAIN_EC: supply_ec + 0.18 + 0.03 * solar,
            SensorMetric.SUPPLY_PH: supply_ph,
            SensorMetric.DRAIN_PH: supply_ph + 0.12,
            SensorMetric.SUBSTRATE_MOISTURE: moisture,
            SensorMetric.IRRIGATION_FLOW: 8.2 if state.irrigation_active else 0.0,
            SensorMetric.IRRIGATION_PRESSURE: 2.1 if state.irrigation_active else 0.15,
            SensorMetric.TANK_LEVEL: 82.0 - 4.5 * solar,
            SensorMetric.PPFD: ppfd,
            SensorMetric.CO2: 850.0 - 300.0 * solar + 18.0 * math.sin(day_phase + 0.7),
            SensorMetric.PUMP_CURRENT: 3.8 if state.irrigation_active else 0.08,
            SensorMetric.SOLAR_RADIATION: ppfd / 2.1,
            SensorMetric.SUBSTRATE_EC: supply_ec,
            SensorMetric.NUTRIENT_PH: supply_ph,
            SensorMetric.SUBSTRATE_TEMPERATURE: root_temperature,
            SensorMetric.OUTSIDE_WIND_SPEED: 1.4 + 1.1 * (math.sin(day_phase + 1.4) + 1) / 2,
            SensorMetric.RAIN_DETECTED: 1.0 if (local.day + local.hour) % 19 == 0 else 0.0,
        }

    def readings_at(self, farm_id: str, sampled_at: datetime) -> list[SensorReading]:
        runtime = self._operating_runs.get(farm_id)
        if runtime:
            return [SensorReading.model_validate(r) for r in runtime["readings"]]
        return self._legacy_readings_at(farm_id, sampled_at)

    def _legacy_readings_at(self, farm_id: str, sampled_at: datetime) -> list[SensorReading]:
        self._farm(farm_id)
        scenario_id = self._scenario_id_at(farm_id, sampled_at)
        scenario_ids = self._scenario_ids_at(farm_id, sampled_at)
        activation = self._scenario_activation_at(farm_id, sampled_at)
        affected_zones = set(activation.zone_ids or ["zone-a"])

        def values_for_zone(
            zone_id: str,
        ) -> tuple[dict[SensorMetric, float], dict[SensorMetric, SensorQuality]]:
            zone_values = self._normal_reading_values(farm_id, sampled_at, zone_id)
            zone_quality: dict[SensorMetric, SensorQuality] = {}
            if zone_id not in affected_zones:
                return zone_values, zone_quality
            for active_id in scenario_ids:
                profile = self._scenario_profiles.get(active_id)
                if profile is None:
                    continue
                effect_factor = self._scenario_profile_effect_factor(
                    farm_id,
                    active_id,
                    sampled_at,
                    zone_id,
                )
                for effect in profile.sensor_effects:
                    current = zone_values.get(effect.metric)
                    if current is None:
                        continue
                    target = current + effect.target_value if effect.mode == "delta" else effect.target_value
                    zone_values[effect.metric] = current + (target - current) * effect_factor
                    zone_quality[effect.metric] = SensorQuality(effect.quality)
            effect_factor = self._scenario_effect_factor(farm_id, sampled_at, zone_id)

            def blend(metric: SensorMetric, target: float) -> None:
                current = zone_values[metric]
                zone_values[metric] = current + (target - current) * effect_factor

            if scenario_id is DemoScenarioId.HIGH_TEMPERATURE:
                blend(
                    SensorMetric.AIR_TEMPERATURE,
                    max(zone_values[SensorMetric.AIR_TEMPERATURE] + 6.0, 31.5),
                )
                blend(
                    SensorMetric.RELATIVE_HUMIDITY,
                    min(zone_values[SensorMetric.RELATIVE_HUMIDITY] - 10.0, 68.0),
                )
            elif scenario_id is DemoScenarioId.EC_RISE:
                target_supply_ec = max(zone_values[SensorMetric.SUPPLY_EC] + 0.75, 2.75)
                blend(SensorMetric.SUPPLY_EC, target_supply_ec)
                blend(SensorMetric.DRAIN_EC, max(target_supply_ec + 0.32, 3.05))
            elif scenario_id is DemoScenarioId.MOISTURE_LOW:
                moisture = zone_values[SensorMetric.SUBSTRATE_MOISTURE]
                blend(SensorMetric.SUBSTRATE_MOISTURE, min(moisture - 18.0, 30.0))
            elif scenario_id is DemoScenarioId.TEMPERATURE_SENSOR_FAULT:
                blend(SensorMetric.AIR_TEMPERATURE, 82.0)
            zone_values[SensorMetric.SUBSTRATE_EC] = zone_values[SensorMetric.SUPPLY_EC]
            zone_values[SensorMetric.NUTRIENT_PH] = zone_values[SensorMetric.SUPPLY_PH]
            zone_values[SensorMetric.SUBSTRATE_TEMPERATURE] = zone_values[SensorMetric.ROOT_ZONE_TEMPERATURE]
            return zone_values, zone_quality

        zones = ["zone-a", "zone-b"]
        readings: list[SensorReading] = []
        for zone_index, zone_id in enumerate(zones):
            zone_values, zone_quality = values_for_zone(zone_id)
            for metric, value in zone_values.items():
                zone_offset = 0.0
                if zone_index:
                    if metric in {SensorMetric.AIR_TEMPERATURE, SensorMetric.ROOT_ZONE_TEMPERATURE}:
                        zone_offset = 0.35
                    elif metric is SensorMetric.RELATIVE_HUMIDITY:
                        zone_offset = -0.8
                    elif metric in {SensorMetric.SUPPLY_EC, SensorMetric.DRAIN_EC}:
                        zone_offset = 0.03
                # Both zones share variation bounds, not the same samples.
                # Zone identity keeps the signal reproducible and independent.
                digest = hashlib.sha256(
                    (
                        f"{activation.seed}|{zone_id}|{metric.value}|"
                        f"{self._normalize_timestamp(sampled_at).isoformat()}"
                    ).encode("utf-8")
                ).digest()
                signed_noise = (int.from_bytes(digest[:2], "big") / 65_535.0) * 2.0 - 1.0
                noise_scale = (
                    0.05
                    if metric in {SensorMetric.AIR_TEMPERATURE, SensorMetric.ROOT_ZONE_TEMPERATURE}
                    else 0.2
                    if metric is SensorMetric.RELATIVE_HUMIDITY
                    else 0.01
                    if metric in {SensorMetric.SUPPLY_EC, SensorMetric.DRAIN_EC}
                    else 0.0
                )
                zone_offset += signed_noise * noise_scale
                readings.append(
                    SensorReading(
                        metric=metric,
                        value=round(value + zone_offset, 2),
                        unit=METRIC_UNITS[metric],
                        zone_id=zone_id,
                        sensor_id=f"{zone_id}:{metric.value}",
                        quality=zone_quality.get(metric, SensorQuality.GOOD),
                        source="deterministic-simulator",
                        observed_at=self._normalize_timestamp(sampled_at),
                    )
                )
        return readings

    def actuator_state_at(
        self,
        farm_id: str,
        sampled_at: datetime,
        zone_id: str = "zone-a",
    ) -> ActuatorState:
        state = self._actuator_state_at(farm_id, sampled_at, apply_scenario=True, zone_id=zone_id)
        faults = set(self._operating_runs.get(farm_id, {}).get("faults", []))
        fields = {"root_zone_chiller": "cooling_enabled", "irrigation_pump": "irrigation_active", "ventilation_fan": "circulation_fan_pct"}
        return state.model_copy(update={field: (0.0 if device == "ventilation_fan" else False)
            for device, field in fields.items() if f"{zone_id}:{device}" in faults})

    def _sensor_recalibrated_at(
        self,
        farm_id: str,
        sampled_at: datetime,
        zone_id: str,
    ) -> bool:
        normalized_at = self._normalize_timestamp(sampled_at)
        applicable = [
            value
            for effective_at, value in self._actuator_overrides.get(farm_id, {})
            .get(zone_id, {})
            .get("air_temperature_sensor_recalibrated", [])
            if effective_at <= normalized_at and value is not None
        ]
        return bool(applicable[-1]) if applicable else False

    def device_twins_at(self, farm_id: str, sampled_at: datetime) -> list[ActuatorTwinState]:
        if farm_id in self._operating_runs:
            from .operating_runtime import twins
            return twins(self, farm_id, sampled_at)
        return self._legacy_device_twins_at(farm_id, sampled_at)

    def _legacy_device_twins_at(self, farm_id: str, sampled_at: datetime) -> list[ActuatorTwinState]:
        normalized_at = self._normalize_timestamp(sampled_at)
        field_by_device = {
            "root_zone_chiller": "cooling_enabled",
            "heater": "heating_enabled",
            "irrigation_pump": "irrigation_active",
            "ventilation_fan": "circulation_fan_pct",
            "roof_vent": "roof_vent_open_pct",
            "side_vent": "side_vent_open_pct",
            "shade_curtain": "thermal_curtain_pct",
            "air_temperature_sensor_reset": "air_temperature_sensor_recalibrated",
        }
        active_effects = {
            effect.device_id: effect
            for scenario_id in self._scenario_ids_at(farm_id, normalized_at)
            for effect in (
                self._scenario_profiles[scenario_id].device_effects
                if scenario_id in self._scenario_profiles
                else []
            )
        }
        activation = self._scenario_activation_at(farm_id, normalized_at)
        affected_zones = set(activation.zone_ids or ["zone-a"])
        twins: list[ActuatorTwinState] = []
        for zone_id in ("zone-a", "zone-b"):
            desired = self._actuator_state_at(
                farm_id,
                normalized_at,
                apply_scenario=False,
                zone_id=zone_id,
            )
            effective = self._actuator_state_at(
                farm_id,
                normalized_at,
                apply_scenario=True,
                zone_id=zone_id,
            )
            zone_overrides = self._actuator_overrides.get(farm_id, {}).get(zone_id, {})
            for device_id, field in field_by_device.items():
                sensor_reset = field == "air_temperature_sensor_recalibrated"
                desired_value = (
                    self._sensor_recalibrated_at(farm_id, normalized_at, zone_id)
                    if sensor_reset
                    else getattr(desired, field)
                )
                effective_value = (
                    desired_value
                    if sensor_reset
                    else getattr(effective, field)
                )
                events = [
                    (at, value)
                    for at, value in zone_overrides.get(field, [])
                    if at <= normalized_at and value is not None
                ]
                last_event = events[-1] if events else None
                reported_value: float | bool = effective_value
                effective_at = normalized_at
                mode = ActuatorMode.SCHEDULED
                commanded_at = None
                health = ActuatorHealth.NORMAL
                scenario_effect = active_effects.get(device_id) if zone_id in affected_zones else None
                sensor_fault_active = sensor_reset and zone_id in affected_zones and any(
                    scenario_id in {
                        DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
                        DemoScenarioId.TEMPERATURE_SENSOR_FAULT,
                    }
                    for scenario_id in self._scenario_ids_at(farm_id, normalized_at)
                )
                override_after_activation = bool(
                    last_event
                    and activation.applied_at is not None
                    and last_event[0] >= self._normalize_timestamp(activation.applied_at)
                )
                if scenario_effect is not None and not override_after_activation:
                    desired_value = scenario_effect.desired_value
                    health = ActuatorHealth(scenario_effect.health)
                    effective_at = (
                        self._normalize_timestamp(activation.applied_at)
                        + timedelta(seconds=scenario_effect.response_delay_seconds)
                        if activation.applied_at is not None
                        else normalized_at
                    )
                elif sensor_fault_active and not override_after_activation:
                    health = ActuatorHealth.FAULT
                elif last_event is not None:
                    commanded_at = last_event[0]
                    mode = ActuatorMode.MANUAL
                    elapsed = max(0.0, (normalized_at - last_event[0]).total_seconds())
                    response_seconds = 5.0
                    if elapsed < response_seconds:
                        previous_at = last_event[0] - timedelta(seconds=1)
                        previous_value = (
                            self._sensor_recalibrated_at(farm_id, previous_at, zone_id)
                            if sensor_reset
                            else getattr(
                                self._actuator_state_at(
                                    farm_id,
                                    previous_at,
                                    apply_scenario=True,
                                    zone_id=zone_id,
                                ),
                                field,
                            )
                        )
                        if isinstance(effective_value, bool):
                            reported_value = previous_value
                            effective_value = previous_value
                        else:
                            progress = elapsed / response_seconds
                            reported_value = float(previous_value) + (
                                float(effective_value) - float(previous_value)
                            ) * progress
                            effective_value = reported_value
                        effective_at = last_event[0] + timedelta(seconds=5)
                    else:
                        effective_at = last_event[0] + timedelta(seconds=5)
                unit = "boolean" if isinstance(desired_value, bool) else "%"
                twins.append(
                    ActuatorTwinState(
                        device_id=device_id,
                        instance_id=f"{zone_id}:{device_id}",
                        zone_id=zone_id,
                        desired_value=desired_value,
                        reported_value=reported_value,
                        effective_value=effective_value,
                        unit=unit,
                        mode=mode,
                        health=health,
                        commanded_at=commanded_at,
                        reported_at=normalized_at,
                        effective_at=effective_at,
                    )
                )
        return twins

    def _actuator_state_at(
        self,
        farm_id: str,
        sampled_at: datetime,
        *,
        apply_scenario: bool,
        zone_id: str = "zone-a",
    ) -> ActuatorState:
        self._farm(farm_id)
        local = self._normalize_timestamp(sampled_at).astimezone(KST)
        minutes = local.hour * 60 + local.minute
        solar = max(0.0, math.sin(math.pi * (minutes - 6 * 60) / (12 * 60)))
        state = {
            "roof_vent_open_pct": round(12 + 62 * solar, 1),
            "side_vent_open_pct": round(8 + 55 * solar, 1),
            "thermal_curtain_pct": round(92 - 84 * solar, 1),
            "circulation_fan_pct": round(25 + 55 * solar, 1),
            "irrigation_active": 8 * 60 <= minutes <= 17 * 60 and (minutes - 8 * 60) % (3 * 60) <= 5,
            "heating_enabled": solar < 0.12,
            "cooling_enabled": solar > 0.72,
        }
        normalized_at = self._normalize_timestamp(sampled_at)
        if apply_scenario:
            scenario_id = self._scenario_id_at(farm_id, normalized_at)
            scenario_factor = self._scenario_effect_factor(farm_id, normalized_at, zone_id)
            field_by_device = {
                "roof_vent": "roof_vent_open_pct",
                "side_vent": "side_vent_open_pct",
                "shade_curtain": "thermal_curtain_pct",
                "ventilation_fan": "circulation_fan_pct",
                "irrigation_pump": "irrigation_active",
                "heater": "heating_enabled",
                "root_zone_chiller": "cooling_enabled",
            }
            for active_id in self._scenario_ids_at(farm_id, normalized_at):
                profile = self._scenario_profiles.get(active_id)
                if profile is None:
                    continue
                effect_factor = self._scenario_profile_effect_factor(
                    farm_id, active_id, normalized_at, zone_id
                )
                for effect in profile.device_effects:
                    field = field_by_device[effect.device_id]
                    target = effect.effective_value
                    if isinstance(target, bool):
                        if effect_factor > 0:
                            state[field] = target
                    else:
                        state[field] = float(state[field]) + (
                            float(target) - float(state[field])
                        ) * effect_factor
            if scenario_id is DemoScenarioId.MOISTURE_LOW and scenario_factor > 0:
                state["irrigation_active"] = False
        for key, events in self._actuator_overrides.get(farm_id, {}).get(zone_id, {}).items():
            if key == "air_temperature_sensor_recalibrated":
                continue
            applicable = [(effective_at, value) for effective_at, value in events if normalized_at >= effective_at]
            if not applicable:
                continue
            effective_at, value = applicable[-1]
            if value is None:
                continue
            if (
                key == "irrigation_active"
                and value is True
                and (normalized_at - effective_at).total_seconds() >= IRRIGATION_CYCLE_SECONDS
            ):
                continue
            state[key] = value
        return ActuatorState(**state)

    def _duration_filtered_alerts(
        self,
        farm_id: str,
        alerts: list[TelemetryAlert],
        observed_at: datetime,
    ) -> list[TelemetryAlert]:
        timestamp = self._normalize_timestamp(observed_at)
        runtime = self._scenario_runtime(farm_id, timestamp)
        active_incident_alerts = {
            item.alert_id
            for item in self._incidents.get(farm_id, {}).values()
            if item.status is not IncidentStatus.RESOLVED
        }
        candidates = self._alert_candidates.setdefault(farm_id, {})
        filtered: list[TelemetryAlert] = []
        raw_ids = {item.alert_id for item in alerts}
        for alert in alerts:
            started_at = candidates.setdefault(alert.alert_id, timestamp)
            scenario_duration_satisfied = (
                runtime.scenario_id is not DemoScenarioId.NORMAL
                and runtime.elapsed_seconds >= self._alert_trigger_seconds
            )
            if (
                alert.severity is AlertSeverity.CRITICAL
                or alert.alert_id in active_incident_alerts
                or scenario_duration_satisfied
                or (timestamp - started_at).total_seconds() >= self._alert_trigger_seconds
            ):
                filtered.append(alert)
        for alert_id in set(candidates) - raw_ids:
            del candidates[alert_id]
        return filtered

    def _reconcile_incidents(
        self,
        farm_id: str,
        alerts: list[TelemetryAlert],
        observed_at: datetime,
    ) -> list[dict[str, object]]:
        timestamp = self._normalize_timestamp(observed_at)
        incidents = self._incidents.setdefault(farm_id, {})
        active_by_alert = {
            item.alert_id: item
            for item in incidents.values()
            if item.status is not IncidentStatus.RESOLVED
        }
        events: list[dict[str, object]] = []
        runtime = self._scenario_runtime(farm_id, timestamp)
        for alert in alerts:
            existing = active_by_alert.get(alert.alert_id)
            next_status = (
                IncidentStatus.RECOVERING
                if runtime.phase is DemoScenarioPhase.RECOVERY
                else IncidentStatus.OPEN
            )
            if existing is None:
                incident = IncidentRecord(
                    incident_id=f"incident-{alert.occurrence_id}",
                    alert_id=alert.alert_id,
                    occurrence_id=alert.occurrence_id,
                    farm_id=farm_id,
                    zone_id=alert.zone_id,
                    metric=alert.metric,
                    severity=alert.severity,
                    status=next_status,
                    message_ko=alert.message_ko,
                    opened_at=alert.occurred_at,
                    last_observed_at=timestamp,
                    recovering_at=timestamp if next_status is IncidentStatus.RECOVERING else None,
                    simulated_only=alert.simulated_only,
                )
                incidents[incident.incident_id] = incident
                active_by_alert[alert.alert_id] = incident
                events.append(incident.model_dump(mode="json"))
                continue
            updates: dict[str, object] = {
                "last_observed_at": timestamp,
                "severity": alert.severity,
                "message_ko": alert.message_ko,
            }
            if next_status is IncidentStatus.RECOVERING and existing.status is not IncidentStatus.RECOVERING:
                updates["status"] = IncidentStatus.RECOVERING
                updates["recovering_at"] = timestamp
            updated = existing.model_copy(update=updates)
            incidents[updated.incident_id] = updated
            active_by_alert[alert.alert_id] = updated
            if updated.status is not existing.status:
                events.append(updated.model_dump(mode="json"))

        current_alert_ids = {item.alert_id for item in alerts}
        clear_candidates = self._alert_clear_candidates.setdefault(farm_id, {})
        for alert_id, incident in list(active_by_alert.items()):
            if alert_id in current_alert_ids:
                clear_candidates.pop(alert_id, None)
                continue
            continuous = self._operating_runs.get(farm_id)
            if continuous:
                relevant = [r for r in continuous.get("readings", []) if r["zone_id"] == incident.zone_id and r["metric"] == incident.metric.value]
                if not relevant or any(r["quality"] != "good" or (timestamp-datetime.fromisoformat(r["observed_at"])).total_seconds() > 6 for r in relevant):
                    clear_candidates.pop(alert_id, None)
                    continue
            clear_started_at = clear_candidates.setdefault(alert_id, timestamp)
            clear_satisfied = (
                runtime.phase is DemoScenarioPhase.RECOVERED
                or (timestamp - clear_started_at).total_seconds() >= self._alert_clear_seconds
            )
            continuous = self._operating_runs.get(farm_id)
            if continuous:
                active_event = continuous.get("event")
                # Use the same output/quality/stability gate as the runtime.
                affected = {"heat":"air_temperature_c", "humidity":"relative_humidity_pct", "vent_fault":"relative_humidity_pct", "irrigation":"substrate_moisture_pct", "cooling_fault":"root_zone_temperature_c", "sensor_fault":"air_temperature_c"}
                if active_event and active_event["zone"] == incident.zone_id and affected[active_event["kind"]] == incident.metric.value:
                    clear_satisfied = False
            if clear_satisfied:
                resolved = incident.model_copy(
                    update={
                        "status": IncidentStatus.RESOLVED,
                        "last_observed_at": timestamp,
                        "resolved_at": timestamp,
                    }
                )
                incidents[resolved.incident_id] = resolved
                clear_candidates.pop(alert_id, None)
                events.append(resolved.model_dump(mode="json"))
            elif incident.status is not IncidentStatus.RECOVERING:
                recovering = incident.model_copy(
                    update={
                        "status": IncidentStatus.RECOVERING,
                        "last_observed_at": timestamp,
                        "recovering_at": timestamp,
                    }
                )
                incidents[recovering.incident_id] = recovering
                events.append(recovering.model_dump(mode="json"))
        return events

    def acknowledge_incident(
        self,
        farm_id: str,
        incident_id: str,
        acknowledged_at: datetime,
    ) -> IncidentRecord:
        with self._state_lock:
            self._farm(farm_id)
            incident = self._incidents.get(farm_id, {}).get(incident_id)
            if incident is None:
                raise ValueError("incident not found")
            if incident.status is IncidentStatus.RESOLVED:
                return incident
            updated = incident.model_copy(
                update={
                    "status": IncidentStatus.ACKNOWLEDGED,
                    "acknowledged_at": self._normalize_timestamp(acknowledged_at),
                }
            )
            self._incidents[farm_id][incident_id] = updated
            try:
                self._persist_state(incident_events=[updated.model_dump(mode="json")])
            except Exception:
                self._incidents[farm_id][incident_id] = incident
                raise
            return updated

    def alerts_for(
        self,
        farm_id: str,
        readings: list[SensorReading],
        observed_at: datetime,
        *,
        persist_occurrences: bool = True,
        reconcile_occurrences: bool = True,
        simulated_only: bool = True,
    ) -> list[TelemetryAlert]:
        thresholds: dict[SensorMetric, tuple[float | None, float | None, str, str]] = {
            SensorMetric.AIR_TEMPERATURE: (6.0, 20.0, "공기 온도가 시범 운영 recipe 상한을 벗어났습니다.", "공기 온도가 시범 운영 recipe 상한을 크게 벗어났습니다."),
            SensorMetric.RELATIVE_HUMIDITY: (55.0, 78.0, "상대습도가 시범 운영 recipe 범위를 벗어났습니다.", "상대습도가 시범 운영 recipe 범위를 크게 벗어났습니다."),
            SensorMetric.ROOT_ZONE_TEMPERATURE: (10.0, 20.0, "근권 온도가 시범 운영 recipe 범위를 벗어났습니다.", "근권 온도가 시범 운영 recipe 범위를 크게 벗어났습니다."),
            SensorMetric.SUPPLY_EC: (1.6, 2.6, "공급 EC가 시범 운영 recipe 범위를 벗어났습니다.", "공급 EC가 시범 운영 recipe 범위를 크게 벗어났습니다."),
            SensorMetric.DRAIN_EC: (1.8, 2.8, "배액 EC가 시범 운영 recipe 범위를 벗어났습니다.", "배액 EC가 시범 운영 recipe 범위를 크게 벗어났습니다."),
            SensorMetric.SUPPLY_PH: (5.7, 6.7, "공급 pH가 시범 운영 recipe 범위를 벗어났습니다.", "공급 pH가 시범 운영 recipe 범위를 크게 벗어났습니다."),
            SensorMetric.DRAIN_PH: (5.7, 6.8, "배액 pH가 시범 운영 recipe 범위를 벗어났습니다.", "배액 pH가 시범 운영 recipe 범위를 크게 벗어났습니다."),
            SensorMetric.SUBSTRATE_MOISTURE: (42.0, None, "배지 수분이 시범 운영 recipe 하한보다 낮습니다.", "배지 수분이 시범 운영 recipe 하한보다 크게 낮습니다."),
            SensorMetric.TANK_LEVEL: (20.0, None, "저장조 수위가 운영 하한보다 낮습니다.", "저장조 수위가 운영 하한보다 크게 낮습니다."),
            SensorMetric.CO2: (350.0, 1600.0, "CO₂ 농도가 시범 운영 recipe 범위를 벗어났습니다.", "CO₂ 농도가 시범 운영 recipe 범위를 크게 벗어났습니다."),
        }
        active_strategy = self._active_strategies.get(farm_id)
        recipe_thresholds = (
            {
                item.metric: (item.lower, item.upper)
                for item in active_strategy.thresholds
            }
            if active_strategy is not None
            else self._recipe_thresholds
        )
        for metric, limits in recipe_thresholds.items():
            if metric in thresholds:
                _lower, _upper, warning_message, critical_message = thresholds[metric]
                thresholds[metric] = (*limits, warning_message, critical_message)
        alerts: list[TelemetryAlert] = []
        timestamp = self._normalize_timestamp(observed_at)
        with self._alert_occurrence_lock:
            previous_occurrences = dict(self._alert_occurrences.get(farm_id, {}))

        def occurrence(alert_id: str) -> tuple[str, datetime]:
            if not reconcile_occurrences:
                existing = previous_occurrences.get(alert_id)
                if existing is not None:
                    return existing
                digest = hashlib.sha256(
                    f"{alert_id}|{timestamp.isoformat()}".encode("utf-8")
                ).hexdigest()[:32]
                return (f"observed-alert-occurrence-{digest}", timestamp)
            with self._alert_occurrence_lock:
                active = self._alert_occurrences.setdefault(farm_id, {})
                existing = active.get(alert_id)
                if existing is not None:
                    return existing
                occurrence_id = f"alert-occurrence-{uuid4().hex}"
                created = (occurrence_id, timestamp)
                active[alert_id] = created
                return created

        values_by_zone = {
            zone_id: {
                reading.metric: reading.value
                for reading in readings
                if reading.zone_id == zone_id
            }
            for zone_id in sorted({reading.zone_id for reading in readings})
        }
        runtime = self._scenario_runtime(farm_id, timestamp)
        affected_zones = set(runtime.zone_ids or ["zone-a"])
        invalid_air_zones: set[str] = set()
        for zone_id, values in values_by_zone.items():
            air_temperature = values.get(SensorMetric.AIR_TEMPERATURE)
            root_temperature = values.get(SensorMetric.ROOT_ZONE_TEMPERATURE)
            sensor_recovery_pending = (
                zone_id in affected_zones
                and runtime.scenario_id in {
                    DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
                    DemoScenarioId.TEMPERATURE_SENSOR_FAULT,
                }
                and runtime.phase is DemoScenarioPhase.RECOVERY
            )
            air_sensor_invalid = air_temperature is not None and (
                not -10.0 <= air_temperature <= 55.0
                or root_temperature is not None and abs(air_temperature - root_temperature) > 18.0
                or sensor_recovery_pending
            )
            if air_sensor_invalid and air_temperature is not None:
                invalid_air_zones.add(zone_id)
                physical_range_error = not -10.0 <= air_temperature <= 55.0
                alert_prefix = farm_id if zone_id == "zone-a" else f"{farm_id}:{zone_id}"
                alert_id = f"{alert_prefix}:{SensorMetric.AIR_TEMPERATURE}:sensor-health"
                occurrence_id, occurred_at = occurrence(alert_id)
                alerts.append(
                    TelemetryAlert(
                        alert_id=alert_id,
                        occurrence_id=occurrence_id,
                        farm_id=farm_id,
                        metric=SensorMetric.AIR_TEMPERATURE,
                        severity=AlertSeverity.CRITICAL if physical_range_error else AlertSeverity.WARNING,
                        status=AlertStatus.OPEN,
                        message_ko=(
                            "온도 센서 값이 물리 허용 범위를 벗어났습니다. 센서, 배선, 통신 상태를 먼저 점검하세요."
                            if physical_range_error
                            else "공기 온도와 근권 온도의 차이가 비정상적으로 큽니다. 작물 위험 판단 전에 센서 상태를 점검하세요."
                        ),
                        observed_value=air_temperature,
                        threshold=55.0 if physical_range_error and air_temperature > 55.0 else -10.0 if physical_range_error else 18.0,
                        occurred_at=occurred_at,
                        alert_kind="sensor_health",
                        simulated_only=simulated_only,
                        zone_id=zone_id,
                    )
                )

            flow = values.get(SensorMetric.IRRIGATION_FLOW)
            pump_current = values.get(SensorMetric.PUMP_CURRENT)
            interrupted_irrigation = (
                zone_id in affected_zones
                and runtime.scenario_id is DemoScenarioId.IRRIGATION_BLOCKAGE
                and runtime.phase not in {DemoScenarioPhase.NORMAL, DemoScenarioPhase.RECOVERED}
                and flow is not None
                and flow < 2.0
            )
            blocked_irrigation = (
                flow is not None
                and pump_current is not None
                and pump_current >= 2.0
                and flow < 2.0
            )
            if interrupted_irrigation or blocked_irrigation:
                alert_prefix = farm_id if zone_id == "zone-a" else f"{farm_id}:{zone_id}"
                alert_id = f"{alert_prefix}:irrigation-flow:crop-risk"
                occurrence_id, occurred_at = occurrence(alert_id)
                alerts.append(
                    TelemetryAlert(
                        alert_id=alert_id,
                        occurrence_id=occurrence_id,
                        farm_id=farm_id,
                        metric=SensorMetric.IRRIGATION_FLOW,
                        severity=AlertSeverity.WARNING if interrupted_irrigation else AlertSeverity.CRITICAL,
                        status=AlertStatus.OPEN,
                        message_ko=(
                            "관수 사이클이 중단되어 유량이 없습니다. 관수 펌프를 시작하고 배지 수분 회복을 확인하세요."
                            if interrupted_irrigation
                            else "펌프가 작동 중이지만 관수 유량이 낮습니다. 필터와 관수 라인을 점검하세요."
                        ),
                        observed_value=flow,
                        threshold=2.0,
                        occurred_at=occurred_at,
                        alert_kind="crop_risk",
                        simulated_only=simulated_only,
                        zone_id=zone_id,
                    )
                )

        for reading in readings:
            if reading.quality not in {SensorQuality.BAD, SensorQuality.STALE, SensorQuality.MISSING}:
                continue
            alert_prefix = farm_id if reading.zone_id == "zone-a" else f"{farm_id}:{reading.zone_id}"
            alert_id = f"{alert_prefix}:{reading.metric}:data-quality"
            occurrence_id, occurred_at = occurrence(alert_id)
            alerts.append(
                TelemetryAlert(
                    alert_id=alert_id,
                    occurrence_id=occurrence_id,
                    farm_id=farm_id,
                    metric=reading.metric,
                    severity=(
                        AlertSeverity.CRITICAL
                        if reading.quality is SensorQuality.MISSING
                        else AlertSeverity.WARNING
                    ),
                    status=AlertStatus.OPEN,
                    message_ko=(
                        "센서 관측값이 수신되지 않았습니다. 전원·배선·통신 상태를 확인하세요."
                        if reading.quality is SensorQuality.MISSING
                        else "센서 데이터 품질이 운영 판단 기준을 충족하지 않습니다."
                    ),
                    observed_value=reading.value,
                    threshold=0.0,
                    occurred_at=occurred_at,
                    alert_kind="sensor_health",
                    simulated_only=simulated_only,
                    zone_id=reading.zone_id,
                )
            )

        for reading in readings:
            if reading.quality in {SensorQuality.BAD, SensorQuality.STALE, SensorQuality.MISSING}:
                continue
            if reading.metric is SensorMetric.AIR_TEMPERATURE and reading.zone_id in invalid_air_zones:
                continue
            limits = thresholds.get(reading.metric)
            if limits is None:
                continue
            lower, upper, warning_message, critical_message = limits
            severity: AlertSeverity | None = None
            threshold: float | None = None
            direction: str | None = None
            alert_prefix = farm_id if reading.zone_id == "zone-a" else f"{farm_id}:{reading.zone_id}"
            active_incident_alerts = {
                item.alert_id
                for item in self._incidents.get(farm_id, {}).values()
                if item.status is not IncidentStatus.RESOLVED
            }
            if lower is not None and reading.value < lower:
                threshold = lower
                direction = "low"
                severity = AlertSeverity.CRITICAL if reading.value < lower * 0.8 else AlertSeverity.WARNING
            if upper is not None and reading.value > upper:
                threshold = upper
                direction = "high"
                severity = AlertSeverity.CRITICAL if reading.value >= upper * 1.1 else AlertSeverity.WARNING
            if (
                severity is None
                and lower is not None
                and f"{alert_prefix}:{reading.metric}:threshold:low" in active_incident_alerts
                and reading.value < lower * (1.0 + self._alert_hysteresis_ratio)
            ):
                threshold = lower
                direction = "low"
                severity = AlertSeverity.WARNING
            if (
                severity is None
                and upper is not None
                and f"{alert_prefix}:{reading.metric}:threshold:high" in active_incident_alerts
                and reading.value > upper * (1.0 - self._alert_hysteresis_ratio)
            ):
                threshold = upper
                direction = "high"
                severity = AlertSeverity.WARNING
            if severity is None or threshold is None or direction is None:
                continue
            message = critical_message if severity is AlertSeverity.CRITICAL else warning_message
            alert_id = f"{alert_prefix}:{reading.metric}:threshold:{direction}"
            occurrence_id, occurred_at = occurrence(alert_id)
            alerts.append(
                TelemetryAlert(
                    alert_id=alert_id,
                    occurrence_id=occurrence_id,
                    farm_id=farm_id,
                    metric=reading.metric,
                    severity=severity,
                    status=AlertStatus.OPEN,
                    message_ko=message,
                    observed_value=reading.value,
                    threshold=threshold,
                    occurred_at=occurred_at,
                    alert_kind="crop_risk",
                    simulated_only=simulated_only,
                    zone_id=reading.zone_id,
                )
            )
        previous_incidents = dict(self._incidents.get(farm_id, {}))
        previous_candidates = dict(self._alert_candidates.get(farm_id, {}))
        previous_clear_candidates = dict(self._alert_clear_candidates.get(farm_id, {}))
        if reconcile_occurrences:
            alerts = self._duration_filtered_alerts(farm_id, alerts, timestamp)
            incident_events = self._reconcile_incidents(farm_id, alerts, timestamp)
        else:
            incident_events = []
        candidates_changed = (
            self._alert_candidates.get(farm_id, {}) != previous_candidates
            or self._alert_clear_candidates.get(farm_id, {}) != previous_clear_candidates
        )
        occurrences_changed = False
        if reconcile_occurrences:
            with self._alert_occurrence_lock:
                active = self._alert_occurrences.get(farm_id, {})
                current_ids = {alert.alert_id for alert in alerts}
                for ended_alert_id in set(active) - current_ids:
                    del active[ended_alert_id]
                occurrences_changed = active != previous_occurrences
        if (occurrences_changed or incident_events or candidates_changed) and persist_occurrences:
            try:
                self._persist_state(incident_events=incident_events)
            except Exception:
                with self._alert_occurrence_lock:
                    if previous_occurrences:
                        self._alert_occurrences[farm_id] = previous_occurrences
                    else:
                        self._alert_occurrences.pop(farm_id, None)
                if previous_incidents:
                    self._incidents[farm_id] = previous_incidents
                else:
                    self._incidents.pop(farm_id, None)
                if previous_candidates:
                    self._alert_candidates[farm_id] = previous_candidates
                else:
                    self._alert_candidates.pop(farm_id, None)
                if previous_clear_candidates:
                    self._alert_clear_candidates[farm_id] = previous_clear_candidates
                else:
                    self._alert_clear_candidates.pop(farm_id, None)
                raise
        return alerts

    def timeseries(
        self,
        farm_id: str,
        metric: SensorMetric,
        start: datetime,
        end: datetime,
        interval_minutes: int,
        zone_id: Literal["zone-a", "zone-b"] = "zone-a",
    ) -> TimeseriesResponse:
        self._farm(farm_id)
        normalized_start = self._normalize_timestamp(start)
        normalized_end = self._normalize_timestamp(end)
        scenario = self.scenario_state(farm_id, normalized_end)
        ingress = self._ingested_telemetry.get(farm_id)
        if self._store is not None and (ingress is not None or farm_id in self._operating_runs):
            observations = self._store.observations(
                farm_id,
                metric.value,
                normalized_start.isoformat(),
                normalized_end.isoformat(),
                zone_id=zone_id,
            )
            if observations:
                source_counts: dict[str, int] = {}
                for item in observations:
                    source = str(item["source"])
                    source_counts[source] = source_counts.get(source, 0) + 1
                simulated_only = all(bool(item["simulated_only"]) for item in observations)
                sources = sorted(source_counts)
                # Stored observations arrive every tick; a chart asks for one point per
                # interval. Keep the latest reading of each interval (and so always the
                # newest reading) instead of sending every tick of a ten-hour window.
                observations = _latest_per_interval(observations, interval_minutes)
                data_source = (
                    f"ingress:{sources[0]}"
                    if len(sources) == 1
                    else "mixed:ingress:" + "+".join(sources)
                )
                return TimeseriesResponse(
                    farm_id=farm_id,
                    scenario_id=scenario.scenario_id,
                    scenario_applied_at=scenario.applied_at,
                    scenario_phase=scenario.phase,
                    scenario_elapsed_seconds=scenario.elapsed_seconds,
                    scenario_phase_started_at=scenario.phase_started_at,
                    metric=metric,
                    unit=METRIC_UNITS[metric],
                    start=normalized_start,
                    end=normalized_end,
                    interval_minutes=interval_minutes,
                    points=[
                        TimeseriesPoint(
                            timestamp=datetime.fromisoformat(str(item["observed_at"])),
                            value=float(item["value"]),
                            quality=SensorQuality(str(item["quality"])),
                            source=str(item["source"]),
                            zone_id=str(item["zone_id"]),
                            sensor_id=str(item["sensor_id"]),
                            simulated_only=bool(item["simulated_only"]),
                        )
                        for item in observations
                    ],
                    data_source=data_source,
                    simulated_only=simulated_only,
                    state_revision=self._state_revision,
                    ingress_metadata=self._ingress_metadata(ingress),
                    zone_id=zone_id,
                    source_counts=source_counts,
                )
        if farm_id in self._operating_runs:
            # An unobserved interval is empty, never backfilled from today's value.
            return TimeseriesResponse(farm_id=farm_id, metric=metric, unit=METRIC_UNITS[metric],
                start=normalized_start, end=normalized_end, interval_minutes=interval_minutes,
                points=[], data_source="continuous-synthetic-demo", simulated_only=True,
                state_revision=self._state_revision, zone_id=zone_id)
        points: list[TimeseriesPoint] = []
        cursor = normalized_start
        while cursor <= normalized_end:
            reading = next(
                item
                for item in self.readings_at(farm_id, cursor)
                if item.metric == metric and item.zone_id == zone_id
            )
            points.append(
                TimeseriesPoint(
                    timestamp=cursor,
                    value=reading.value,
                    zone_id=zone_id,
                    sensor_id=reading.sensor_id,
                )
            )
            cursor += timedelta(minutes=interval_minutes)
        data_source = "deterministic-simulator"
        simulated_only = True
        ingress_metadata = None
        if ingress is not None and abs((normalized_end - self._normalize_timestamp(ingress.timestamp)).total_seconds()) <= 300:
            incoming = next(
                (
                    reading
                    for reading in ingress.readings
                    if reading.metric is metric and reading.zone_id == zone_id
                ),
                None,
            )
            if incoming is not None and points:
                # Keep the latest chart point aligned with the same adapter value
                # shown in the current dashboard snapshot.
                points[-1] = TimeseriesPoint(
                    timestamp=normalized_end,
                    value=incoming.value,
                    quality=incoming.quality,
                    source=incoming.source or ingress.source,
                    zone_id=zone_id,
                    sensor_id=incoming.sensor_id,
                    simulated_only=ingress.simulated_only,
                )
                ingress_metadata = self._ingress_metadata(ingress)
                if ingress_metadata is not None and ingress_metadata.complete and ingress.simulated_only:
                    data_source = f"ingress:{ingress.source}"
                else:
                    data_source = f"mixed:ingress:{ingress.source}+deterministic-simulator"
                simulated_only = True
        return TimeseriesResponse(
            farm_id=farm_id,
            scenario_id=scenario.scenario_id,
            scenario_applied_at=scenario.applied_at,
            scenario_phase=scenario.phase,
            scenario_elapsed_seconds=scenario.elapsed_seconds,
            scenario_phase_started_at=scenario.phase_started_at,
            metric=metric,
            unit=METRIC_UNITS[metric],
            start=normalized_start,
            end=normalized_end,
            interval_minutes=interval_minutes,
            points=points,
            data_source=data_source,
            simulated_only=simulated_only,
            state_revision=self._state_revision,
            ingress_metadata=ingress_metadata,
            zone_id=zone_id,
            source_counts={data_source: len(points)},
        )

    def apply_simulated_command(
        self,
        command: SimulatedControlCommand,
        executed_at: datetime,
    ) -> ControlExecution:
        with self._state_lock:
            self._farm(command.farm_id)
            fingerprint = self._fingerprint(
                command.model_dump(
                    mode="json",
                    exclude={"proposal_id", "correlation_id"},
                )
            )
            existing = self._control_executions.get(command.proposal_id)
            if existing is None and self._store is not None:
                stored = self._store.control_execution(command.proposal_id)
                if stored is not None:
                    stored_fingerprint, stored_execution = stored
                    existing = (
                        stored_fingerprint,
                        ControlExecution.model_validate(stored_execution),
                    )
                    self._control_executions[command.proposal_id] = existing
            if existing is not None:
                existing_fingerprint, execution = existing
                if existing_fingerprint != fingerprint:
                    raise ControlProposalConflictError(
                        "proposal_id was already executed with a different control payload"
                    )
                return execution

            normalized_at = self._normalize_timestamp(executed_at)
            if command.alert_id is not None:
                current = self.snapshot(command.farm_id, normalized_at)
                if not any(
                    alert.alert_id == command.alert_id
                    and alert.occurrence_id == command.alert_occurrence_id
                    for alert in current.alerts
                ):
                    raise InvalidControlCommandError(
                        "The source alert occurrence is no longer active; request a fresh adjustment."
                    )
            value = command.target_value
            had_overrides = command.farm_id in self._actuator_overrides
            previous_overrides = {
                zone_id: {field: list(events) for field, events in fields.items()}
                for zone_id, fields in self._actuator_overrides.get(command.farm_id, {}).items()
            }
            overrides = self._actuator_overrides.setdefault(command.farm_id, {}).setdefault(
                command.zone_id,
                {},
            )
            mappings: dict[ControlAction, tuple[str, type]] = {
                ControlAction.SET_ROOF_VENT_OPEN_PERCENT: ("roof_vent_open_pct", float),
                ControlAction.SET_SIDE_VENT_OPEN_PERCENT: ("side_vent_open_pct", float),
                ControlAction.SET_THERMAL_CURTAIN_PERCENT: ("thermal_curtain_pct", float),
                ControlAction.SET_CIRCULATION_FAN_PERCENT: ("circulation_fan_pct", float),
                ControlAction.START_IRRIGATION_CYCLE: ("irrigation_active", bool),
                ControlAction.SET_HEATING_ENABLED: ("heating_enabled", bool),
                ControlAction.SET_COOLING_ENABLED: ("cooling_enabled", bool),
                ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR: ("air_temperature_sensor_recalibrated", bool),
            }
            target_field, expected_type = mappings[command.action]
            if command.action is ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR:
                if value is not True:
                    raise InvalidControlCommandError(
                        f"{command.action} requires target_value=true"
                    )
            elif expected_type is bool:
                if not isinstance(value, bool):
                    raise InvalidControlCommandError(f"{command.action} requires a boolean target_value")
            elif isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= float(value) <= 100:
                raise InvalidControlCommandError(f"{command.action} requires a percentage between 0 and 100")
            if command.action is ControlAction.SET_HEATING_ENABLED and value is True:
                overrides.setdefault("cooling_enabled", []).append((normalized_at, False))
            elif command.action is ControlAction.SET_COOLING_ENABLED and value is True:
                overrides.setdefault("heating_enabled", []).append((normalized_at, False))
            overrides.setdefault(target_field, []).append(
                (normalized_at, value if expected_type is bool else float(value))
            )
            self._state_revision += 1
            execution = ControlExecution(
                execution_id=f"sim-{command.proposal_id}",
                proposal_id=command.proposal_id,
                farm_id=command.farm_id,
                action=command.action,
                zone_id=command.zone_id,
                executed_at=normalized_at,
                correlation_id=command.correlation_id,
                actuator_state=self.actuator_state_at(
                    command.farm_id,
                    normalized_at,
                    command.zone_id,
                ),
                state_revision=self._state_revision,
            )
            run = self._operating_runs.get(command.farm_id)
            if run:
                run["history"].append({"kind": "approved_action", "run_id": run["run_id"],
                    "at": normalized_at.isoformat(), "command": command.model_dump(mode="json"),
                    "execution_id": execution.execution_id})
            try:
                self._persist_state(
                    execution=(command.proposal_id, fingerprint, execution)
                )
            except Exception:
                if run:
                    run["history"].pop()
                if had_overrides:
                    self._actuator_overrides[command.farm_id] = previous_overrides
                else:
                    self._actuator_overrides.pop(command.farm_id, None)
                self._state_revision -= 1
                raise
            self._control_executions[command.proposal_id] = (fingerprint, execution)
            return execution

    @staticmethod
    def _normalize_timestamp(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc, microsecond=0)
        return value.astimezone(timezone.utc).replace(microsecond=0)

    @staticmethod
    def _farm(farm_id: str) -> FarmInfo:
        try:
            return FARMS.get(farm_id) or LEGACY_FARMS[farm_id]
        except KeyError as error:
            raise UnknownFarmError(f"Unknown simulated farm: {farm_id}") from error


def _latest_per_interval(observations: list[dict[str, object]], interval_minutes: int) -> list[dict[str, object]]:
    """The last observation in each interval bucket, in time order."""
    if interval_minutes <= 0 or len(observations) < 2:
        return observations
    width = interval_minutes * 60
    buckets: dict[int, dict[str, object]] = {}
    for item in observations:
        at = datetime.fromisoformat(str(item["observed_at"])).timestamp()
        buckets[int(at // width)] = item
    return [buckets[key] for key in sorted(buckets)]
