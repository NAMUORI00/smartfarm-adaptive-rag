"""Selective answer revision: an answer is split into units that declare, before it is written, which
observations they rest on; after the state changes only the units resting on a changed value are
rewritten. These tests use plain stand-ins for the farm snapshot."""
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timedelta, timezone

from app.answer_review_core import affected_units, declare_review, finish_initial, render_unit

NOW = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)


@dataclass
class Metric:
    key: str
    label: str
    value: float
    unit: str
    status: str = "normal"
    quality: str = "good"
    zone_id: str | None = "zone-a"
    observed_at: datetime = NOW


@dataclass
class Device:
    key: str
    zone_id: str | None = "zone-a"
    state: str = "off"
    desired_value: object = False
    feedback_at: str | None = None

    def model_dump(self, mode="json", exclude=frozenset()):
        return {k: v for k, v in asdict(self).items() if k not in exclude}


@dataclass
class Snapshot:
    metrics: list
    actuator_states: list
    active_alerts: list = field(default_factory=list)
    operational_control_allowed: bool = True
    data_origin: str = "telemetry_service"
    state_revision: int = 1


def farm(**changes):
    root = Metric("root_zone_temperature_c", "근권 온도", 15.1, "°C")
    air = Metric("air_temperature_c", "재배실 온도", 18.0, "°C")
    other = Metric("air_temperature_c", "재배실 온도", 19.0, "°C", zone_id="zone-b")
    snap = Snapshot([root, air, other], [Device("zone-a:root_zone_chiller")])
    return replace(snap, **changes)


def test_a_status_answer_rewrites_only_the_units_resting_on_a_changed_value():
    review = declare_review(farm(), "zone-a", "live_status", at=NOW)
    assert review["mode"] == "selective" and [u["id"] for u in review["units"]] == ["state", "action", "evidence"]
    # A normal reading moving inside its range is not a change of condition.
    drift = farm(metrics=[replace(farm().metrics[0], value=15.4), *farm().metrics[1:]])
    assert affected_units(review, drift, at=NOW) == []
    # The same reading crossing its range: the state, the action and the evidence all rest on it.
    hot = farm(metrics=[replace(farm().metrics[0], value=22.0, status="warning"), *farm().metrics[1:]])
    assert affected_units(review, hot, at=NOW) == ["state", "action", "evidence"]
    # A device change touches what the answer says and advises, not the observations it cites.
    switched = farm(actuator_states=[Device("zone-a:root_zone_chiller", state="on", desired_value=True)])
    assert affected_units(review, switched, at=NOW) == ["state", "action"]
    # Another zone's change does not concern this answer.
    elsewhere = farm(metrics=[*farm().metrics[:2], replace(farm().metrics[2], value=30.0, status="warning")])
    assert affected_units(review, elsewhere, at=NOW) == []


def test_a_reading_going_stale_or_suspect_is_a_change():
    review = declare_review(farm(), "zone-a", "live_status", at=NOW)
    later = NOW + timedelta(minutes=6)
    assert affected_units(review, farm(), at=later) == ["state", "action", "evidence"]
    suspect = farm(metrics=[farm().metrics[0], replace(farm().metrics[1], quality="bad"), farm().metrics[2]])
    assert "evidence" in affected_units(review, suspect, at=NOW)


def test_an_observation_the_answer_never_saw_means_a_full_review():
    review = declare_review(farm(), "zone-a", "live_status", at=NOW)
    added = farm(metrics=[*farm().metrics, Metric("substrate_moisture_pct", "배지 수분", 55, "%")])
    assert affected_units(review, added, at=NOW) == ["state", "action", "evidence"]


def test_a_general_growing_answer_does_not_follow_sensor_noise():
    review = declare_review(farm(), "zone-a", "knowledge", at=NOW)
    assert review["mode"] == "full" and all(u["depends_on"] in (["origin"], []) for u in review["units"])
    hot = farm(metrics=[replace(farm().metrics[0], value=22.0, status="warning"), *farm().metrics[1:]])
    assert affected_units(review, hot, at=NOW) == []
    assert affected_units(review, farm(data_origin="fallback"), at=NOW) == ["state", "action"]


def test_the_units_are_written_from_the_state_not_from_generated_text():
    hot = farm(metrics=[replace(farm().metrics[0], value=22.0, status="warning"), *farm().metrics[1:]])
    assert render_unit("state", hot, "zone-a", at=NOW) == "근권 온도 22°C (점검 필요)"
    assert render_unit("state", farm(), "zone-a", at=NOW).startswith("현재 수신된 구역 관측은 기준 범위")
    assert render_unit("state", farm(data_origin="fallback"), "zone-a", at=NOW).startswith("현재 관측 연결을 확인")
    review = finish_initial(declare_review(hot, "zone-a", "live_status", at=NOW), "모델의 답", [], None, hot, at=NOW)
    state, action, _evidence = review["units"]
    assert state["text"] == "근권 온도 22°C (점검 필요)" and action["text"].startswith("직접 조절은")
    assert declare_review(None, "zone-a", "live_status") is None
