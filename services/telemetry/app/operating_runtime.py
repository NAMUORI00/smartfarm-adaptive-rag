"""Continuous synthetic dynamics owned by the existing telemetry simulator.

Coefficients are demonstration assumptions, not fitted crop/physical models.
Only the server tick advances state; readers never draw random numbers.
"""
from copy import deepcopy
from datetime import datetime
import hashlib
import secrets
from uuid import uuid4
from pathlib import Path

from .contracts import ActuatorHealth, SensorQuality, SensorReading

MODEL_VERSION = "continuous-demo-1"
EVENTS = ("heat", "humidity", "irrigation", "cooling_fault", "vent_fault", "sensor_fault")


def public_state(state):
    if not state:
        return {"status": "stopped", "simulated_only": True, "model_version": MODEL_VERSION}
    return {k: deepcopy(state[k]) for k in ("run_id", "seed", "model_version", "status", "started_at", "last_tick", "tick", "time_scale", "recovery_seconds")}


def start(sim, farm, now, seed=None):
    if sim._operating_runs.get(farm, {}).get("status") in {"running", "paused"}:
        raise ValueError("이미 운영 중입니다. 기존 실행을 재개하세요.")
    if farm in sim._ingested_telemetry:
        raise ValueError("외부 관측이 등록된 환경에서는 시연을 시작할 수 없습니다.")
    sim._farm(farm)
    # An explicit start is an audited simulation-only action, never a page GET.
    from .contracts import DemoScenarioId
    previous = sim._operating_runs.pop(farm, None)
    archives = []
    if previous:
        previous = deepcopy(previous)
        archives = previous.pop("previous_runs", []) + [previous]
    try:
        sim.activate_scenario(farm, DemoScenarioId.NORMAL, now, f"runtime-{uuid4().hex}")
    except Exception:
        if previous:
            sim._operating_runs[farm] = {**previous, "previous_runs": archives[:-1]}
        raise
    initial = [r.model_dump(mode="json") for r in sim._legacy_readings_at(farm, now)]
    state = {"run_id": str(uuid4()), "seed": secrets.randbelow(2147483647) if seed is None else seed,
             "model_version": MODEL_VERSION, "model_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "initial_devices": [d.model_dump(mode="json") for d in sim._legacy_device_twins_at(farm, now)], "status": "running", "started_at": now.isoformat(),
             "last_tick": now.isoformat(), "tick": 0, "time_scale": "시연용 반응 계수 · 기록 시각은 실제 시각",
             "previous_runs": archives, "recovery_seconds": 90, "initial_readings": initial, "readings": deepcopy(initial),
             "event": None, "history": [], "cooldown_until": 60, "stable_since": None, "faults": []}
    sim._operating_runs[farm] = state
    sim._persist_state()
    return public_state(state)


def random_unit(state, purpose):
    digest = hashlib.sha256(f"{state['seed']}|{state['tick']}|{purpose}".encode()).digest()
    return int.from_bytes(digest[:8], "big") / 2**64


def twins(sim, farm, now):
    values = sim._legacy_device_twins_at(farm, now)
    state = sim._operating_runs.get(farm)
    if not state:
        return values
    faults = set(state["faults"])
    return [v.model_copy(update={"reported_value": False, "effective_value": False, "health": ActuatorHealth.FAULT})
            if v.instance_id in faults else v for v in values]


def repair(sim, farm, now, instance_id, request_id):
    state = sim._operating_runs.get(farm)
    if not state or state["status"] != "running":
        raise ValueError("운영 중인 시뮬레이션이 없습니다.")
    previous = next((e for e in state["history"] if e.get("request_id") == request_id), None)
    if previous:
        if previous.get("instance_id") != instance_id:
            raise ValueError("같은 요청의 점검 대상이 다릅니다.")
        return public_state(state)
    if instance_id not in state["faults"]:
        raise ValueError("현재 점검·복구할 고장 설비가 아닙니다.")
    state["faults"].remove(instance_id)
    state["history"].append({"kind": "repair", "request_id": request_id, "instance_id": instance_id, "at": now.isoformat()})
    state["stable_since"] = None
    sim._persist_state()
    return public_state(state)


def tick(sim, farm, now):
    state = sim._operating_runs.get(farm)
    if not state or state["status"] != "running":
        return
    elapsed = (now - datetime.fromisoformat(state["last_tick"])).total_seconds()
    if elapsed < 2:
        return
    # Never synthesize recovery observations for downtime or scheduler stalls.
    if elapsed > 6:
        state["stable_since"] = None
        sim._alert_clear_candidates.pop(farm, None)
    state["last_tick"] = now.isoformat()
    state["tick"] += 1
    seconds = state["tick"] * 2
    if not state["event"] and seconds >= state["cooldown_until"] and state["tick"] % 15 == 0:
        if random_unit(state, "arrival") < .35:
            name = EVENTS[min(len(EVENTS)-1, int(random_unit(state, "event") * len(EVENTS)))]
            zone = "zone-a" if random_unit(state, "zone") < .5 else "zone-b"
            initial_output = {d.device_id: d.effective_value for d in twins(sim,farm,now) if d.zone_id==zone}
            # Do not select a load that cannot be countered by available headroom.
            maximum_vent = max(float(initial_output.get(k, 0)) for k in ("ventilation_fan", "roof_vent", "side_vent"))
            if name in {"heat", "humidity"} and maximum_vent >= 95:
                name = "cooling_fault"
            state["event"] = {"kind": name, "zone": zone, "started_tick": state["tick"], "started_at":now.isoformat(), "initial_output":initial_output, "id": f"{state['run_id']}:{state['tick']}"}
            state["history"].append({**state["event"], "at": now.isoformat()})
            fault = {"cooling_fault": "root_zone_chiller", "vent_fault": "ventilation_fan", "irrigation": "irrigation_pump"}.get(name)
            if fault:
                state["faults"].append(f"{zone}:{fault}")
    output = {(d.zone_id, d.device_id): d.effective_value for d in twins(sim, farm, now)}
    event = state["event"]
    def calibrated(zone):
        if not event: return False
        began=datetime.fromisoformat(event.get("started_at",state["started_at"]))
        return any(at>=began and value is True for at,value in sim._actuator_overrides.get(farm,{}).get(zone,{}).get("air_temperature_sensor_recalibrated",[]))
    actual = []
    stable = True
    relevant_seen = False
    for raw in state["readings"]:
        r = SensorReading.model_validate(raw)
        key, zone = r.metric.value, r.zone_id
        kind = event["kind"] if event and event["zone"] == zone else None
        fan = float(output.get((zone, "ventilation_fan"), 0)) / 100
        vent = max(float(output.get((zone, "roof_vent"), 0)), float(output.get((zone, "side_vent"), 0))) / 100
        cool = bool(output.get((zone, "root_zone_chiller"), False))
        water = bool(output.get((zone, "irrigation_pump"), False))
        initial_output=event.get("initial_output",{}) if event else {}
        initial_vent=max(float(initial_output.get("roof_vent",0)),float(initial_output.get("side_vent",0)))/100
        baseline_vent=max(float(initial_output.get("ventilation_fan",0))/100, initial_vent)
        ventilation_gain=max(0, max(fan,vent)-baseline_vent)
        target = next(v["value"] for v in state["initial_readings"] if v["metric"] == key and v["zone_id"] == zone)
        quality = SensorQuality.GOOD
        if key == "air_temperature_c":
            target = (20+14*(1-baseline_vent)-24*ventilation_gain-8*max(0,int(cool)-int(bool(initial_output.get("root_zone_chiller",False))))) if kind=="heat" else 18
            target = max(15, target)
            if kind == "sensor_fault" and not calibrated(zone):
                target, quality = 65, SensorQuality.BAD
        elif key == "relative_humidity_pct":
            target = max(60, 78+24*(1-baseline_vent)-40*ventilation_gain) if kind=="humidity" else max(60,95-32*fan) if kind=="vent_fault" else 72
        elif key in {"root_zone_temperature_c", "substrate_temperature_c"}:
            target = 16 if cool else (25 if kind == "cooling_fault" else 18)
        elif key == "substrate_moisture_pct":
            target = 65 if water else (32 if kind == "irrigation" else 59)
        elif key == "irrigation_flow_l_min":
            target = 2.4 if water else 0
        elif key == "irrigation_pressure_bar":
            target = 1.1 if water else .15
        elif key == "pump_current_a":
            target = 1.2 if water else .08
        value = round(r.value + (target - r.value) * .06, 4)
        if key == "substrate_moisture_pct" and kind == "irrigation" and not water and f"{zone}:irrigation_pump" not in state["faults"]:
            # A completed irrigation pulse retains moisture; repair alone adds no water.
            value = round(max(20, r.value - .03), 4)
        if key == "irrigation_flow_l_min" and kind == "irrigation" and water and value >= .5 and quality == SensorQuality.GOOD:
            event["flow_confirmed_at"] = now.isoformat()
        r = r.model_copy(update={"value": value, "quality": quality, "observed_at": now, "expected_interval_seconds":2, "source": "continuous-synthetic-demo"})
        actual.append(r)
        if event and zone == event["zone"]:
            relevant = {"heat": "air_temperature_c", "humidity": "relative_humidity_pct", "vent_fault": "relative_humidity_pct",
                        "irrigation": "substrate_moisture_pct", "cooling_fault": "root_zone_temperature_c", "sensor_fault": "air_temperature_c"}[kind]
            if key == relevant:
                relevant_seen = True
                low, high = sim._recipe_thresholds.get(r.metric, (None, None))
                # Explicit synthetic acceptance bounds only where no recipe exists.
                if low is None and high is None:
                    low, high = {"root_zone_temperature_c": (12, 19), "substrate_moisture_pct": (50, 75)}.get(key, (None, None))
                stable = stable and quality == SensorQuality.GOOD and (low is None or value >= low) and (high is None or value <= high)
    state["readings"] = [r.model_dump(mode="json") for r in actual]
    if event:
        zone, kind = event["zone"], event["kind"]
        effective = {"heat": bool(output.get((zone, "root_zone_chiller"))) or float(output.get((zone, "ventilation_fan"), 0)) >= 30,
                     "humidity": float(output.get((zone, "ventilation_fan"), 0)) >= 30 or float(output.get((zone, "side_vent"), 0)) >= 30,
                     "vent_fault": not state["faults"] and float(output.get((zone, "ventilation_fan"), 0)) >= 30,
                     "cooling_fault": not state["faults"] and bool(output.get((zone, "root_zone_chiller"))),
                     "irrigation": not state["faults"] and bool(event.get("flow_confirmed_at")),
                     "sensor_fault": calibrated(zone)}[kind]
        if relevant_seen and stable and effective:
            state["stable_since"] = state["stable_since"] or seconds
            if seconds - state["stable_since"] >= 90:
                state["history"].append({"kind": "recovered", "event_id": event["id"], "at": now.isoformat()})
                state.update(event=None, stable_since=None, cooldown_until=seconds + 180)
        else:
            state["stable_since"] = None
    sim._state_revision += 1
    # This is the sole reconciliation point while continuous mode is active.
    previous_clear = sim._alert_clear_seconds
    sim._alert_clear_seconds = 90
    try:
        sim._snapshot(farm, now, reconcile_alert_occurrences=True)
    finally:
        sim._alert_clear_seconds = previous_clear
    observations = [dict(farm_id=farm, zone_id=r.zone_id, sensor_id=r.sensor_id, metric=r.metric.value,
                         observed_at=now.isoformat(), ingested_at=now.isoformat(), message_id=None, sequence=state["tick"],
                         value=r.value, unit=r.unit, quality=r.quality.value, source=r.source, simulated_only=True) for r in actual]
    sim._persist_state(observations=observations)
