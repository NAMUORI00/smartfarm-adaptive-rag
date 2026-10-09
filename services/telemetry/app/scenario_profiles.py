from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from .contracts import ControlAction, DemoScenarioId, SensorMetric


class ParameterProvenance(BaseModel):
    source_id: str
    source_class: Literal[
        "public_source",
        "prototype_measurement",
        "site_recipe",
        "synthetic_assumption",
    ]
    locator: str | None = None
    note_ko: str


class ScenarioSensorEffect(BaseModel):
    metric: SensorMetric
    target_value: float
    mode: Literal["target", "delta"] = "target"
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"
    quality: Literal["good", "suspect", "bad", "missing"] = "good"


class ScenarioDeviceEffect(BaseModel):
    device_id: Literal[
        "roof_vent",
        "side_vent",
        "shade_curtain",
        "ventilation_fan",
        "irrigation_pump",
        "heater",
        "root_zone_chiller",
    ]
    desired_value: float | bool
    reported_value: float | bool
    effective_value: float | bool
    health: Literal["normal", "degraded", "fault", "offline"] = "fault"
    response_delay_seconds: int = Field(default=5, ge=0, le=300)
    zone_id: Literal["zone-a", "zone-b"] = "zone-a"


class ScenarioRecoveryRule(BaseModel):
    actions: list[ControlAction] = Field(default_factory=list, max_length=4)
    any_action_sufficient: bool = True
    minimum_percentage: float | None = Field(default=None, ge=0, le=100)
    stable_seconds: int = Field(default=90, ge=1, le=3_600)
    manual_action_ko: str | None = None

    @model_validator(mode="after")
    def validate_recovery_path(self) -> "ScenarioRecoveryRule":
        if not self.actions and not self.manual_action_ko:
            raise ValueError("recovery requires a typed action or a manual action")
        return self


class ScenarioProfile(BaseModel):
    scenario_id: DemoScenarioId
    name_ko: str
    description_ko: str
    category: Literal["normal", "climate", "irrigation", "nutrition", "sensor", "equipment"]
    ramp_seconds: int = Field(default=60, ge=0, le=3_600)
    recovery_seconds: int = Field(default=90, ge=1, le=3_600)
    supported_zones: list[Literal["zone-a", "zone-b"]] = Field(
        default_factory=lambda: ["zone-a"], min_length=1, max_length=2
    )
    sensor_effects: list[ScenarioSensorEffect] = Field(default_factory=list, max_length=12)
    device_effects: list[ScenarioDeviceEffect] = Field(default_factory=list, max_length=8)
    recovery: ScenarioRecoveryRule | None = None
    expected_alert_suffixes: list[str] = Field(default_factory=list, max_length=6)
    provenance: list[ParameterProvenance] = Field(min_length=1, max_length=8)

    @model_validator(mode="after")
    def validate_normal_profile(self) -> "ScenarioProfile":
        if self.scenario_id is DemoScenarioId.NORMAL:
            if self.category != "normal" or self.recovery is not None:
                raise ValueError("normal profile cannot define a recovery rule")
        elif self.recovery is None:
            raise ValueError("fault profiles require a recovery rule")
        return self


class ScenarioPack(BaseModel):
    pack_id: str
    version: str
    max_active_scenarios: Literal[2] = 2
    max_zones: Literal[2] = 2
    profiles: list[ScenarioProfile] = Field(min_length=6, max_length=20)

    @model_validator(mode="after")
    def validate_unique_ids(self) -> "ScenarioPack":
        ids = [item.scenario_id for item in self.profiles]
        if len(ids) != len(set(ids)):
            raise ValueError("scenario profile IDs must be unique")
        if DemoScenarioId.NORMAL not in ids:
            raise ValueError("scenario pack must include normal")
        return self

    def by_id(self) -> dict[DemoScenarioId, ScenarioProfile]:
        return {item.scenario_id: item for item in self.profiles}


def _default_pack_path() -> Path | None:
    configured = os.getenv("SCENARIO_PACK_PATH", "").strip()
    if configured:
        return Path(configured)
    source = Path(__file__).resolve()
    if len(source.parents) > 3:
        candidate = source.parents[3] / "data" / "scenarios" / "wasabi-prototype-v1.json"
        if candidate.exists():
            return candidate
    return None


def load_scenario_pack(path: str | Path | None = None) -> ScenarioPack:
    selected = Path(path) if path is not None else _default_pack_path()
    if selected is not None:
        return ScenarioPack.model_validate_json(selected.read_text(encoding="utf-8"))
    return ScenarioPack.model_validate(_fallback_pack_payload())


def _fallback_pack_payload() -> dict[str, object]:
    synthetic = {
        "source_id": "synthetic:wasabi:simulation-policy:v1",
        "source_class": "synthetic_assumption",
        "locator": "ramp and recovery policy",
        "note_ko": "반복 가능한 시연을 위한 합성 시간·효과 계수입니다.",
    }
    site_recipe = {
        "source_id": "nongsaro-field-case-2026",
        "source_class": "site_recipe",
        "locator": "perlite high-bed field reference",
        "note_ko": "고추냉이 고설베드 운영 범위의 방향성 근거입니다.",
    }

    def profile(
        scenario_id: str,
        name: str,
        description: str,
        category: str,
        *,
        sensors: list[dict[str, object]] | None = None,
        devices: list[dict[str, object]] | None = None,
        actions: list[str] | None = None,
        alerts: list[str] | None = None,
        provenance: list[dict[str, object]] | None = None,
        manual_action_ko: str | None = None,
    ) -> dict[str, object]:
        result: dict[str, object] = {
            "scenario_id": scenario_id,
            "name_ko": name,
            "description_ko": description,
            "category": category,
            "sensor_effects": sensors or [],
            "device_effects": devices or [],
            "expected_alert_suffixes": alerts or [],
            "provenance": provenance or [synthetic, site_recipe],
        }
        if actions:
            result["recovery"] = {"actions": actions, "stable_seconds": 90}
        elif manual_action_ko:
            result["recovery"] = {
                "actions": [],
                "stable_seconds": 90,
                "manual_action_ko": manual_action_ko,
            }
        return result

    profiles = [
        profile(
            "normal",
            "정상 운영 상태",
            "장치와 센서가 검토된 시범 recipe 범위에서 연결된 상태입니다.",
            "normal",
            provenance=[site_recipe],
        ),
        profile(
            "root_cooling_fault",
            "냉각기 정지",
            "냉각 출력이 사라져 근권 온도가 상승합니다.",
            "equipment",
            sensors=[{"metric": "root_zone_temperature_c", "target_value": 21.5}],
            devices=[{
                "device_id": "root_zone_chiller", "desired_value": True,
                "reported_value": False, "effective_value": False, "health": "fault",
                "response_delay_seconds": 0,
            }],
            actions=["set_cooling_enabled"],
            alerts=[":root_zone_temperature_c:threshold:high"],
        ),
        profile(
            "irrigation_blockage",
            "관수 사이클 중단",
            "관수 출력과 유량이 사라져 배지 수분이 낮아집니다.",
            "irrigation",
            sensors=[
                {"metric": "substrate_moisture_pct", "target_value": 39.0},
                {"metric": "irrigation_flow_l_min", "target_value": 0.0},
                {"metric": "irrigation_pressure_bar", "target_value": 0.15},
                {"metric": "pump_current_a", "target_value": 0.08},
            ],
            devices=[{
                "device_id": "irrigation_pump", "desired_value": True,
                "reported_value": False, "effective_value": False, "health": "fault",
                "response_delay_seconds": 0,
            }],
            actions=["start_irrigation_cycle"],
            alerts=[":irrigation-flow:crop-risk"],
        ),
        profile(
            "high_humidity_stagnation",
            "환기 설비 저출력",
            "환기 출력 저하로 습도가 상승합니다.",
            "climate",
            sensors=[{"metric": "relative_humidity_pct", "target_value": 94.0}],
            devices=[{
                "device_id": "ventilation_fan", "desired_value": 80.0,
                "reported_value": 8.0, "effective_value": 8.0, "health": "degraded",
                "response_delay_seconds": 0,
            }],
            actions=[
                "set_circulation_fan_percent",
                "set_roof_vent_open_percent",
                "set_side_vent_open_percent"
            ],
            alerts=[":relative_humidity_pct:threshold:high"],
        ),
        profile(
            "ec_drift",
            "관수 부족·공급 편차",
            "관수 부족으로 배지 수분이 낮아지고 공급·배액 EC가 상승합니다.",
            "nutrition",
            sensors=[
                {"metric": "supply_ec_ds_m", "target_value": 2.75},
                {"metric": "drain_ec_ds_m", "target_value": 3.05},
                {"metric": "substrate_moisture_pct", "target_value": 48.0},
                {"metric": "irrigation_flow_l_min", "target_value": 0.0},
                {"metric": "irrigation_pressure_bar", "target_value": 0.15},
                {"metric": "pump_current_a", "target_value": 0.08},
            ],
            devices=[{
                "device_id": "irrigation_pump", "desired_value": False,
                "reported_value": False, "effective_value": False, "health": "degraded",
                "response_delay_seconds": 0,
            }],
            actions=["start_irrigation_cycle"],
            alerts=[":supply_ec_ds_m:threshold:high", ":drain_ec_ds_m:threshold:high"],
        ),
        profile(
            "temperature_sensor_drift",
            "온도 센서 이상",
            "공기 온도 관측값에 편향이 누적됩니다.",
            "sensor",
            sensors=[{
                "metric": "air_temperature_c", "target_value": 23.0,
                "mode": "delta", "quality": "suspect",
            }],
            actions=["recalibrate_air_temperature_sensor"],
            alerts=[":air_temperature_c:sensor-health"],
        ),
        profile(
            "tank_low",
            "양액 탱크 저수위",
            "양액 탱크 수위가 운영 하한 아래로 내려갑니다.",
            "irrigation",
            sensors=[{"metric": "tank_level_pct", "target_value": 14.0}],
            manual_action_ko="양액 탱크를 보충하고 수위 센서를 확인합니다.",
            alerts=[":tank_level_pct:threshold:low"],
        ),
        profile(
            "ventilation_stuck",
            "환기창 고착",
            "개방 명령과 달리 환기창 실제 개도가 낮게 유지됩니다.",
            "equipment",
            sensors=[{"metric": "relative_humidity_pct", "target_value": 90.0}],
            devices=[{
                "device_id": "roof_vent", "desired_value": 70.0,
                "reported_value": 5.0, "effective_value": 5.0, "health": "fault",
            }],
            actions=["set_side_vent_open_percent", "set_circulation_fan_percent"],
            alerts=[":relative_humidity_pct:threshold:high"],
        ),
        profile(
            "sensor_dropout",
            "근권 온도 센서 결측",
            "근권 온도 센서가 관측값을 보내지 않습니다.",
            "sensor",
            sensors=[{
                "metric": "root_zone_temperature_c", "target_value": 0.0,
                "quality": "missing",
            }],
            manual_action_ko="근권 온도 센서 전원·배선·통신을 점검하고 교체합니다.",
            alerts=[":root_zone_temperature_c:data-quality"],
        ),
        profile(
            "pump_flow_mismatch",
            "펌프 작동·유량 불일치",
            "펌프 전류는 높지만 유량이 낮아 배관 막힘을 나타냅니다.",
            "equipment",
            sensors=[
                {"metric": "pump_current_a", "target_value": 4.5},
                {"metric": "irrigation_flow_l_min", "target_value": 0.8},
                {"metric": "irrigation_pressure_bar", "target_value": 2.6},
            ],
            devices=[{
                "device_id": "irrigation_pump", "desired_value": True,
                "reported_value": True, "effective_value": False, "health": "degraded",
            }],
            manual_action_ko="관수 라인과 필터를 점검하고 막힘을 제거합니다.",
            alerts=[":irrigation-flow:crop-risk"],
        ),
    ]
    return {
        "pack_id": "wasabi-prototype",
        "version": "2026.07.1",
        "max_active_scenarios": 2,
        "max_zones": 2,
        "profiles": profiles,
    }
