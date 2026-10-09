from datetime import datetime, timedelta, timezone
from app.simulator import KoreanGreenhouseSimulator
from app import operating_runtime as runtime

FARM="farm-wasabi-a"
AT=datetime(2026,9,9,tzinfo=timezone.utc)

def run(seed, reads=0):
    sim=KoreanGreenhouseSimulator()
    runtime.start(sim,FARM,AT,seed)
    for i in range(1,200):
        now=AT+timedelta(seconds=i*2)
        runtime.tick(sim,FARM,now)
        for _ in range(reads): sim.snapshot(FARM,now)
    return sim._operating_runs[FARM]

def test_seed_and_poll_independence():
    a,b=run(2),run(2,3)
    assert a["readings"]==b["readings"]
    assert a["event"]["kind"]==b["event"]["kind"]
    assert len({run(seed)["event"]["kind"] for seed in range(1,5)})>1

def test_pause_restore_never_counts_downtime(tmp_path):
    path=tmp_path/"telemetry.db"
    sim=KoreanGreenhouseSimulator(path); runtime.start(sim,FARM,AT,3)
    runtime.tick(sim,FARM,AT+timedelta(seconds=2))
    restored=KoreanGreenhouseSimulator(path)
    state=restored._operating_runs[FARM]
    assert state["status"]=="paused" and state["stable_since"] is None
    runtime.tick(restored,FARM,AT+timedelta(hours=1))
    assert state["tick"]==1

def test_fault_does_not_disappear_with_time_or_reading():
    sim=KoreanGreenhouseSimulator(); runtime.start(sim,FARM,AT,3)
    state=sim._operating_runs[FARM]
    state["event"]={"kind":"cooling_fault","zone":"zone-a","started_tick":0,"id":"fault"}
    state["faults"]=["zone-a:root_zone_chiller"]
    for i in range(1,200): runtime.tick(sim,FARM,AT+timedelta(seconds=i*2))
    assert state["event"] and state["stable_since"] is None
    assert not next(d for d in sim.device_twins_at(FARM,AT) if d.instance_id=="zone-a:root_zone_chiller").effective_value


def test_repair_requires_fresh_stability_and_retries_are_idempotent():
    from app.contracts import SimulatedControlCommand, ControlAction
    sim=KoreanGreenhouseSimulator(); runtime.start(sim,FARM,AT,3)
    state=sim._operating_runs[FARM]
    state["event"]={"kind":"cooling_fault","zone":"zone-a","started_tick":0,"id":"fault"}
    state["faults"]=["zone-a:root_zone_chiller"]
    for i in range(1,100): runtime.tick(sim,FARM,AT+timedelta(seconds=i*2))
    at=AT+timedelta(seconds=200)
    command=SimulatedControlCommand(proposal_id="repair-cooling",farm_id=FARM,action=ControlAction.SET_COOLING_ENABLED,target_value=True,requested_by="test")
    first=sim.apply_simulated_command(command,at)
    assert sim.apply_simulated_command(command,at)==first
    assert not next(d for d in sim.device_twins_at(FARM,at) if d.instance_id=="zone-a:root_zone_chiller").effective_value
    runtime.repair(sim,FARM,at,"zone-a:root_zone_chiller","repair-1")
    for i in range(100,120): runtime.tick(sim,FARM,AT+timedelta(seconds=i*2))
    assert state["event"] is not None
    for i in range(120,240): runtime.tick(sim,FARM,AT+timedelta(seconds=i*2))
    assert any(e["kind"]=="recovered" for e in state["history"])


def test_missing_relevant_sensor_cannot_recover():
    sim=KoreanGreenhouseSimulator(); runtime.start(sim,FARM,AT,3)
    state=sim._operating_runs[FARM]
    state["event"]={"kind":"heat","zone":"zone-a","started_tick":0,"id":"missing"}
    state["readings"]=[r for r in state["readings"] if not(r["zone_id"]=="zone-a" and r["metric"]=="air_temperature_c")]
    for i in range(1,150): runtime.tick(sim,FARM,AT+timedelta(seconds=i*2))
    assert state["event"] is not None and state["stable_since"] is None


import pytest
@pytest.mark.parametrize("kind",runtime.EVENTS)
def test_all_events_require_effective_response_and_observations(kind):
    from app.contracts import SimulatedControlCommand, ControlAction
    sim=KoreanGreenhouseSimulator();runtime.start(sim,FARM,AT,11)
    state=sim._operating_runs[FARM]
    outputs={d.device_id:d.effective_value for d in runtime.twins(sim,FARM,AT) if d.zone_id=="zone-a"}
    state["event"]={"kind":kind,"zone":"zone-a","started_tick":0,"started_at":AT.isoformat(),"initial_output":outputs,"id":"acceptance"}
    fault={"cooling_fault":"root_zone_chiller","vent_fault":"ventilation_fan","irrigation":"irrigation_pump"}.get(kind)
    if fault:state["faults"]=["zone-a:"+fault]
    for i in range(1,160):runtime.tick(sim,FARM,AT+timedelta(seconds=2*i))
    assert state["event"] is not None
    at=AT+timedelta(seconds=320)
    if fault:runtime.repair(sim,FARM,at,"zone-a:"+fault,"repair-"+kind)
    action,value={"heat":(ControlAction.SET_CIRCULATION_FAN_PERCENT,100),"humidity":(ControlAction.SET_CIRCULATION_FAN_PERCENT,100),"vent_fault":(ControlAction.SET_CIRCULATION_FAN_PERCENT,100),"cooling_fault":(ControlAction.SET_COOLING_ENABLED,True),"irrigation":(ControlAction.START_IRRIGATION_CYCLE,True),"sensor_fault":(ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR,True)}[kind]
    sim.apply_simulated_command(SimulatedControlCommand(proposal_id="response-"+kind,farm_id=FARM,action=action,target_value=value,requested_by="acceptance"),at)
    for i in range(160,330):runtime.tick(sim,FARM,AT+timedelta(seconds=2*i))
    assert any(e["kind"]=="recovered" and e["event_id"]=="acceptance" for e in state["history"])


def test_unobserved_interval_is_never_backfilled(tmp_path):
    from app.contracts import SensorMetric
    sim=KoreanGreenhouseSimulator(tmp_path/"history.db");runtime.start(sim,FARM,AT,1)
    result=sim.timeseries(FARM,SensorMetric.AIR_TEMPERATURE,AT-timedelta(hours=1),AT,1)
    assert result.points==[] and result.data_source=="continuous-synthetic-demo"
