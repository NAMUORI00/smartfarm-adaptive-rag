from __future__ import annotations

from typing import Any

import pytest

from app import mcp_client


def proposal(**updates: Any) -> dict[str, Any]:
    value = {
        "proposal_id": "proposal-1",
        "farm_id": "farm-wasabi-a",
        "action": "set_heating_enabled",
        "target_value": True,
        "rationale": "저온 경보에 대한 난방 시뮬레이터 제안",
        "requested_action": "set_actuator_state",
        "requested_target": "heater",
        "proposed_by": "operator-wasabi",
        "proposed_at": "2026-07-20T00:00:00+00:00",
        "status": "pending",
        "correlation_id": "control-1",
        "simulated_only": True,
    }
    value.update(updates)
    return value


def test_product_timeout_exceeds_downstream_execution_budget() -> None:
    assert mcp_client.MCP_TIMEOUT_SECONDS > 5.0


def test_proposal_validation_rejects_cross_zone_execution() -> None:
    with pytest.raises(mcp_client.McpClientError, match="different cultivation zone"):
        mcp_client._validated_proposal(
            proposal(
                zone_id="zone-b",
                execution={
                    "execution_id": "execution-cross-zone",
                    "zone_id": "zone-a",
                    "simulated_only": True,
                },
            ),
            "farm-wasabi-a",
        )


def test_approve_timeout_reloads_the_authoritative_proposal(monkeypatch) -> None:
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def fake_request(method: str, path: str, **kwargs: Any) -> Any:
        calls.append((method, path, kwargs.get("payload")))
        if method == "POST":
            raise mcp_client.McpClientError("timeout", ambiguous=True)
        return proposal(
            status="approved",
            approved_by="demo-admin",
            approved_at="2026-07-20T00:01:00+00:00",
            execution={
                "execution_id": "sim-1",
                "correlation_id": "control-1",
                "simulated_only": True,
            },
        )

    monkeypatch.setattr(mcp_client, "_request", fake_request)
    result = mcp_client.approve_control(
        proposal_id="proposal-1",
        farm_id="farm-wasabi-a",
        actor_id="demo-admin",
        actor_role="admin",
        correlation_id="control-1",
    )

    assert result["status"] == "approved"
    assert [(method, path) for method, path, _payload in calls] == [
        ("POST", "/mcp"),
        ("GET", "/v1/control/proposals/proposal-1"),
    ]
    assert calls[0][2]["method"] == "tools/call"
    assert calls[0][2]["params"] == {
        "name": "approve_control_proposal",
        "arguments": {"proposal_id": "proposal-1"},
    }


def test_create_timeout_finds_the_proposal_by_correlation_id(monkeypatch) -> None:
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def fake_request(method: str, path: str, **kwargs: Any) -> Any:
        calls.append((method, path, kwargs.get("payload")))
        if method == "POST":
            raise mcp_client.McpClientError("timeout", ambiguous=True)
        return [proposal()]

    monkeypatch.setattr(mcp_client, "_request", fake_request)
    result = mcp_client.propose_control(
        farm_id="farm-wasabi-a",
        actor_id="operator-wasabi",
        actor_role="operator",
        correlation_id="control-1",
        target="heater",
        value=True,
        rationale="저온 경보에 대한 난방 시뮬레이터 제안",
    )

    assert result["requested_target"] == "heater"
    assert [(method, path) for method, path, _payload in calls] == [
        ("POST", "/mcp"),
        ("GET", "/v1/control/proposals"),
    ]
    assert calls[0][2]["method"] == "tools/call"
    assert calls[0][2]["params"]["name"] == "propose_control_action"


def test_heater_and_greenhouse_vents_use_typed_mcp_actions() -> None:
    assert mcp_client._command_for_target("heater", "on") == ("set_heating_enabled", True)
    assert mcp_client._command_for_target("roof_vent", 70) == ("set_roof_vent_open_percent", 70.0)
    assert mcp_client._command_for_target("side_vent", 65) == ("set_side_vent_open_percent", 65.0)


def test_sensor_reset_uses_only_the_typed_recalibration_action_and_preserves_provenance(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    def fake_request(method: str, path: str, **kwargs: Any) -> Any:
        captured.update({"method": method, "path": path, **kwargs})
        arguments = kwargs["payload"]["params"]["arguments"]
        structured = proposal(
            action="recalibrate_air_temperature_sensor",
            requested_action="recalibrate_air_temperature_sensor",
            requested_target="air_temperature_sensor_reset",
            origin=arguments["origin"],
            advisor_run_id=arguments["advisor_run_id"],
            evidence_ids=arguments["evidence_ids"],
            alert_id=arguments["alert_id"],
            alert_occurrence_id=arguments["alert_occurrence_id"],
            zone_id=arguments["zone_id"],
        )
        return {
            "jsonrpc": "2.0",
            "id": "control-sensor-1",
            "result": {"structuredContent": structured, "isError": False},
        }

    monkeypatch.setattr(mcp_client, "_request", fake_request)
    result = mcp_client.propose_control(
        farm_id="farm-wasabi-a",
        actor_id="operator-wasabi",
        actor_role="operator",
        correlation_id="control-sensor-1",
        requested_action="recalibrate_air_temperature_sensor",
        target="air_temperature_sensor_reset",
        value=True,
        rationale="활성 센서 건전성 경보에 따른 공기 온도 센서 재보정 제안",
        origin="verified_telemetry_rule",
        advisor_run_id="advisor-sensor-1",
        evidence_ids=["farm-wasabi-a:telemetry:air_temperature_c"],
        alert_id="farm-wasabi-a:air_temperature_c:sensor-health",
        alert_occurrence_id="alert-occurrence-air-temperature-sensor-1",
        zone_id="zone-b",
    )

    assert result["requested_action"] == "recalibrate_air_temperature_sensor"
    assert captured["path"] == "/mcp"
    assert captured["payload"]["method"] == "tools/call"
    assert captured["payload"]["params"]["name"] == "propose_control_action"
    arguments = captured["payload"]["params"]["arguments"]
    assert arguments["action"] == "recalibrate_air_temperature_sensor"
    assert arguments["target_value"] is True
    assert arguments["requested_target"] == "air_temperature_sensor_reset"
    assert arguments["advisor_run_id"] == "advisor-sensor-1"
    assert arguments["evidence_ids"] == ["farm-wasabi-a:telemetry:air_temperature_c"]
    assert arguments["alert_occurrence_id"] == "alert-occurrence-air-temperature-sensor-1"
    assert arguments["zone_id"] == "zone-b"
    assert result["zone_id"] == "zone-b"


def test_tool_discovery_and_snapshot_use_json_rpc(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_request(_method: str, path: str, **kwargs: Any) -> Any:
        assert path == "/mcp"
        payload = kwargs["payload"]
        calls.append(payload)
        if payload["method"] == "tools/list":
            result = {"tools": [{"name": "get_farm_snapshot"}, {"name": "propose_control_action"}]}
        else:
            result = {
                "structuredContent": {
                    "farm": {"farm_id": "farm-wasabi-a"},
                    "sampled_at": "2026-07-20T00:00:00+00:00",
                    "readings": [],
                    "actuator_state": {},
                    "alerts": [],
                },
                "isError": False,
            }
        return {"jsonrpc": "2.0", "id": payload["id"], "result": result}

    monkeypatch.setattr(mcp_client, "_request", fake_request)
    common = {
        "farm_id": "farm-wasabi-a",
        "actor_id": "operator-wasabi",
        "actor_role": "operator",
        "correlation_id": "advisor-tools-1",
    }

    assert mcp_client.list_tools(**common) == ["get_farm_snapshot", "propose_control_action"]
    assert mcp_client.get_farm_snapshot(**common)["farm"]["farm_id"] == "farm-wasabi-a"
    assert calls[0]["method"] == "tools/list"
    assert calls[1]["params"] == {"name": "get_farm_snapshot", "arguments": {}}

    with pytest.raises(mcp_client.McpClientError):
        mcp_client._command_for_target(
            "air_temperature_sensor_reset",
            False,
            "recalibrate_air_temperature_sensor",
        )
    with pytest.raises(mcp_client.McpClientError):
        mcp_client._command_for_target("air_temperature_sensor_reset", True, "set_actuator_state")


def test_tool_definitions_include_description_and_input_schema(monkeypatch) -> None:
    input_schema = {
        "type": "object",
        "properties": {"status": {"type": "string", "enum": ["open", "acknowledged"]}},
        "additionalProperties": False,
    }

    def fake_request(_method: str, path: str, **kwargs: Any) -> Any:
        assert path == "/mcp"
        payload = kwargs["payload"]
        assert payload["method"] == "tools/list"
        return {
            "jsonrpc": "2.0",
            "id": payload["id"],
            "result": {
                "tools": [
                    {
                        "name": "list_alerts",
                        "description": "List current farm alerts.",
                        "inputSchema": input_schema,
                    }
                ]
            },
        }

    monkeypatch.setattr(mcp_client, "_request", fake_request)

    definitions = mcp_client.list_tool_definitions(
        farm_id="farm-wasabi-a",
        actor_id="operator-wasabi",
        actor_role="operator",
        correlation_id="advisor-tools-schema-1",
    )

    assert definitions == [
        {
            "name": "list_alerts",
            "description": "List current farm alerts.",
            "inputSchema": input_schema,
        }
    ]


def test_read_tools_use_typed_json_rpc_arguments(monkeypatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_request(_method: str, path: str, **kwargs: Any) -> Any:
        assert path == "/mcp"
        payload = kwargs["payload"]
        calls.append(payload)
        tool_name = payload["params"]["name"]
        if tool_name == "get_sensor_timeseries":
            structured: Any = {
                "farm_id": "farm-wasabi-a",
                "metric": "root_zone_temperature_c",
                "zone_id": "zone-b",
                "points": [{"timestamp": "2026-07-21T00:00:00Z", "value": 15.8}],
                "simulated_only": True,
            }
        else:
            structured = [
                {
                    "alert_id": "alert-1",
                    "farm_id": "farm-wasabi-a",
                    "status": "open",
                }
            ]
        return {
            "jsonrpc": "2.0",
            "id": payload["id"],
            "result": {"structuredContent": structured, "isError": False},
        }

    monkeypatch.setattr(mcp_client, "_request", fake_request)
    common = {
        "farm_id": "farm-wasabi-a",
        "actor_id": "operator-wasabi",
        "actor_role": "operator",
        "correlation_id": "advisor-read-tools-1",
    }

    series = mcp_client.get_sensor_timeseries(
        metric="root_zone_temperature_c",
        start="2026-07-21T00:00:00Z",
        end="2026-07-21T01:00:00Z",
        interval_minutes=15,
        zone_id="zone-b",
        **common,
    )
    alerts = mcp_client.list_alerts(status="open", **common)

    assert series["points"][0]["value"] == 15.8
    assert alerts[0]["alert_id"] == "alert-1"
    assert calls[0]["params"] == {
        "name": "get_sensor_timeseries",
        "arguments": {
            "metric": "root_zone_temperature_c",
            "start": "2026-07-21T00:00:00Z",
            "end": "2026-07-21T01:00:00Z",
            "interval_minutes": 15,
            "zone_id": "zone-b",
        },
    }
    assert calls[1]["params"] == {"name": "list_alerts", "arguments": {"status": "open"}}


def test_read_tool_validation_and_timeout_ambiguity_are_preserved(monkeypatch) -> None:
    common = {
        "farm_id": "farm-wasabi-a",
        "actor_id": "operator-wasabi",
        "actor_role": "operator",
        "correlation_id": "advisor-read-tools-timeout-1",
    }

    with pytest.raises(mcp_client.McpClientError) as invalid_interval:
        mcp_client.get_sensor_timeseries(
            metric="root_zone_temperature_c",
            start="2026-07-21T00:00:00Z",
            end="2026-07-21T01:00:00Z",
            interval_minutes=0,
            **common,
        )
    assert invalid_interval.value.status_code == 422

    def timeout_request(*_args: Any, **_kwargs: Any) -> Any:
        raise mcp_client.McpClientError("timeout", ambiguous=True)

    monkeypatch.setattr(mcp_client, "_request", timeout_request)
    with pytest.raises(mcp_client.McpClientError) as timeout:
        mcp_client.list_alerts(status=None, **common)
    assert timeout.value.ambiguous is True
