from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.contracts import SensorMetric, SensorReading
from app.main import create_app
from app.simulator import KoreanGreenhouseSimulator


FARM_ID = "farm-wasabi-a"


def test_alert_occurrence_is_stable_until_resolution_and_changes_on_recurrence() -> None:
    simulator = KoreanGreenhouseSimulator()
    started_at = datetime(2026, 7, 21, 1, 0, tzinfo=timezone.utc)
    high_root_temperature = [
        SensorReading(metric=SensorMetric.ROOT_ZONE_TEMPERATURE, value=22.0, unit="°C")
    ]
    normal_root_temperature = [
        SensorReading(metric=SensorMetric.ROOT_ZONE_TEMPERATURE, value=16.0, unit="°C")
    ]

    first = simulator.alerts_for(FARM_ID, high_root_temperature, started_at)[0]
    ongoing = simulator.alerts_for(FARM_ID, high_root_temperature, started_at)[0]

    assert ongoing.alert_id == first.alert_id
    assert ongoing.occurrence_id == first.occurrence_id
    assert ongoing.occurred_at == first.occurred_at == started_at

    assert simulator.alerts_for(
        FARM_ID,
        normal_root_temperature,
        started_at,
    ) == []
    recurring = simulator.alerts_for(
        FARM_ID,
        high_root_temperature,
        started_at,
    )[0]

    assert recurring.alert_id == first.alert_id
    assert recurring.occurrence_id != first.occurrence_id
    assert recurring.occurred_at == started_at

    after_restart = KoreanGreenhouseSimulator().alerts_for(
        FARM_ID,
        high_root_temperature,
        started_at,
    )[0]
    assert after_restart.occurrence_id != first.occurrence_id


def test_telemetry_execution_rechecks_the_exact_active_alert_occurrence() -> None:
    clock = [datetime(2026, 7, 21, 1, 0, tzinfo=timezone.utc)]
    client = TestClient(create_app(now_provider=lambda: clock[0]))
    headers = {"X-Internal-Service-Token": "local-development-token"}

    client.post(
        "/v1/internal/demo-scenarios",
        headers=headers,
        json={"farm_id": FARM_ID, "scenario_id": "root_cooling_fault"},
    )
    clock[0] += timedelta(seconds=60)
    first_snapshot = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID}).json()
    first_alert = next(
        alert for alert in first_snapshot["alerts"]
        if "root_zone_temperature_c:threshold:high" in alert["alert_id"]
    )

    client.post(
        "/v1/internal/demo-scenarios",
        headers=headers,
        json={"farm_id": FARM_ID, "scenario_id": "normal"},
    )
    client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID})
    client.post(
        "/v1/internal/demo-scenarios",
        headers=headers,
        json={"farm_id": FARM_ID, "scenario_id": "root_cooling_fault"},
    )
    clock[0] += timedelta(seconds=60)
    recurring_snapshot = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID}).json()
    recurring_alert = next(
        alert for alert in recurring_snapshot["alerts"]
        if alert["alert_id"] == first_alert["alert_id"]
    )

    stale = client.post(
        "/v1/internal/simulated-control-commands",
        headers=headers,
        json={
            "proposal_id": "stale-alert-control",
            "farm_id": FARM_ID,
            "action": "set_cooling_enabled",
            "target_value": True,
            "requested_by": "operator-1",
            "alert_id": first_alert["alert_id"],
            "alert_occurrence_id": first_alert["occurrence_id"],
        },
    )
    fresh = client.post(
        "/v1/internal/simulated-control-commands",
        headers=headers,
        json={
            "proposal_id": "fresh-alert-control",
            "farm_id": FARM_ID,
            "action": "set_cooling_enabled",
            "target_value": True,
            "requested_by": "operator-1",
            "alert_id": recurring_alert["alert_id"],
            "alert_occurrence_id": recurring_alert["occurrence_id"],
        },
    )

    assert recurring_alert["occurrence_id"] != first_alert["occurrence_id"]
    assert stale.status_code == 422
    assert fresh.status_code == 200
    assert fresh.json()["actuator_state"]["cooling_enabled"] is True
