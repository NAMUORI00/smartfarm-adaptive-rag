from datetime import datetime, timedelta, timezone

import pytest

from app.contracts import ControlAction, DemoScenarioId, SensorMetric, SimulatedControlCommand
from app.simulator import InvalidControlCommandError, KoreanGreenhouseSimulator, UnknownFarmError


FARM_ID = "farm-wasabi-a"
FIXED_AT = datetime(2026, 7, 16, 4, 30, tzinfo=timezone.utc)  # 13:30 KST


def values_for(simulator: KoreanGreenhouseSimulator, at: datetime = FIXED_AT) -> dict[SensorMetric, float]:
    return {
        reading.metric: reading.value
        for reading in simulator.readings_at(FARM_ID, at)
        if reading.zone_id == "zone-a"
    }


def command(
    simulator: KoreanGreenhouseSimulator,
    action: ControlAction,
    value: float | bool,
    at: datetime = FIXED_AT,
    proposal_id: str | None = None,
    zone_id: str = "zone-a",
) -> None:
    simulator.apply_simulated_command(
        SimulatedControlCommand(
            proposal_id=proposal_id or f"proposal-{zone_id}-{action.value}-{value}-{at.isoformat()}",
            farm_id=FARM_ID,
            action=action,
            target_value=value,
            zone_id=zone_id,
            requested_by="operator-1",
        ),
        at,
    )


def zone_values(
    simulator: KoreanGreenhouseSimulator,
    zone_id: str,
    at: datetime = FIXED_AT,
) -> dict[SensorMetric, float]:
    return {
        reading.metric: reading.value
        for reading in simulator.readings_at(FARM_ID, at)
        if reading.zone_id == zone_id
    }


def test_same_timestamp_produces_same_wasabi_readings() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(FARM_ID, DemoScenarioId.ROOT_COOLING_FAULT, FIXED_AT, "root-cooling-test")
    hold_at = FIXED_AT + timedelta(seconds=60)

    first = simulator.readings_at(FARM_ID, hold_at)
    second = simulator.readings_at(FARM_ID, hold_at)

    assert first == second
    values = {reading.metric: reading.value for reading in first if reading.zone_id == "zone-a"}
    assert values[SensorMetric.ROOT_ZONE_TEMPERATURE] > 20
    assert any(alert.alert_kind == "crop_risk" for alert in simulator.alerts_for(FARM_ID, first, hold_at))


def test_scenario_ramps_at_t0_t30_t60_then_holds() -> None:
    normal = KoreanGreenhouseSimulator()
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(FARM_ID, DemoScenarioId.ROOT_COOLING_FAULT, FIXED_AT, "phase-test")
    times = [FIXED_AT + timedelta(seconds=seconds) for seconds in (0, 30, 60, 120)]

    anomaly = [
        values_for(simulator, at)[SensorMetric.ROOT_ZONE_TEMPERATURE]
        - values_for(normal, at)[SensorMetric.ROOT_ZONE_TEMPERATURE]
        for at in times
    ]
    states = [simulator.scenario_state(FARM_ID, at) for at in times]

    assert anomaly[0] == pytest.approx(0, abs=0.01)
    assert 0 < anomaly[1] < anomaly[2]
    assert anomaly[3] == pytest.approx(anomaly[2], abs=0.1)
    assert [state.phase.value for state in states] == ["ramp", "ramp", "hold", "hold"]
    assert [state.elapsed_seconds for state in states] == [0, 30, 60, 120]
    assert states[2].phase_started_at == FIXED_AT + timedelta(seconds=60)
    snapshot = simulator.snapshot(FARM_ID, times[2])
    assert snapshot.scenario_phase.value == "hold"
    assert snapshot.scenario_elapsed_seconds == 60
    assert snapshot.scenario_phase_started_at == FIXED_AT + timedelta(seconds=60)


def test_temperature_drift_is_sensor_health_not_crop_risk() -> None:
    simulator = KoreanGreenhouseSimulator()
    hold_at = FIXED_AT + timedelta(seconds=60)
    later = FIXED_AT + timedelta(seconds=90)
    simulator.activate_scenario(FARM_ID, DemoScenarioId.TEMPERATURE_SENSOR_DRIFT, FIXED_AT, "sensor-drift-test")

    first_alerts = simulator.alerts_for(FARM_ID, simulator.readings_at(FARM_ID, hold_at), hold_at)
    later_alerts = simulator.alerts_for(FARM_ID, simulator.readings_at(FARM_ID, later), later)

    assert [alert.alert_id for alert in first_alerts] == [f"{FARM_ID}:air_temperature_c:sensor-health"]
    assert [alert.alert_id for alert in later_alerts] == [alert.alert_id for alert in first_alerts]
    assert first_alerts[0].alert_kind == "sensor_health"


def test_temperature_sensor_recalibration_starts_gradual_recovery() -> None:
    normal = KoreanGreenhouseSimulator()
    simulator = KoreanGreenhouseSimulator()
    control_at = FIXED_AT + timedelta(seconds=60)
    recovery_mid_at = control_at + timedelta(seconds=45)
    recovered_at = control_at + timedelta(seconds=90)
    simulator.activate_scenario(
        FARM_ID,
        DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
        FIXED_AT,
        "sensor-recalibration-test",
    )
    actuator_state_before = simulator.actuator_state_at(FARM_ID, control_at)
    drifted_value = values_for(simulator, control_at)[SensorMetric.AIR_TEMPERATURE]

    command(simulator, ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR, True, control_at)

    recovery_mid = values_for(simulator, recovery_mid_at)[SensorMetric.AIR_TEMPERATURE]
    recovered_value = values_for(simulator, recovered_at)[SensorMetric.AIR_TEMPERATURE]
    recovery_mid_alerts = simulator.alerts_for(
        FARM_ID,
        simulator.readings_at(FARM_ID, recovery_mid_at),
        recovery_mid_at,
    )
    assert simulator.scenario_state(FARM_ID, control_at).phase.value == "recovery"
    assert simulator.scenario_state(FARM_ID, control_at).phase_started_at == control_at
    assert simulator.actuator_state_at(FARM_ID, control_at) == actuator_state_before
    assert recovered_value < recovery_mid < drifted_value
    assert [alert.alert_id for alert in recovery_mid_alerts] == [f"{FARM_ID}:air_temperature_c:sensor-health"]
    assert recovered_value == pytest.approx(
        values_for(normal, recovered_at)[SensorMetric.AIR_TEMPERATURE],
        abs=0.01,
    )
    assert simulator.scenario_state(FARM_ID, recovered_at).phase.value == "recovered"
    assert not any(
        alert.alert_kind == "sensor_health"
        for alert in simulator.alerts_for(FARM_ID, simulator.readings_at(FARM_ID, recovered_at), recovered_at)
    )


def test_temperature_sensor_recalibration_requires_true() -> None:
    simulator = KoreanGreenhouseSimulator()

    with pytest.raises(InvalidControlCommandError, match="requires target_value=true"):
        command(simulator, ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR, False)


@pytest.mark.parametrize(
    ("scenario_id", "action", "target_value"),
    [
        (DemoScenarioId.ROOT_COOLING_FAULT, ControlAction.SET_COOLING_ENABLED, True),
        (DemoScenarioId.IRRIGATION_BLOCKAGE, ControlAction.START_IRRIGATION_CYCLE, True),
        (DemoScenarioId.HIGH_HUMIDITY_STAGNATION, ControlAction.SET_CIRCULATION_FAN_PERCENT, 90),
        (DemoScenarioId.EC_DRIFT, ControlAction.START_IRRIGATION_CYCLE, True),
    ],
)
def test_existing_current_scenarios_keep_their_recovery_commands(
    scenario_id: DemoScenarioId,
    action: ControlAction,
    target_value: float | bool,
) -> None:
    simulator = KoreanGreenhouseSimulator()
    control_at = FIXED_AT + timedelta(seconds=60)
    recovered_at = control_at + timedelta(seconds=90)
    simulator.activate_scenario(FARM_ID, scenario_id, FIXED_AT, f"{scenario_id.value}-regression")

    assert simulator.scenario_state(FARM_ID, control_at).phase.value == "hold"
    command(simulator, action, target_value, control_at)

    assert simulator.scenario_state(FARM_ID, control_at).phase.value == "recovery"
    assert simulator.scenario_state(FARM_ID, control_at).phase_started_at == control_at
    assert simulator.scenario_state(FARM_ID, recovered_at).phase.value == "recovered"


@pytest.mark.parametrize(
    ("scenario_id", "action", "target_value", "expected_alert_suffix"),
    [
        (
            DemoScenarioId.ROOT_COOLING_FAULT,
            ControlAction.SET_COOLING_ENABLED,
            True,
            ":root_zone_temperature_c:threshold:high",
        ),
        (
            DemoScenarioId.IRRIGATION_BLOCKAGE,
            ControlAction.START_IRRIGATION_CYCLE,
            True,
            ":irrigation-flow:crop-risk",
        ),
        (
            DemoScenarioId.HIGH_HUMIDITY_STAGNATION,
            ControlAction.SET_CIRCULATION_FAN_PERCENT,
            80,
            ":relative_humidity_pct:threshold:high",
        ),
        (
            DemoScenarioId.EC_DRIFT,
            ControlAction.START_IRRIGATION_CYCLE,
            True,
            ":supply_ec_ds_m:threshold:high",
        ),
        (
            DemoScenarioId.TEMPERATURE_SENSOR_DRIFT,
            ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR,
            True,
            ":air_temperature_c:sensor-health",
        ),
        (
            DemoScenarioId.HIGH_TEMPERATURE,
            ControlAction.SET_CIRCULATION_FAN_PERCENT,
            80,
            ":air_temperature_c:threshold:high",
        ),
        (
            DemoScenarioId.EC_RISE,
            ControlAction.START_IRRIGATION_CYCLE,
            True,
            ":supply_ec_ds_m:threshold:high",
        ),
        (
            DemoScenarioId.MOISTURE_LOW,
            ControlAction.START_IRRIGATION_CYCLE,
            True,
            ":substrate_moisture_pct:threshold:low",
        ),
        (
            DemoScenarioId.TEMPERATURE_SENSOR_FAULT,
            ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR,
            True,
            ":air_temperature_c:sensor-health",
        ),
    ],
)
def test_every_fault_scenario_alerts_then_clears_after_its_control(
    scenario_id: DemoScenarioId,
    action: ControlAction,
    target_value: float | bool,
    expected_alert_suffix: str,
) -> None:
    simulator = KoreanGreenhouseSimulator()
    control_at = FIXED_AT + timedelta(seconds=60)
    recovered_at = control_at + timedelta(seconds=90)
    simulator.activate_scenario(FARM_ID, scenario_id, FIXED_AT, f"{scenario_id.value}-closed-loop")

    active_alerts = simulator.snapshot(FARM_ID, control_at).alerts
    assert any(alert.alert_id.endswith(expected_alert_suffix) for alert in active_alerts)

    command(simulator, action, target_value, control_at)

    recovered = simulator.snapshot(FARM_ID, recovered_at)
    assert recovered.scenario_phase.value == "recovered"
    assert recovered.alerts == []


def test_irrigation_interruption_stops_pump_and_flow_as_crop_risk() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(FARM_ID, DemoScenarioId.IRRIGATION_BLOCKAGE, FIXED_AT, "blockage-test")
    hold_at = FIXED_AT + timedelta(seconds=60)

    readings = simulator.readings_at(FARM_ID, hold_at)
    values = {reading.metric: reading.value for reading in readings if reading.zone_id == "zone-a"}
    alerts = simulator.alerts_for(FARM_ID, readings, hold_at)

    assert simulator.actuator_state_at(FARM_ID, hold_at).irrigation_active is False
    assert values[SensorMetric.PUMP_CURRENT] < 1
    assert values[SensorMetric.IRRIGATION_FLOW] < 2
    irrigation_alert = next(alert for alert in alerts if alert.alert_id.endswith("irrigation-flow:crop-risk"))
    assert "관수 사이클이 중단" in irrigation_alert.message_ko
    assert all(alert.alert_kind == "crop_risk" for alert in alerts)


def test_ec_drift_is_repeatable() -> None:
    simulator = KoreanGreenhouseSimulator()
    normal_ec = values_for(simulator)[SensorMetric.SUPPLY_EC]
    simulator.activate_scenario(FARM_ID, DemoScenarioId.EC_DRIFT, FIXED_AT, "ec-drift-test")
    hold_at = FIXED_AT + timedelta(seconds=60)

    first = values_for(simulator, hold_at)[SensorMetric.SUPPLY_EC]
    second = values_for(simulator, hold_at)[SensorMetric.SUPPLY_EC]

    assert first == second
    assert first > normal_ec
    assert first > 2.4


def test_root_cooling_command_starts_gradual_recovery_without_rewriting_the_past() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(FARM_ID, DemoScenarioId.ROOT_COOLING_FAULT, FIXED_AT, "cooling-response-test")
    before_command_at = FIXED_AT + timedelta(seconds=30)
    control_at = FIXED_AT + timedelta(seconds=60)
    before_control = values_for(simulator, before_command_at)[SensorMetric.ROOT_ZONE_TEMPERATURE]
    hold_value = values_for(simulator, control_at)[SensorMetric.ROOT_ZONE_TEMPERATURE]

    command(simulator, ControlAction.SET_COOLING_ENABLED, True, control_at)
    recovery_start = values_for(simulator, control_at)[SensorMetric.ROOT_ZONE_TEMPERATURE]
    recovery_mid = values_for(simulator, control_at + timedelta(seconds=45))[SensorMetric.ROOT_ZONE_TEMPERATURE]
    recovery_end = values_for(simulator, control_at + timedelta(seconds=90))[SensorMetric.ROOT_ZONE_TEMPERATURE]

    assert values_for(simulator, before_command_at)[SensorMetric.ROOT_ZONE_TEMPERATURE] == before_control
    assert simulator.scenario_state(FARM_ID, control_at).phase.value == "recovery"
    assert simulator.scenario_state(FARM_ID, control_at).phase_started_at == control_at
    assert simulator.actuator_state_at(FARM_ID, control_at).cooling_enabled is True
    assert recovery_start == pytest.approx(hold_value, abs=0.1)
    assert recovery_end < recovery_mid < recovery_start
    assert recovery_start - recovery_end > 5
    recovered_state = simulator.scenario_state(FARM_ID, control_at + timedelta(seconds=90))
    assert recovered_state.phase.value == "recovered"
    assert recovered_state.phase_started_at == control_at + timedelta(seconds=90)


@pytest.mark.parametrize(
    ("scenario_id", "action", "active_value", "inactive_value", "expected_alert_suffix"),
    [
        (
            DemoScenarioId.ROOT_COOLING_FAULT,
            ControlAction.SET_COOLING_ENABLED,
            True,
            False,
            ":root_zone_temperature_c:threshold:high",
        ),
        (
            DemoScenarioId.HIGH_HUMIDITY_STAGNATION,
            ControlAction.SET_CIRCULATION_FAN_PERCENT,
            90,
            0,
            ":relative_humidity_pct:threshold:high",
        ),
    ],
)
def test_recovery_does_not_finish_after_its_control_is_stopped(
    scenario_id: DemoScenarioId,
    action: ControlAction,
    active_value: float | bool,
    inactive_value: float | bool,
    expected_alert_suffix: str,
) -> None:
    simulator = KoreanGreenhouseSimulator()
    control_at = FIXED_AT + timedelta(seconds=60)
    stopped_at = control_at + timedelta(seconds=30)
    restarted_at = stopped_at + timedelta(seconds=90)
    simulator.activate_scenario(FARM_ID, scenario_id, FIXED_AT, f"{scenario_id.value}-interrupted")

    command(simulator, action, active_value, control_at)
    assert simulator.scenario_state(FARM_ID, stopped_at - timedelta(seconds=1)).phase.value == "recovery"

    command(simulator, action, inactive_value, stopped_at)

    interrupted = simulator.snapshot(FARM_ID, restarted_at)
    assert interrupted.scenario_phase.value == "hold"
    assert any(alert.alert_id.endswith(expected_alert_suffix) for alert in interrupted.alerts)

    command(simulator, action, active_value, restarted_at)

    assert simulator.scenario_state(FARM_ID, restarted_at).phase.value == "recovery"
    recovered = simulator.snapshot(FARM_ID, restarted_at + timedelta(seconds=90))
    assert recovered.scenario_phase.value == "recovered"
    assert recovered.alerts == []


def test_irrigation_command_changes_flow_current_and_moisture() -> None:
    simulator = KoreanGreenhouseSimulator()
    before = values_for(simulator)

    command(simulator, ControlAction.START_IRRIGATION_CYCLE, True)
    after = values_for(simulator)

    assert before[SensorMetric.IRRIGATION_FLOW] == 0
    assert after[SensorMetric.IRRIGATION_FLOW] > before[SensorMetric.IRRIGATION_FLOW]
    assert after[SensorMetric.PUMP_CURRENT] > before[SensorMetric.PUMP_CURRENT]
    assert after[SensorMetric.SUBSTRATE_MOISTURE] > before[SensorMetric.SUBSTRATE_MOISTURE]


def test_heating_and_cooling_commands_are_mutually_exclusive() -> None:
    simulator = KoreanGreenhouseSimulator()

    command(simulator, ControlAction.SET_HEATING_ENABLED, True)
    heating = simulator.actuator_state_at(FARM_ID, FIXED_AT)
    assert heating.heating_enabled is True
    assert heating.cooling_enabled is False

    command(simulator, ControlAction.SET_COOLING_ENABLED, True, FIXED_AT + timedelta(seconds=1))
    cooling = simulator.actuator_state_at(FARM_ID, FIXED_AT + timedelta(seconds=1))
    assert cooling.heating_enabled is False
    assert cooling.cooling_enabled is True


@pytest.mark.parametrize(
    ("action", "target_value", "metric", "direction"),
    [
        (ControlAction.SET_COOLING_ENABLED, False, SensorMetric.ROOT_ZONE_TEMPERATURE, "up"),
        (ControlAction.START_IRRIGATION_CYCLE, True, SensorMetric.SUBSTRATE_MOISTURE, "up"),
        (ControlAction.SET_CIRCULATION_FAN_PERCENT, 100, SensorMetric.RELATIVE_HUMIDITY, "down"),
        (ControlAction.SET_ROOF_VENT_OPEN_PERCENT, 100, SensorMetric.RELATIVE_HUMIDITY, "down"),
        (ControlAction.SET_SIDE_VENT_OPEN_PERCENT, 100, SensorMetric.RELATIVE_HUMIDITY, "down"),
        (ControlAction.SET_HEATING_ENABLED, True, SensorMetric.AIR_TEMPERATURE, "up"),
        (ControlAction.SET_THERMAL_CURTAIN_PERCENT, 100, SensorMetric.PPFD, "down"),
    ],
)
def test_each_manual_device_changes_its_connected_sensor(
    action: ControlAction,
    target_value: float | bool,
    metric: SensorMetric,
    direction: str,
) -> None:
    simulator = KoreanGreenhouseSimulator()
    before = values_for(simulator)[metric]

    command(simulator, action, target_value)

    after = values_for(simulator)[metric]
    if direction == "up":
        assert after > before
    else:
        assert after < before


def test_irrigation_cycle_auto_stops_after_two_minutes() -> None:
    simulator = KoreanGreenhouseSimulator()
    command(simulator, ControlAction.START_IRRIGATION_CYCLE, True)

    assert simulator.actuator_state_at(FARM_ID, FIXED_AT + timedelta(seconds=119)).irrigation_active is True
    assert simulator.actuator_state_at(FARM_ID, FIXED_AT + timedelta(seconds=120)).irrigation_active is False
    assert values_for(simulator, FIXED_AT + timedelta(seconds=119))[SensorMetric.IRRIGATION_FLOW] > 0
    assert values_for(simulator, FIXED_AT + timedelta(seconds=120))[SensorMetric.IRRIGATION_FLOW] == 0


def test_fan_command_recovers_high_humidity_stagnation() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(FARM_ID, DemoScenarioId.HIGH_HUMIDITY_STAGNATION, FIXED_AT, "humidity-test")
    control_at = FIXED_AT + timedelta(seconds=60)
    before = values_for(simulator, control_at)[SensorMetric.RELATIVE_HUMIDITY]

    command(simulator, ControlAction.SET_CIRCULATION_FAN_PERCENT, 90, control_at)
    halfway = values_for(simulator, control_at + timedelta(seconds=45))[SensorMetric.RELATIVE_HUMIDITY]
    after = values_for(simulator, control_at + timedelta(seconds=90))[SensorMetric.RELATIVE_HUMIDITY]

    assert before >= 94
    assert after < halfway < before
    assert simulator.scenario_state(FARM_ID, control_at + timedelta(seconds=45)).phase.value == "recovery"
    assert simulator.snapshot(FARM_ID, control_at + timedelta(seconds=90)).alerts == []


def test_ec_profile_starts_from_irrigation_shortage_and_recovers_with_flow() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(FARM_ID, DemoScenarioId.EC_DRIFT, FIXED_AT, "ec-cause-test")
    control_at = FIXED_AT + timedelta(seconds=60)
    halfway_at = control_at + timedelta(seconds=45)
    recovered_at = control_at + timedelta(seconds=90)

    hold = values_for(simulator, control_at)
    assert simulator.actuator_state_at(FARM_ID, control_at).irrigation_active is False
    assert hold[SensorMetric.IRRIGATION_FLOW] == 0

    command(simulator, ControlAction.START_IRRIGATION_CYCLE, True, control_at)

    halfway = values_for(simulator, halfway_at)
    recovered = simulator.snapshot(FARM_ID, recovered_at)
    recovered_values = {
        reading.metric: reading.value
        for reading in recovered.readings
        if reading.zone_id == "zone-a"
    }
    assert simulator.scenario_state(FARM_ID, halfway_at).phase.value == "recovery"
    assert 0 < halfway[SensorMetric.IRRIGATION_FLOW] < recovered_values[SensorMetric.IRRIGATION_FLOW]
    assert recovered_values[SensorMetric.SUPPLY_EC] < halfway[SensorMetric.SUPPLY_EC] < hold[SensorMetric.SUPPLY_EC]
    assert recovered.scenario_phase.value == "recovered"
    assert recovered.alerts == []


def test_normal_scenario_clears_named_sensor_effects() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(FARM_ID, DemoScenarioId.EC_DRIFT, FIXED_AT, "ec-1")
    hold_at = FIXED_AT + timedelta(seconds=60)
    command(simulator, ControlAction.SET_COOLING_ENABLED, False, hold_at)
    assert simulator.actuator_state_at(FARM_ID, hold_at).cooling_enabled is False
    drift_ec = values_for(simulator, hold_at)[SensorMetric.SUPPLY_EC]
    normal = simulator.activate_scenario(FARM_ID, DemoScenarioId.NORMAL, hold_at, "normal-1")
    normal_ec = values_for(simulator, hold_at)[SensorMetric.SUPPLY_EC]

    assert normal.scenario_id is DemoScenarioId.NORMAL
    assert normal.correlation_id == "normal-1"
    assert drift_ec > normal_ec
    assert normal.phase.value == "normal"
    assert simulator.actuator_state_at(FARM_ID, hold_at).cooling_enabled is True


def test_fault_profile_replaces_an_earlier_manual_override_at_its_activation_boundary() -> None:
    simulator = KoreanGreenhouseSimulator()
    profile_at = FIXED_AT + timedelta(seconds=1)
    hold_at = profile_at + timedelta(seconds=60)
    command(simulator, ControlAction.SET_COOLING_ENABLED, True, FIXED_AT)
    assert simulator.actuator_state_at(FARM_ID, FIXED_AT).cooling_enabled is True

    simulator.activate_scenario(
        FARM_ID,
        DemoScenarioId.ROOT_COOLING_FAULT,
        profile_at,
        "profile-replaces-override",
    )

    assert simulator.actuator_state_at(FARM_ID, hold_at).cooling_enabled is False
    assert values_for(simulator, hold_at)[SensorMetric.ROOT_ZONE_TEMPERATURE] > 20


def test_scenario_and_control_effects_do_not_rewrite_points_before_their_effective_time() -> None:
    simulator = KoreanGreenhouseSimulator()
    before_at = FIXED_AT - timedelta(minutes=10)
    after_at = FIXED_AT + timedelta(minutes=10)
    normal_before = values_for(simulator, before_at)[SensorMetric.ROOT_ZONE_TEMPERATURE]

    simulator.activate_scenario(FARM_ID, DemoScenarioId.ROOT_COOLING_FAULT, FIXED_AT, "time-bound-scenario")
    series = simulator.timeseries(
        FARM_ID,
        SensorMetric.ROOT_ZONE_TEMPERATURE,
        before_at,
        after_at,
        10,
    )
    command(
        simulator,
        ControlAction.START_IRRIGATION_CYCLE,
        True,
        FIXED_AT,
        "time-bound-irrigation",
    )

    assert series.points[0].value == normal_before
    assert series.points[2].value > series.points[1].value
    assert values_for(simulator, before_at)[SensorMetric.IRRIGATION_FLOW] == 0
    assert values_for(simulator, FIXED_AT + timedelta(seconds=119))[SensorMetric.IRRIGATION_FLOW] > 0
    assert values_for(simulator, after_at)[SensorMetric.IRRIGATION_FLOW] == 0


def test_zone_scoped_command_changes_only_the_target_zone_and_twin_instance() -> None:
    simulator = KoreanGreenhouseSimulator()
    before_a = zone_values(simulator, "zone-a")
    before_b = zone_values(simulator, "zone-b")

    command(
        simulator,
        ControlAction.SET_CIRCULATION_FAN_PERCENT,
        0,
        zone_id="zone-b",
    )

    after_a = zone_values(simulator, "zone-a")
    after_b = zone_values(simulator, "zone-b")
    twins = simulator.device_twins_at(FARM_ID, FIXED_AT)
    zone_a_fan = next(item for item in twins if item.instance_id == "zone-a:ventilation_fan")
    zone_b_fan = next(item for item in twins if item.instance_id == "zone-b:ventilation_fan")

    assert after_a == before_a
    assert after_b[SensorMetric.RELATIVE_HUMIDITY] > before_b[SensorMetric.RELATIVE_HUMIDITY]
    assert zone_a_fan.effective_value != 0
    assert zone_b_fan.desired_value == 0
    applied_zone_b_fan = next(
        item
        for item in simulator.device_twins_at(FARM_ID, FIXED_AT + timedelta(seconds=5))
        if item.instance_id == "zone-b:ventilation_fan"
    )
    assert applied_zone_b_fan.effective_value == 0
    assert len({item.instance_id for item in twins}) == len(twins) == 16


def test_fault_recovery_ignores_commands_from_an_unaffected_zone() -> None:
    simulator = KoreanGreenhouseSimulator()
    simulator.activate_scenario(
        FARM_ID,
        DemoScenarioId.ROOT_COOLING_FAULT,
        FIXED_AT,
        "zone-b-recovery",
        zone_ids=["zone-b"],
    )
    hold_at = FIXED_AT + timedelta(seconds=60)
    command(
        simulator,
        ControlAction.SET_COOLING_ENABLED,
        True,
        hold_at,
        zone_id="zone-a",
    )

    assert simulator.scenario_state(FARM_ID, hold_at + timedelta(seconds=30)).phase.value == "hold"
    assert zone_values(simulator, "zone-b", hold_at)[SensorMetric.ROOT_ZONE_TEMPERATURE] > 20

    command(
        simulator,
        ControlAction.SET_COOLING_ENABLED,
        True,
        hold_at + timedelta(seconds=1),
        zone_id="zone-b",
    )

    assert simulator.scenario_state(FARM_ID, hold_at + timedelta(seconds=30)).phase.value == "recovery"


def test_recipe_warning_ranges_are_the_threshold_source_and_normal_state_is_clear() -> None:
    simulator = KoreanGreenhouseSimulator()
    assert simulator._recipe_thresholds[SensorMetric.AIR_TEMPERATURE] == (6.0, 20.0)
    assert simulator._recipe_thresholds[SensorMetric.RELATIVE_HUMIDITY] == (55.0, 78.0)
    readings = simulator.readings_at(FARM_ID, FIXED_AT)
    assert simulator.alerts_for(FARM_ID, readings, FIXED_AT) == []


def test_normal_scenario_stays_alert_free_for_a_full_day() -> None:
    simulator = KoreanGreenhouseSimulator()
    start = datetime(2026, 7, 16, 0, 0, tzinfo=timezone.utc)

    for minutes in range(0, 24 * 60, 5):
        sampled_at = start + timedelta(minutes=minutes)
        snapshot = simulator.snapshot(FARM_ID, sampled_at)
        assert len(snapshot.readings) == len(SensorMetric) * 2
        assert snapshot.alerts == [], f"unexpected alerts at {sampled_at.isoformat()}: {snapshot.alerts}"


def test_legacy_farm_context_remains_readable_but_is_not_listed() -> None:
    simulator = KoreanGreenhouseSimulator()

    assert simulator.snapshot("farm-strawberry-a", FIXED_AT).farm.crop == "고추냉이"
    assert [farm.farm_id for farm in simulator.list_farms()] == [FARM_ID]


def test_unknown_farm_is_rejected() -> None:
    with pytest.raises(UnknownFarmError):
        KoreanGreenhouseSimulator().snapshot("not-a-farm", datetime.now(timezone.utc))
