from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.contracts import (
    ControlAction,
    DemoScenarioId,
    SensorMetric,
    SensorReading,
    SimulatedControlCommand,
    TelemetryIngressRequest,
)
from app.main import create_app
from app.simulator import ControlProposalConflictError, KoreanGreenhouseSimulator


FIXED_AT = datetime(2026, 7, 16, 4, 30, tzinfo=timezone.utc)
FARM_ID = "farm-wasabi-a"
INTERNAL_HEADERS = {"X-Internal-Service-Token": "local-development-token"}


def irrigation_command(
    target_value: bool = True,
    zone_id: str = "zone-a",
) -> SimulatedControlCommand:
    return SimulatedControlCommand(
        proposal_id="durable-irrigation-1",
        farm_id=FARM_ID,
        action=ControlAction.START_IRRIGATION_CYCLE,
        target_value=target_value,
        zone_id=zone_id,
        requested_by="operator-1",
        correlation_id="durability-test",
    )


def ingress_request(
    message_id: str = "gateway-message-1",
    *,
    observed_at: datetime = FIXED_AT,
    sequence: int = 1,
    value: float = 19.2,
) -> TelemetryIngressRequest:
    return TelemetryIngressRequest(
        farm_id=FARM_ID,
        observed_at=observed_at,
        message_id=message_id,
        sequence=sequence,
        source="physical-gateway",
        simulated_only=False,
        readings=[
            SensorReading(
                metric=SensorMetric.ROOT_ZONE_TEMPERATURE,
                value=value,
                unit="°C",
            )
        ],
    )


def test_state_and_control_ledger_are_reconstructed_from_sqlite(tmp_path) -> None:
    state_path = tmp_path / "telemetry.db"
    first = KoreanGreenhouseSimulator(state_path)
    first.activate_scenario(
        FARM_ID,
        DemoScenarioId.IRRIGATION_BLOCKAGE,
        FIXED_AT,
        "durable-scenario",
    )
    execution = first.apply_simulated_command(
        irrigation_command(),
        FIXED_AT + timedelta(seconds=60),
    )
    first.ingest_telemetry(
        TelemetryIngressRequest(
            farm_id=FARM_ID,
            observed_at=FIXED_AT + timedelta(seconds=60),
            message_id="gateway-message-1",
            sequence=7,
            source="physical-gateway",
            simulated_only=False,
            readings=[
                SensorReading(
                    metric=SensorMetric.ROOT_ZONE_TEMPERATURE,
                    value=19.2,
                    unit="°C",
                )
            ],
        ),
        FIXED_AT + timedelta(seconds=60),
    )
    revision = first.snapshot(FARM_ID, FIXED_AT + timedelta(seconds=60)).state_revision

    restored = KoreanGreenhouseSimulator(state_path)
    snapshot = restored.snapshot(FARM_ID, FIXED_AT + timedelta(seconds=60))
    replay = restored.apply_simulated_command(
        irrigation_command(),
        FIXED_AT + timedelta(seconds=100),
    )

    assert snapshot.scenario_phase.value == "recovery"
    assert snapshot.actuator_state.irrigation_active is True
    assert snapshot.ingress_metadata is not None
    assert snapshot.ingress_metadata.message_id == "gateway-message-1"
    assert snapshot.ingress_metadata.read_only is True
    assert snapshot.state_revision == revision
    assert replay == execution
    assert restored.snapshot(FARM_ID, FIXED_AT + timedelta(seconds=181)).actuator_state.irrigation_active is False


def test_control_replay_is_idempotent_and_conflicting_payload_is_rejected(tmp_path) -> None:
    simulator = KoreanGreenhouseSimulator(tmp_path / "telemetry.db")
    first = simulator.apply_simulated_command(irrigation_command(), FIXED_AT)
    replay = simulator.apply_simulated_command(
        irrigation_command(),
        FIXED_AT + timedelta(seconds=100),
    )

    assert replay == first
    assert replay.state_revision == first.state_revision
    assert simulator.actuator_state_at(FARM_ID, FIXED_AT + timedelta(seconds=121)).irrigation_active is False
    with pytest.raises(ControlProposalConflictError):
        simulator.apply_simulated_command(
            irrigation_command(target_value=False),
            FIXED_AT + timedelta(seconds=101),
        )
    with pytest.raises(ControlProposalConflictError):
        simulator.apply_simulated_command(
            irrigation_command(zone_id="zone-b"),
            FIXED_AT + timedelta(seconds=102),
        )


def test_legacy_unscoped_overrides_migrate_to_zone_a(tmp_path) -> None:
    state_path = tmp_path / "legacy-telemetry.db"
    simulator = KoreanGreenhouseSimulator(state_path)
    assert simulator._store is not None
    simulator._store.save_state(
        1,
        {
            "actuator_overrides": {
                FARM_ID: {
                    "circulation_fan_pct": [[FIXED_AT.isoformat(), 0.0]],
                }
            }
        },
    )

    restored = KoreanGreenhouseSimulator(state_path)

    assert restored._actuator_overrides[FARM_ID]["zone-a"]["circulation_fan_pct"] == [
        (FIXED_AT, 0.0)
    ]
    assert restored.actuator_state_at(FARM_ID, FIXED_AT, "zone-a").circulation_fan_pct == 0
    assert restored.actuator_state_at(FARM_ID, FIXED_AT, "zone-b").circulation_fan_pct > 0


def test_control_conflict_returns_http_409(tmp_path) -> None:
    clock = [FIXED_AT]
    client = TestClient(create_app(lambda: clock[0], state_path=tmp_path / "telemetry.db"))
    payload = irrigation_command().model_dump(mode="json")

    first = client.post(
        "/v1/internal/simulated-control-commands",
        headers=INTERNAL_HEADERS,
        json=payload,
    )
    payload["target_value"] = False
    conflict = client.post(
        "/v1/internal/simulated-control-commands",
        headers=INTERNAL_HEADERS,
        json=payload,
    )

    assert first.status_code == 200
    assert conflict.status_code == 409


def test_ingress_rejects_ordering_conflicts_and_invalid_readings(tmp_path) -> None:
    client = TestClient(create_app(lambda: FIXED_AT, state_path=tmp_path / "telemetry.db"))

    def post(**updates):
        payload = {
            "farm_id": FARM_ID,
            "observed_at": FIXED_AT.isoformat(),
            "message_id": "message-1",
            "sequence": 10,
            "source": "physical-gateway",
            "simulated_only": False,
            "readings": [
                {"metric": "root_zone_temperature_c", "value": 19.2, "unit": "°C"}
            ],
        }
        payload.update(updates)
        return client.post(
            "/v1/internal/telemetry/ingest",
            headers=INTERNAL_HEADERS,
            json=payload,
        )

    accepted = post()
    replay = post()
    conflicting_id = post(readings=[
        {"metric": "root_zone_temperature_c", "value": 18.0, "unit": "°C"}
    ])
    older = post(
        message_id="message-2",
        sequence=11,
        observed_at=(FIXED_AT - timedelta(seconds=1)).isoformat(),
    )
    out_of_order = post(
        message_id="message-3",
        sequence=9,
        observed_at=FIXED_AT.isoformat(),
    )
    future = post(
        message_id="message-4",
        sequence=11,
        observed_at=(FIXED_AT + timedelta(seconds=1)).isoformat(),
    )
    duplicate_metrics = post(
        message_id="message-5",
        sequence=11,
        readings=[
            {"metric": "root_zone_temperature_c", "value": 19.2, "unit": "°C"},
            {"metric": "root_zone_temperature_c", "value": 19.3, "unit": "°C"},
        ],
    )
    wrong_unit = post(
        message_id="message-6",
        sequence=11,
        readings=[
            {"metric": "root_zone_temperature_c", "value": 19.2, "unit": "C"}
        ],
    )
    non_finite = post(
        message_id="message-7",
        sequence=11,
        readings=[
            {"metric": "root_zone_temperature_c", "value": "NaN", "unit": "°C"}
        ],
    )

    assert accepted.status_code == 200
    assert accepted.json()["ingress_metadata"] == {
        "message_id": "message-1",
        "sequence": 10,
        "observed_at": "2026-07-16T04:30:00Z",
        "source": "physical-gateway",
        "metric_count": 1,
        "complete": False,
        "mixed": True,
        "read_only": True,
        "zones": ["zone-a"],
        "quality_counts": {"good": 1},
    }
    assert replay.status_code == 200
    assert replay.json()["state_revision"] == accepted.json()["state_revision"]
    assert conflicting_id.status_code == 409
    assert older.status_code == 422
    assert out_of_order.status_code == 422
    assert future.status_code == 422
    assert duplicate_metrics.status_code == 422
    assert wrong_unit.status_code == 422
    assert non_finite.status_code == 422


def test_active_alert_occurrence_survives_restart_and_remains_actionable(tmp_path) -> None:
    state_path = tmp_path / "telemetry.db"
    first = KoreanGreenhouseSimulator(state_path)
    first.activate_scenario(
        FARM_ID,
        DemoScenarioId.ROOT_COOLING_FAULT,
        FIXED_AT,
        "durable-alert",
    )
    observed_at = FIXED_AT + timedelta(seconds=60)
    original_alert = next(
        alert
        for alert in first.snapshot(FARM_ID, observed_at).alerts
        if "root_zone_temperature_c:threshold:high" in alert.alert_id
    )

    restored = KoreanGreenhouseSimulator(state_path)
    restored_alert = next(
        alert
        for alert in restored.snapshot(FARM_ID, observed_at).alerts
        if alert.alert_id == original_alert.alert_id
    )
    execution = restored.apply_simulated_command(
        SimulatedControlCommand(
            proposal_id="durable-alert-control",
            farm_id=FARM_ID,
            action=ControlAction.SET_COOLING_ENABLED,
            target_value=True,
            requested_by="operator-1",
            alert_id=original_alert.alert_id,
            alert_occurrence_id=original_alert.occurrence_id,
            correlation_id="durable-alert-test",
        ),
        observed_at,
    )

    assert restored_alert.occurrence_id == original_alert.occurrence_id
    assert restored_alert.occurred_at == original_alert.occurred_at
    assert execution.actuator_state.cooling_enabled is True


def test_ingress_response_uses_the_persisted_alert_occurrence(tmp_path) -> None:
    state_path = tmp_path / "telemetry.db"
    simulator = KoreanGreenhouseSimulator(state_path)
    payload = ingress_request(value=1.0)

    accepted = simulator.ingest_telemetry(payload, FIXED_AT)
    accepted_alert = next(
        alert
        for alert in accepted.alerts
        if alert.metric is SensorMetric.ROOT_ZONE_TEMPERATURE
    )
    current_alert = next(
        alert
        for alert in simulator.snapshot(FARM_ID, FIXED_AT).alerts
        if alert.alert_id == accepted_alert.alert_id
    )
    restored_alert = next(
        alert
        for alert in KoreanGreenhouseSimulator(state_path).snapshot(FARM_ID, FIXED_AT).alerts
        if alert.alert_id == accepted_alert.alert_id
    )

    assert current_alert.occurrence_id == accepted_alert.occurrence_id
    assert restored_alert.occurrence_id == accepted_alert.occurrence_id
    assert restored_alert.occurred_at == accepted_alert.occurred_at


def test_control_save_failure_rolls_back_state_and_allows_clean_retry(
    tmp_path,
    monkeypatch,
) -> None:
    state_path = tmp_path / "telemetry.db"
    simulator = KoreanGreenhouseSimulator(state_path)
    assert simulator._store is not None
    original_save = simulator._store.save_state
    failed = False

    def fail_once(*args, **kwargs):
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("injected sqlite failure")
        return original_save(*args, **kwargs)

    monkeypatch.setattr(simulator._store, "save_state", fail_once)

    with pytest.raises(OSError, match="injected sqlite failure"):
        simulator.apply_simulated_command(irrigation_command(), FIXED_AT)

    assert simulator._state_revision == 0
    assert irrigation_command().proposal_id not in simulator._control_executions
    assert FARM_ID not in simulator._actuator_overrides

    execution = simulator.apply_simulated_command(irrigation_command(), FIXED_AT)
    restored = KoreanGreenhouseSimulator(state_path)

    assert execution.state_revision == 1
    assert restored.apply_simulated_command(irrigation_command(), FIXED_AT) == execution
    assert len(restored._actuator_overrides[FARM_ID]["zone-a"]["irrigation_active"]) == 1


def test_ingress_save_failure_rolls_back_state_and_allows_clean_retry(
    tmp_path,
    monkeypatch,
) -> None:
    state_path = tmp_path / "telemetry.db"
    simulator = KoreanGreenhouseSimulator(state_path)
    payload = ingress_request()
    assert simulator._store is not None
    original_save = simulator._store.save_state
    failed = False

    def fail_once(*args, **kwargs):
        nonlocal failed
        if not failed:
            failed = True
            raise OSError("injected sqlite failure")
        return original_save(*args, **kwargs)

    monkeypatch.setattr(simulator._store, "save_state", fail_once)

    with pytest.raises(OSError, match="injected sqlite failure"):
        simulator.ingest_telemetry(payload, FIXED_AT)

    assert simulator._state_revision == 0
    assert FARM_ID not in simulator._ingested_telemetry
    assert payload.message_id not in simulator._ingress_fingerprints
    assert payload.message_id not in simulator._ingress_acceptances

    accepted = simulator.ingest_telemetry(payload, FIXED_AT)
    restored = KoreanGreenhouseSimulator(state_path)

    assert accepted.state_revision == 1
    assert simulator.ingest_telemetry(payload, FIXED_AT) == accepted
    assert restored.ingest_telemetry(payload, FIXED_AT) == accepted


def test_scenario_save_failure_rolls_back_every_in_memory_mutation(
    tmp_path,
    monkeypatch,
) -> None:
    state_path = tmp_path / "telemetry.db"
    simulator = KoreanGreenhouseSimulator(state_path)
    simulator.activate_scenario(
        FARM_ID,
        DemoScenarioId.ROOT_COOLING_FAULT,
        FIXED_AT - timedelta(minutes=2),
        "existing-scenario",
    )
    simulator._actuator_overrides[FARM_ID] = {
        "zone-a": {"cooling_enabled": [(FIXED_AT - timedelta(minutes=1), True)]}
    }
    existing_ingress = ingress_request()
    simulator._ingested_telemetry[FARM_ID] = existing_ingress
    assert simulator._store is not None

    def fail_save(*_args, **_kwargs):
        raise OSError("injected scenario save failure")

    monkeypatch.setattr(simulator._store, "save_state", fail_save)

    with pytest.raises(OSError, match="injected scenario save failure"):
        simulator.activate_scenario(
            FARM_ID,
            DemoScenarioId.NORMAL,
            FIXED_AT,
            "scenario-save-failure",
        )

    assert simulator._state_revision == 1
    assert simulator.scenario_state(FARM_ID).scenario_id is DemoScenarioId.ROOT_COOLING_FAULT
    assert simulator._actuator_overrides[FARM_ID]["zone-a"]["cooling_enabled"] == [
        (FIXED_AT - timedelta(minutes=1), True)
    ]
    assert simulator._ingested_telemetry[FARM_ID] == existing_ingress
    assert len(simulator._scenario_history[FARM_ID]) == 1
    restored = KoreanGreenhouseSimulator(state_path)
    assert restored._state_revision == 1
    assert restored.scenario_state(FARM_ID).scenario_id is DemoScenarioId.ROOT_COOLING_FAULT


def test_old_ingress_replay_returns_its_original_response_after_newer_message(
    tmp_path,
) -> None:
    state_path = tmp_path / "telemetry.db"
    first_client = TestClient(
        create_app(lambda: FIXED_AT + timedelta(seconds=2), state_path=state_path)
    )
    first_payload = ingress_request().model_dump(mode="json")
    second_payload = ingress_request(
        "gateway-message-2",
        observed_at=FIXED_AT + timedelta(seconds=1),
        sequence=2,
        value=18.4,
    ).model_dump(mode="json")

    first = first_client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json=first_payload,
    )
    second = first_client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json=second_payload,
    )
    replay = first_client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json=first_payload,
    )
    restored_client = TestClient(
        create_app(lambda: FIXED_AT + timedelta(seconds=2), state_path=state_path)
    )
    replay_after_restart = restored_client.post(
        "/v1/internal/telemetry/ingest",
        headers=INTERNAL_HEADERS,
        json=first_payload,
    )

    assert first.status_code == second.status_code == replay.status_code == 200
    assert second.json()["state_revision"] > first.json()["state_revision"]
    assert second.json()["ingress_metadata"]["message_id"] == "gateway-message-2"
    assert replay.json() == first.json()
    assert replay_after_restart.json() == first.json()
