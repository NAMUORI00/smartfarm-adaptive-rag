from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from app.main import create_app


FIXED_NOW = datetime(2026, 7, 16, 4, 30, tzinfo=timezone.utc)
FARM_ID = "farm-wasabi-a"
INTERNAL_HEADERS = {"X-Internal-Service-Token": "local-development-token"}


def make_client(now_provider=None) -> TestClient:
    return TestClient(create_app(now_provider=now_provider or (lambda: FIXED_NOW)))


def test_wasabi_farm_metadata_and_snapshot_are_available() -> None:
    client = make_client()
    farms = client.get("/v1/telemetry/farms")
    snapshot = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID})

    assert farms.status_code == 200
    assert farms.json() == [
        {
            "farm_id": FARM_ID,
            "name_ko": "고추냉이 고설베드 A동",
            "crop": "고추냉이",
            "greenhouse_type": "펄라이트 2단 고설베드 시설온실",
            "production_goal": "잎·잎자루",
            "cultivation_profile": "perlite_leaf_kr_v1",
            "simulated_only": True,
        }
    ]
    assert snapshot.status_code == 200
    assert snapshot.json()["simulated_only"] is True
    assert snapshot.json()["scenario_phase"] == "normal"
    assert snapshot.json()["scenario_elapsed_seconds"] == 0
    assert len(snapshot.json()["readings"]) == 40
    assert snapshot.json()["zones"] == ["zone-a", "zone-b"]


def test_historical_snapshot_does_not_rekey_current_alert_occurrence() -> None:
    clock = [FIXED_NOW]
    client = make_client(lambda: clock[0])
    activated = client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={
            "farm_id": FARM_ID,
            "scenario_id": "temperature_sensor_drift",
            "correlation_id": "historical-occurrence-test",
        },
    )
    assert activated.status_code == 200

    clock[0] = FIXED_NOW + timedelta(seconds=60)
    current = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID}).json()
    occurrence = next(
        alert["occurrence_id"]
        for alert in current["alerts"]
        if alert["alert_kind"] == "sensor_health"
    )
    historical = client.get(
        "/v1/telemetry/snapshot",
        params={"farm_id": FARM_ID, "at": FIXED_NOW.isoformat()},
    ).json()
    assert not any(alert["alert_kind"] == "sensor_health" for alert in historical["alerts"])

    clock[0] = FIXED_NOW + timedelta(seconds=61)
    refreshed = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID}).json()
    refreshed_occurrence = next(
        alert["occurrence_id"]
        for alert in refreshed["alerts"]
        if alert["alert_kind"] == "sensor_health"
    )
    assert refreshed_occurrence == occurrence


def test_series_rejects_invalid_time_range() -> None:
    response = make_client().get(
        "/v1/telemetry/series",
        params={
            "farm_id": FARM_ID,
            "metric": "air_temperature_c",
            "start": "2026-07-16T05:00:00Z",
            "end": "2026-07-16T04:00:00Z",
        },
    )

    assert response.status_code == 422


def test_series_returns_the_requested_zone_instead_of_the_first_metric_reading() -> None:
    client = make_client()
    params = {
        "farm_id": FARM_ID,
        "metric": "root_zone_temperature_c",
        "start": "2026-07-16T03:00:00Z",
        "end": "2026-07-16T04:00:00Z",
        "interval_minutes": 30,
    }
    zone_a = client.get("/v1/telemetry/series", params={**params, "zone_id": "zone-a"})
    zone_b = client.get("/v1/telemetry/series", params={**params, "zone_id": "zone-b"})

    assert zone_a.status_code == 200
    assert zone_b.status_code == 200
    assert zone_a.json()["zone_id"] == "zone-a"
    assert zone_b.json()["zone_id"] == "zone-b"
    assert {point["zone_id"] for point in zone_b.json()["points"]} == {"zone-b"}
    assert zone_a.json()["points"][-1]["value"] != zone_b.json()["points"][-1]["value"]


def test_internal_command_requires_token_and_changes_related_reading() -> None:
    client = make_client()
    payload = {
        "proposal_id": "proposal-1",
        "farm_id": FARM_ID,
        "action": "start_irrigation_cycle",
        "target_value": True,
        "requested_by": "operator-1",
    }
    before = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID}).json()
    denied = client.post("/v1/internal/simulated-control-commands", json=payload)
    allowed = client.post(
        "/v1/internal/simulated-control-commands",
        json=payload,
        headers={**INTERNAL_HEADERS, "X-Correlation-Id": "control-run-1"},
    )
    after = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID}).json()

    def value(snapshot: dict, metric: str) -> float:
        return next(item["value"] for item in snapshot["readings"] if item["metric"] == metric)

    assert denied.status_code == 401
    assert allowed.status_code == 200
    assert allowed.json()["simulated_only"] is True
    assert allowed.json()["correlation_id"] == "control-run-1"
    assert allowed.json()["actuator_state"]["irrigation_active"] is True
    assert value(after, "irrigation_flow_l_min") > value(before, "irrigation_flow_l_min")


def test_current_scenarios_are_listed_and_can_be_reset() -> None:
    clock = [FIXED_NOW]
    client = make_client(lambda: clock[0])
    definitions = client.get("/v1/telemetry/scenarios")
    activated = client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "scenario_id": "ec_drift", "correlation_id": "ec-demo-1"},
    )
    clock[0] = FIXED_NOW.replace(second=30)
    ramp = client.get("/v1/telemetry/scenario", params={"farm_id": FARM_ID})
    clock[0] = FIXED_NOW.replace(minute=31)
    hold = client.get("/v1/telemetry/scenario", params={"farm_id": FARM_ID})
    snapshot = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID})
    reset = client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "scenario_id": "normal", "correlation_id": "normal-demo-1"},
    )

    assert definitions.status_code == 200
    scenario_ids = {item["scenario_id"] for item in definitions.json()}
    assert scenario_ids.issuperset({
        "normal",
        "root_cooling_fault",
        "irrigation_blockage",
        "high_humidity_stagnation",
        "ec_drift",
        "temperature_sensor_drift",
    })
    assert {"tank_low", "ventilation_stuck", "sensor_dropout", "pump_flow_mismatch"}.issubset(
        scenario_ids
    )
    profile_names = {item["scenario_id"]: item["name_ko"] for item in definitions.json()}
    assert {
        key: profile_names[key]
        for key in (
            "normal",
            "root_cooling_fault",
            "irrigation_blockage",
            "high_humidity_stagnation",
            "ec_drift",
            "temperature_sensor_drift",
        )
    } == {
        "normal": "정상 운영 상태",
        "root_cooling_fault": "냉각기 정지",
            "irrigation_blockage": "관수 사이클 중단",
        "high_humidity_stagnation": "환기 설비 저출력",
        "ec_drift": "관수 부족·공급 편차",
        "temperature_sensor_drift": "온도 센서 이상",
    }
    assert all(item["description_ko"] for item in definitions.json())
    assert activated.json()["scenario_id"] == "ec_drift"
    assert activated.json()["correlation_id"] == "ec-demo-1"
    assert activated.json()["phase"] == "ramp"
    assert ramp.json()["phase"] == "ramp"
    assert ramp.json()["elapsed_seconds"] == 30
    assert hold.json()["phase"] == "hold"
    assert hold.json()["elapsed_seconds"] == 60
    assert snapshot.json()["scenario_phase"] == "hold"
    assert snapshot.json()["scenario_elapsed_seconds"] == 60
    assert reset.json()["scenario_id"] == "normal"
    assert reset.json()["phase"] == "normal"
    assert reset.json()["applied_at"] == "2026-07-16T04:31:00Z"


def test_crop_risk_and_sensor_health_alerts_are_distinct() -> None:
    clock = [FIXED_NOW]
    client = make_client(lambda: clock[0])
    client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "scenario_id": "irrigation_blockage"},
    )
    clock[0] = FIXED_NOW.replace(minute=31)
    crop_alerts = client.get("/v1/telemetry/alerts", params={"farm_id": FARM_ID}).json()
    client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "scenario_id": "temperature_sensor_drift"},
    )
    clock[0] = FIXED_NOW.replace(minute=32)
    sensor_alerts = client.get("/v1/telemetry/alerts", params={"farm_id": FARM_ID}).json()

    assert crop_alerts and all(alert["alert_kind"] == "crop_risk" for alert in crop_alerts)
    assert sensor_alerts and all(alert["alert_kind"] == "sensor_health" for alert in sensor_alerts)


def test_sensor_recalibration_command_recovers_drift_through_internal_api() -> None:
    clock = [FIXED_NOW]
    client = make_client(lambda: clock[0])
    client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "scenario_id": "temperature_sensor_drift"},
    )
    clock[0] = FIXED_NOW + timedelta(seconds=60)

    rejected = client.post(
        "/v1/internal/simulated-control-commands",
        headers=INTERNAL_HEADERS,
        json={
            "proposal_id": "sensor-reset-invalid",
            "farm_id": FARM_ID,
            "action": "recalibrate_air_temperature_sensor",
            "target_value": False,
            "requested_by": "operator-1",
        },
    )
    executed = client.post(
        "/v1/internal/simulated-control-commands",
        headers={**INTERNAL_HEADERS, "X-Correlation-Id": "sensor-reset-1"},
        json={
            "proposal_id": "sensor-reset-valid",
            "farm_id": FARM_ID,
            "action": "recalibrate_air_temperature_sensor",
            "target_value": True,
            "requested_by": "operator-1",
        },
    )
    recovering = client.get("/v1/telemetry/scenario", params={"farm_id": FARM_ID})
    clock[0] += timedelta(seconds=90)
    recovered = client.get("/v1/telemetry/scenario", params={"farm_id": FARM_ID})

    assert rejected.status_code == 422
    assert executed.status_code == 200
    assert executed.json()["action"] == "recalibrate_air_temperature_sensor"
    assert executed.json()["correlation_id"] == "sensor-reset-1"
    assert executed.json()["simulated_only"] is True
    assert "air_temperature_sensor_recalibrated" not in executed.json()["actuator_state"]
    assert recovering.json()["phase"] == "recovery"
    assert recovered.json()["phase"] == "recovered"


def test_partial_external_ingress_keeps_snapshot_marked_as_mixed_and_simulated() -> None:
    client = make_client()
    payload = {
        "farm_id": FARM_ID,
        "sampled_at": "2026-07-16T04:30:00Z",
        "source": "physical-gateway",
        "simulated_only": False,
        "readings": [{"metric": "root_zone_temperature_c", "value": 19.2, "unit": "°C"}],
    }

    denied = client.post("/v1/internal/telemetry/ingest", json=payload)
    accepted = client.post("/v1/internal/telemetry/ingest", headers=INTERNAL_HEADERS, json=payload)
    series = client.get(
        "/v1/telemetry/series",
        params={
            "farm_id": FARM_ID,
            "metric": "root_zone_temperature_c",
            "start": "2026-07-16T03:30:00Z",
            "end": "2026-07-16T04:30:00Z",
            "interval_minutes": 30,
        },
    )

    assert denied.status_code == 401
    assert accepted.status_code == 200
    assert accepted.json()["data_source"] == "mixed:ingress:physical-gateway+deterministic-simulator"
    assert accepted.json()["simulated_only"] is True
    assert next(item for item in accepted.json()["readings"] if item["metric"] == "root_zone_temperature_c")["value"] == 19.2
    assert series.status_code == 200
    assert series.json()["data_source"] == "mixed:ingress:physical-gateway+deterministic-simulator"
    assert series.json()["ingress_metadata"]["read_only"] is True
    assert series.json()["ingress_metadata"]["complete"] is False
    assert series.json()["points"][-1]["value"] == 19.2


def test_gateway_status_reports_latest_accepted_payload_quality() -> None:
    client = make_client()
    empty = client.get("/v1/telemetry/gateway-status", params={"farm_id": FARM_ID})
    accepted = client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json={
            "farm_id": FARM_ID,
            "observed_at": FIXED_NOW.isoformat(),
            "message_id": "gateway-quality-1",
            "sequence": 12,
            "source": "rs485-read-only",
            "simulated_only": False,
            "readings": [
                {
                    "metric": "root_zone_temperature_c",
                    "value": 14.2,
                    "unit": "°C",
                    "quality": "suspect",
                }
            ],
        },
    )
    status_response = client.get(
        "/v1/telemetry/gateway-status",
        params={"farm_id": FARM_ID},
    )

    assert empty.status_code == 200
    assert empty.json()["state"] == "not_connected"
    assert accepted.status_code == 200
    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert status_payload["state"] == "degraded"
    assert status_payload["read_only"] is True
    assert status_payload["source"] == "rs485-read-only"
    assert status_payload["message_id"] == "gateway-quality-1"
    assert status_payload["sequence"] == 12
    assert status_payload["quality_counts"] == {"suspect": 1}
    assert status_payload["duplicate_sensor_metrics"] == 0
    assert status_payload["unit_errors"] == 0
    assert "zone-a:air_temperature_c" in status_payload["missing_metrics"]


def test_ingress_validation_is_dry_run_and_rejections_are_explained() -> None:
    client = make_client()
    invalid = {
        "farm_id": FARM_ID,
        "observed_at": FIXED_NOW.isoformat(),
        "message_id": "invalid-unit-1",
        "source": "adapter-under-test",
        "readings": [
            {"metric": "root_zone_temperature_c", "value": 18.2, "unit": "F"}
        ],
    }

    validation = client.post(
        "/v1/internal/telemetry/validate",
        headers=INTERNAL_HEADERS,
        json=invalid,
    )
    before = client.get("/v1/telemetry/gateway-status", params={"farm_id": FARM_ID})
    rejected = client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json=invalid,
    )
    after = client.get("/v1/telemetry/gateway-status", params={"farm_id": FARM_ID})

    assert validation.status_code == 200
    assert validation.json()["valid"] is False
    assert before.json()["rejected_message_count"] == 0
    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "unit"
    assert after.json()["rejected_message_count"] == 1
    assert after.json()["unit_errors"] == 1
    assert after.json()["rejection_counts"] == {"unit": 1}
    assert after.json()["last_rejection_at"] == FIXED_NOW.isoformat().replace("+00:00", "Z")


def test_duplicate_sensor_rejection_is_counted_separately() -> None:
    client = make_client()
    reading = {"metric": "air_temperature_c", "value": 17.0, "unit": "°C"}
    rejected = client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json={
            "farm_id": FARM_ID,
            "observed_at": FIXED_NOW.isoformat(),
            "source": "adapter-under-test",
            "readings": [reading, reading],
        },
    )
    gateway = client.get("/v1/telemetry/gateway-status", params={"farm_id": FARM_ID})

    assert rejected.status_code == 422
    assert rejected.json()["detail"]["code"] == "duplicate_sensor"
    assert gateway.json()["duplicate_sensor_metrics"] == 1


def test_applied_cultivation_strategy_is_active_and_changes_alert_threshold() -> None:
    clock = [FIXED_NOW]
    client = make_client(lambda: clock[0])
    payload = {
        "farm_id": FARM_ID,
        "version_id": "2026.07.test.2",
        "growth_stage": "영양생장기",
        "thresholds": [
            {
                "metric": "air_temperature_c",
                "lower": 8.0,
                "upper": 15.0,
                "unit": "°C",
            }
        ],
        "evidence_source_ids": ["nongsaro-field-case-2026"],
        "change_note": "운영 기준 적용 시험",
        "applied_by": "operator-wasabi",
    }

    denied = client.put("/v1/internal/cultivation-strategy", json=payload)
    applied = client.put(
        "/v1/internal/cultivation-strategy",
        headers=INTERNAL_HEADERS,
        json=payload,
    )
    active = client.get(
        "/v1/internal/cultivation-strategy",
        headers=INTERNAL_HEADERS,
        params={"farm_id": FARM_ID},
    )
    clock[0] += timedelta(seconds=20)
    client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID})
    clock[0] += timedelta(seconds=10)
    snapshot = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID})

    assert denied.status_code == 401
    assert applied.status_code == 200
    assert active.json()["version_id"] == "2026.07.test.2"
    assert any(
        alert["metric"] == "air_temperature_c"
        for alert in snapshot.json()["alerts"]
    )


def test_alert_from_physical_ingress_is_not_marked_simulated() -> None:
    client = make_client()
    accepted = client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json={
            "farm_id": FARM_ID,
            "sampled_at": "2026-07-16T04:30:00Z",
            "source": "physical-gateway",
            "simulated_only": False,
            "readings": [
                {"metric": "air_temperature_c", "value": 31.0, "unit": "°C"}
            ],
        },
    )

    alerts = accepted.json()["alerts"]
    assert alerts
    assert all(alert["simulated_only"] is False for alert in alerts)


def test_complete_external_sensor_ingress_still_discloses_simulated_actuators() -> None:
    client = make_client()
    readings = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID}).json()["readings"]

    accepted = client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json={
            "farm_id": FARM_ID,
            "sampled_at": "2026-07-16T04:30:00Z",
            "source": "physical-gateway",
            "simulated_only": False,
            "readings": readings,
        },
    )

    assert accepted.status_code == 200
    assert accepted.json()["data_source"] == "mixed:ingress:physical-gateway+deterministic-actuators"
    assert accepted.json()["simulated_only"] is True


def test_legacy_farm_id_and_scenario_remain_accepted() -> None:
    client = make_client()
    activation = client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={"farm_id": "farm-strawberry-a", "scenario_id": "high_temperature"},
    )
    snapshot = client.get("/v1/telemetry/snapshot", params={"farm_id": "farm-strawberry-a"})

    assert activation.status_code == 200
    assert snapshot.status_code == 200
    assert snapshot.json()["farm"]["crop"] == "고추냉이"
