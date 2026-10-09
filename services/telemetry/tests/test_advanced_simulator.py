from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.contracts import (
    ControlAction,
    DemoScenarioId,
    IncidentStatus,
    SensorMetric,
    SensorReading,
    SimulatedControlCommand,
    TelemetryIngressRequest,
)
from app.main import create_app
from app.scenario_profiles import load_scenario_pack
from app.simulator import KoreanGreenhouseSimulator


FARM_ID = "farm-wasabi-a"
FIXED_AT = datetime(2026, 7, 16, 4, 30, tzinfo=timezone.utc)
INTERNAL_HEADERS = {"X-Internal-Service-Token": "local-development-token"}


def command(
    simulator: KoreanGreenhouseSimulator,
    action: ControlAction,
    value: float | bool,
    at: datetime,
    proposal_id: str,
) -> None:
    simulator.apply_simulated_command(
        SimulatedControlCommand(
            proposal_id=proposal_id,
            farm_id=FARM_ID,
            action=action,
            target_value=value,
            requested_by="operator-local",
        ),
        at,
    )


def test_scenario_pack_is_fixed_versioned_and_provenance_linked() -> None:
    pack = load_scenario_pack()

    assert pack.pack_id == "wasabi-prototype"
    assert pack.max_active_scenarios == 2
    assert pack.max_zones == 2
    assert len(pack.profiles) == 10
    assert len({item.scenario_id for item in pack.profiles}) == len(pack.profiles)
    assert all(item.provenance for item in pack.profiles)
    assert {
        DemoScenarioId.TANK_LOW,
        DemoScenarioId.VENTILATION_STUCK,
        DemoScenarioId.SENSOR_DROPOUT,
        DemoScenarioId.PUMP_FLOW_MISMATCH,
    }.issubset(pack.by_id())


def test_external_observations_are_append_only_and_drive_real_series_after_restart(tmp_path) -> None:
    state_path = tmp_path / "telemetry.db"
    simulator = KoreanGreenhouseSimulator(state_path)
    for sequence, value in ((1, 18.7), (2, 19.2)):
        observed_at = FIXED_AT + timedelta(minutes=sequence - 1)
        simulator.ingest_telemetry(
            TelemetryIngressRequest(
                farm_id=FARM_ID,
                observed_at=observed_at,
                message_id=f"physical-{sequence}",
                sequence=sequence,
                source="physical-gateway",
                simulated_only=False,
                readings=[
                    SensorReading(
                        metric=SensorMetric.ROOT_ZONE_TEMPERATURE,
                        value=value,
                        unit="°C",
                        sensor_id="root-zone-probe-01",
                        source="rs485-gateway",
                        observed_at=observed_at,
                    )
                ],
            ),
            received_at=observed_at,
        )

    restored = KoreanGreenhouseSimulator(state_path)
    series = restored.timeseries(
        FARM_ID,
        SensorMetric.ROOT_ZONE_TEMPERATURE,
        FIXED_AT,
        FIXED_AT + timedelta(minutes=1),
        1,
    )

    assert [item.value for item in series.points] == [18.7, 19.2]
    assert all(item.simulated_only is False for item in series.points)
    assert all(item.source == "rs485-gateway" for item in series.points)
    assert all(item.sensor_id == "root-zone-probe-01" for item in series.points)
    assert series.data_source == "ingress:rs485-gateway"
    assert series.source_counts == {"rs485-gateway": 2}


def test_virtual_clock_accelerates_pauses_and_resets_without_wall_clock_sleep(tmp_path) -> None:
    wall = [FIXED_AT]
    client = TestClient(create_app(lambda: wall[0], state_path=tmp_path / "clock.db"))

    accelerated = client.patch(
        "/v1/internal/telemetry/clock",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "speed": 10, "paused": False, "seed": 2048},
    )
    wall[0] += timedelta(seconds=6)
    advanced = client.get("/v1/telemetry/clock", params={"farm_id": FARM_ID})
    paused = client.patch(
        "/v1/internal/telemetry/clock",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "paused": True},
    )
    wall[0] += timedelta(minutes=5)
    still_paused = client.get("/v1/telemetry/clock", params={"farm_id": FARM_ID})
    reset_to = FIXED_AT - timedelta(hours=2)
    reset = client.patch(
        "/v1/internal/telemetry/clock",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "speed": 1, "paused": True, "reset_to": reset_to.isoformat()},
    )

    assert accelerated.status_code == 200
    assert advanced.status_code == 200
    advanced_virtual = FIXED_AT + timedelta(seconds=60)
    assert datetime.fromisoformat(advanced.json()["virtual_anchor"]) == advanced_virtual
    assert datetime.fromisoformat(paused.json()["virtual_anchor"]) == advanced_virtual
    assert still_paused.json()["virtual_anchor"] == paused.json()["virtual_anchor"]
    assert reset.json()["virtual_anchor"] == reset_to.isoformat().replace("+00:00", "Z")
    assert reset.json()["seed"] == 2048
    restored = TestClient(create_app(lambda: wall[0], state_path=tmp_path / "clock.db"))
    restored_clock = restored.get("/v1/telemetry/clock", params={"farm_id": FARM_ID}).json()
    assert restored_clock["paused"] is True
    assert restored_clock["virtual_anchor"] == reset.json()["virtual_anchor"]
    assert restored_clock["seed"] == 2048


def test_snapshot_clock_keeps_wall_and_virtual_anchors_separate_at_10x(tmp_path) -> None:
    wall = [FIXED_AT]
    client = TestClient(create_app(lambda: wall[0], state_path=tmp_path / "snapshot-clock.db"))
    client.patch(
        "/v1/internal/telemetry/clock",
        headers=INTERNAL_HEADERS,
        json={"farm_id": FARM_ID, "speed": 10, "paused": False},
    )
    wall[0] += timedelta(seconds=6)

    response = client.get("/v1/telemetry/snapshot", params={"farm_id": FARM_ID})

    assert response.status_code == 200
    payload = response.json()
    assert datetime.fromisoformat(payload["clock"]["wall_anchor"]) == wall[0]
    assert datetime.fromisoformat(payload["clock"]["virtual_anchor"]) == FIXED_AT + timedelta(seconds=60)
    assert payload["clock"]["virtual_anchor"] == payload["sampled_at"]


def test_replay_endpoint_preserves_each_observation_and_resets_clock(tmp_path) -> None:
    client = TestClient(create_app(lambda: FIXED_AT + timedelta(hours=1), state_path=tmp_path / "replay.db"))
    observations = []
    for sequence, value in ((1, 17.8), (2, 18.1)):
        observed_at = FIXED_AT + timedelta(minutes=sequence - 1)
        observations.append(
            {
                "farm_id": FARM_ID,
                "observed_at": observed_at.isoformat(),
                "message_id": f"replay-{sequence}",
                "sequence": sequence,
                "source": "prototype-log",
                "simulated_only": False,
                "readings": [
                    {
                        "metric": "root_zone_temperature_c",
                        "value": value,
                        "unit": "°C",
                        "sensor_id": "prototype-root-01",
                    }
                ],
            }
        )

    replay = client.post(
        "/v1/internal/telemetry/replay",
        headers=INTERNAL_HEADERS,
        json={
            "farm_id": FARM_ID,
            "observations": observations,
            "reset_clock_to_first_observation": True,
        },
    )
    series = client.get(
        "/v1/telemetry/series",
        params={
            "farm_id": FARM_ID,
            "metric": "root_zone_temperature_c",
            "start": FIXED_AT.isoformat(),
            "end": (FIXED_AT + timedelta(minutes=1)).isoformat(),
            "interval_minutes": 1,
        },
    )
    clock = client.get("/v1/telemetry/clock", params={"farm_id": FARM_ID})

    assert replay.status_code == 200
    assert replay.json()["accepted_observations"] == 2
    assert replay.json()["simulated_only"] is False
    assert [item["value"] for item in series.json()["points"]] == [17.8, 18.1]
    assert clock.json()["paused"] is True
    assert clock.json()["virtual_anchor"] == FIXED_AT.isoformat().replace("+00:00", "Z")


def test_separate_replay_uploads_without_sequences_remain_appendable(tmp_path) -> None:
    client = TestClient(create_app(lambda: FIXED_AT + timedelta(hours=1), state_path=tmp_path / "replay-batches.db"))

    responses = []
    for batch, value in enumerate((17.2, 17.5)):
        observed_at = FIXED_AT + timedelta(minutes=batch)
        responses.append(
            client.post(
                "/v1/internal/telemetry/replay",
                headers=INTERNAL_HEADERS,
                json={
                    "farm_id": FARM_ID,
                    "observations": [
                        {
                            "farm_id": FARM_ID,
                            "observed_at": observed_at.isoformat(),
                            "message_id": f"batch-{batch}",
                            "source": "operator-record-replay",
                            "simulated_only": False,
                            "readings": [
                                {
                                    "metric": "air_temperature_c",
                                    "value": value,
                                    "unit": "°C",
                                    "sensor_id": "temp-a",
                                },
                                *(
                                    [
                                        {
                                            "metric": "relative_humidity_pct",
                                            "value": 71.0,
                                            "unit": "%",
                                            "sensor_id": "humidity-a",
                                        }
                                    ]
                                    if batch == 0
                                    else []
                                ),
                            ],
                        }
                    ],
                },
            )
        )

    assert [response.status_code for response in responses] == [200, 200]
    assert [response.json()["accepted_observations"] for response in responses] == [1, 1]
    series = client.get(
        "/v1/telemetry/series",
        params={
            "farm_id": FARM_ID,
            "metric": "air_temperature_c",
            "start": FIXED_AT.isoformat(),
            "end": (FIXED_AT + timedelta(minutes=1)).isoformat(),
            "interval_minutes": 1,
        },
    ).json()
    assert [point["value"] for point in series["points"]] == [17.2, 17.5]

    reset = client.post(
        "/v1/internal/demo-scenarios",
        headers=INTERNAL_HEADERS,
        json={
            "farm_id": FARM_ID,
            "scenario_id": "normal",
            "zone_ids": ["zone-a", "zone-b"],
            "correlation_id": "replay-reset",
        },
    )
    reset_series = client.get(
        "/v1/telemetry/series",
        params={
            "farm_id": FARM_ID,
            "metric": "air_temperature_c",
            "start": FIXED_AT.isoformat(),
            "end": (FIXED_AT + timedelta(minutes=1)).isoformat(),
            "interval_minutes": 1,
        },
    ).json()

    assert reset.status_code == 200
    assert reset_series["data_source"] == "deterministic-simulator"
    assert len(reset_series["points"]) == 2
    assert [point["value"] for point in reset_series["points"]] != [17.2, 17.5]


def test_device_twin_separates_desired_reported_and_effective_state() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(
        FARM_ID,
        DemoScenarioId.ROOT_COOLING_FAULT,
        FIXED_AT,
        "root-cooling-twin",
    )
    fault_at = FIXED_AT + timedelta(seconds=60)
    fault_twin = next(
        item
        for item in simulator.snapshot(FARM_ID, fault_at).device_twins
        if item.device_id == "root_zone_chiller"
    )

    command(
        simulator,
        ControlAction.SET_COOLING_ENABLED,
        True,
        fault_at,
        "recover-root-cooling",
    )
    immediate = next(
        item
        for item in simulator.snapshot(FARM_ID, fault_at).device_twins
        if item.device_id == "root_zone_chiller"
    )
    settled = next(
        item
        for item in simulator.snapshot(FARM_ID, fault_at + timedelta(seconds=5)).device_twins
        if item.device_id == "root_zone_chiller"
    )

    assert fault_twin.desired_value is True
    assert fault_twin.reported_value is False
    assert fault_twin.effective_value is False
    assert fault_twin.health.value == "fault"
    assert immediate.desired_value is True
    assert immediate.reported_value is False
    assert immediate.effective_value is False
    assert settled.reported_value is True
    assert settled.effective_value is True
    assert settled.mode.value == "manual"


def test_warning_duration_hysteresis_and_incident_lifecycle_survive_restart(tmp_path) -> None:
    state_path = tmp_path / "incidents.db"
    simulator = KoreanGreenhouseSimulator(state_path)
    warning = [SensorReading(metric=SensorMetric.AIR_TEMPERATURE, value=20.5, unit="°C")]
    hysteresis_band = [SensorReading(metric=SensorMetric.AIR_TEMPERATURE, value=19.8, unit="°C")]
    clear = [SensorReading(metric=SensorMetric.AIR_TEMPERATURE, value=19.0, unit="°C")]

    assert simulator.alerts_for(FARM_ID, warning, FIXED_AT) == []
    simulator = KoreanGreenhouseSimulator(state_path)
    active = simulator.alerts_for(FARM_ID, warning, FIXED_AT + timedelta(seconds=10))
    assert len(active) == 1
    incident = simulator.incident_history(FARM_ID)[0]
    acknowledged = simulator.acknowledge_incident(
        FARM_ID,
        incident.incident_id,
        FIXED_AT + timedelta(seconds=11),
    )
    assert acknowledged.status is IncidentStatus.ACKNOWLEDGED

    assert simulator.alerts_for(FARM_ID, hysteresis_band, FIXED_AT + timedelta(seconds=12))
    assert simulator.alerts_for(FARM_ID, clear, FIXED_AT + timedelta(seconds=13)) == []
    assert simulator.incident_history(FARM_ID)[0].status is IncidentStatus.RECOVERING
    simulator.alerts_for(FARM_ID, clear, FIXED_AT + timedelta(seconds=28))

    restored = KoreanGreenhouseSimulator(state_path)
    resolved = restored.incident_history(FARM_ID)[0]
    assert resolved.status is IncidentStatus.RESOLVED
    assert resolved.acknowledged_at is not None
    assert resolved.resolved_at is not None


def test_two_zones_two_faults_seeded_readings_and_derived_indicators_are_repeatable() -> None:
    first = KoreanGreenhouseSimulator()
    second = KoreanGreenhouseSimulator()
    activation = {
        "farm_id": FARM_ID,
        "scenario_id": DemoScenarioId.VENTILATION_STUCK,
        "applied_at": FIXED_AT,
        "correlation_id": "two-zone-composite",
        "scenario_ids": [
            DemoScenarioId.VENTILATION_STUCK,
            DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
        ],
        "zone_ids": ["zone-a", "zone-b"],
        "seed": 4096,
    }
    first.activate_scenario(**activation)
    second.activate_scenario(**activation)
    observed_at = FIXED_AT + timedelta(seconds=60)

    first_snapshot = first.snapshot(FARM_ID, observed_at)
    second_snapshot = second.snapshot(FARM_ID, observed_at)

    assert first_snapshot.active_scenario_ids == activation["scenario_ids"]
    assert first_snapshot.zones == ["zone-a", "zone-b"]
    assert len(first_snapshot.readings) == len(SensorMetric) * 2
    assert len(first_snapshot.derived_indicators) == 2
    assert all(item.vpd_kpa >= 0 and item.dli_mol_m2_day >= 0 for item in first_snapshot.derived_indicators)
    assert first_snapshot.readings == second_snapshot.readings
    assert any(item.zone_id == "zone-b" for item in first_snapshot.alerts)
    assert any(item.alert_kind == "sensor_health" for item in first_snapshot.alerts)


def test_both_zones_have_bounded_independent_repeatable_live_variation() -> None:
    simulator = KoreanGreenhouseSimulator()
    samples = {zone: [] for zone in ('zone-a', 'zone-b')}
    for seconds in range(0, 20, 2):
        at = FIXED_AT + timedelta(seconds=seconds)
        readings = simulator.snapshot(FARM_ID, at).readings
        assert readings == simulator.snapshot(FARM_ID, at).readings
        for zone in samples:
            baseline = simulator._normal_reading_values(FARM_ID, at, zone)[SensorMetric.ROOT_ZONE_TEMPERATURE]
            value = next(r.value for r in readings if r.zone_id == zone and r.metric == SensorMetric.ROOT_ZONE_TEMPERATURE)
            residual = value - baseline - (0.35 if zone == 'zone-b' else 0)
            assert abs(residual) <= 0.0551  # 0.05 signal plus rounding
            samples[zone].append(round(residual, 4))
    assert all(len(set(values)) >= 3 for values in samples.values())
    assert samples['zone-a'] != samples['zone-b']


def test_normal_snapshot_exposes_both_operating_zones() -> None:
    snapshot = KoreanGreenhouseSimulator().snapshot(FARM_ID, FIXED_AT)

    assert snapshot.zones == ["zone-a", "zone-b"]
    assert {item.zone_id for item in snapshot.readings} == {"zone-a", "zone-b"}
    assert len(snapshot.readings) == len(SensorMetric) * 2
    assert {item.zone_id for item in snapshot.derived_indicators} == {"zone-a", "zone-b"}


def test_single_zone_fault_leaves_the_other_zone_on_its_normal_profile() -> None:
    affected = KoreanGreenhouseSimulator()
    reference = KoreanGreenhouseSimulator()
    affected.activate_scenario(
        FARM_ID,
        DemoScenarioId.ROOT_COOLING_FAULT,
        FIXED_AT,
        "zone-a-only-fault",
        zone_ids=["zone-a"],
    )
    observed_at = FIXED_AT + timedelta(seconds=60)

    affected_snapshot = affected.snapshot(FARM_ID, observed_at)
    reference_snapshot = reference.snapshot(FARM_ID, observed_at)

    def metric(snapshot, zone_id: str, sensor_metric: SensorMetric) -> SensorReading:
        return next(
            item
            for item in snapshot.readings
            if item.zone_id == zone_id and item.metric is sensor_metric
        )

    affected_zone = metric(affected_snapshot, "zone-a", SensorMetric.ROOT_ZONE_TEMPERATURE)
    unaffected_zone = metric(affected_snapshot, "zone-b", SensorMetric.ROOT_ZONE_TEMPERATURE)
    reference_zone = metric(reference_snapshot, "zone-b", SensorMetric.ROOT_ZONE_TEMPERATURE)

    assert affected_zone.value > unaffected_zone.value + 3
    assert unaffected_zone == reference_zone
    assert all(item.zone_id != "zone-b" for item in affected_snapshot.alerts)


def test_new_equipment_fault_has_a_real_response_delay() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(
        FARM_ID,
        DemoScenarioId.VENTILATION_STUCK,
        FIXED_AT,
        "vent-delay",
    )
    baseline = simulator.snapshot(FARM_ID, FIXED_AT)
    before_effect = simulator.snapshot(FARM_ID, FIXED_AT + timedelta(seconds=4))
    after_effect = simulator.snapshot(FARM_ID, FIXED_AT + timedelta(seconds=20))

    def roof(snapshot):
        return next(item for item in snapshot.device_twins if item.device_id == "roof_vent")

    assert roof(baseline).effective_value == roof(before_effect).effective_value
    assert roof(after_effect).effective_value < roof(before_effect).effective_value
    assert roof(after_effect).desired_value == 70.0
    assert roof(after_effect).health.value == "fault"


@pytest.mark.parametrize(
    "scenario_ids,zone_ids",
    [
        (
            [
                DemoScenarioId.ROOT_COOLING_FAULT,
                DemoScenarioId.EC_DRIFT,
                DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
            ],
            ["zone-a"],
        ),
        ([DemoScenarioId.ROOT_COOLING_FAULT], ["zone-a", "zone-b", "zone-c"]),
    ],
)
def test_simulator_rejects_more_than_two_faults_or_zones(scenario_ids, zone_ids) -> None:
    simulator = KoreanGreenhouseSimulator()
    with pytest.raises(ValueError, match="at most two"):
        simulator.activate_scenario(
            FARM_ID,
            scenario_ids[0],
            FIXED_AT,
            "too-many",
            scenario_ids=scenario_ids,
            zone_ids=zone_ids,
        )
