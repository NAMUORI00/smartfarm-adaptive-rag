from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import app.device_adapter as device_adapter_module
from app.contracts import ControlAction
from app.device_adapter import (
    DeviceManifestRegistry,
    SimulatorDeviceCommandAdapter,
    WOT_TD_CONTEXT,
    preview_control_impact,
    summarize_devices,
)
from app.main import create_app
from app.telemetry_client import TelemetryGateway


REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = REPO_ROOT / "data" / "device-manifests" / "wasabi-greenhouse-v1.json"


def test_manifest_path_resolution_accepts_shallow_container_layout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configured = tmp_path / "manifest.json"
    configured.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(device_adapter_module, "__file__", "/app/app/device_adapter.py")

    assert DeviceManifestRegistry._resolve_path(configured) == configured


def test_device_discovery_and_preview_keep_zone_instances_distinct() -> None:
    capabilities = DeviceManifestRegistry(MANIFEST_PATH).describe("root_zone_chiller")
    snapshot = {
        "device_feedback": [
            {
                "device_id": "root_zone_chiller",
                "instance_id": "zone-a:root_zone_chiller",
                "zone_id": "zone-a",
                "effective": False,
            },
            {
                "device_id": "root_zone_chiller",
                "instance_id": "zone-b:root_zone_chiller",
                "zone_id": "zone-b",
                "effective": True,
            },
        ]
    }

    devices = summarize_devices(capabilities, snapshot)
    preview = preview_control_impact(
        capabilities,
        snapshot,
        ControlAction.SET_COOLING_ENABLED,
        False,
        "zone-b",
    )

    assert {item["instance_id"] for item in devices} == {
        "zone-a:root_zone_chiller",
        "zone-b:root_zone_chiller",
    }
    assert preview["instance_id"] == "zone-b:root_zone_chiller"
    assert preview["current"]["effective"] is True


def headers(role: str = "viewer") -> dict[str, str]:
    return {
        "X-Farm-Id": "farm-wasabi-a",
        "X-Actor-Id": "device-test-operator",
        "X-Actor-Role": role,
        "X-Internal-Service-Token": "local-mcp-development-token",
    }


def call_tool(
    client: TestClient,
    name: str,
    arguments: dict[str, Any] | None = None,
    *,
    role: str = "viewer",
) -> dict[str, Any]:
    response = client.post(
        "/mcp",
        headers=headers(role),
        json={
            "jsonrpc": "2.0",
            "id": f"test-{name}",
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments or {}},
        },
    )
    assert response.status_code == 200
    return response.json()["result"]


class FeedbackTelemetry(TelemetryGateway):
    def __init__(self, *, modern_feedback: bool = True) -> None:
        self.modern_feedback = modern_feedback
        self.executed: list[str] = []
        self.state: dict[str, float | bool] = {
            "roof_vent_open_pct": 20.0,
            "side_vent_open_pct": 15.0,
            "thermal_curtain_pct": 10.0,
            "circulation_fan_pct": 30.0,
            "irrigation_active": False,
            "heating_enabled": False,
            "cooling_enabled": False,
        }

    async def snapshot(self, farm_id: str) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "farm": {"farm_id": farm_id},
            "sampled_at": "2026-07-28T01:00:00Z",
            "readings": [
                {
                    "metric": "air_temperature_c",
                    "value": 16.2,
                    "unit": "°C",
                    "quality": "good",
                    "observed_at": "2026-07-28T01:00:00Z",
                }
            ],
            "actuator_state": dict(self.state),
            "simulated_only": True,
        }
        if self.modern_feedback:
            payload["device_twins"] = [
                {
                    "device_id": "root_zone_chiller",
                    "desired_value": self.state["cooling_enabled"],
                    "reported_value": self.state["cooling_enabled"],
                    "effective_value": self.state["cooling_enabled"],
                    "unit": "boolean",
                    "mode": "assisted",
                    "health": "normal",
                    "command_id": self.executed[-1] if self.executed else None,
                    "reported_at": "2026-07-28T01:00:00Z",
                    "effective_at": "2026-07-28T01:00:00Z",
                    "simulated_only": True,
                }
            ]
        return payload

    async def timeseries(
        self,
        farm_id: str,
        metric: str,
        start: str,
        end: str,
        interval_minutes: int,
        zone_id: str = "zone-a",
    ) -> dict[str, Any]:
        return {
            "farm_id": farm_id,
            "metric": metric,
            "zone_id": zone_id,
            "points": [],
            "simulated_only": True,
        }

    async def alerts(self, farm_id: str, status: str | None = None) -> list[dict[str, Any]]:
        return []

    async def execute_simulated_control(self, proposal: Any) -> dict[str, Any]:
        field_by_action = {
            "set_roof_vent_open_percent": "roof_vent_open_pct",
            "set_side_vent_open_percent": "side_vent_open_pct",
            "set_thermal_curtain_percent": "thermal_curtain_pct",
            "set_circulation_fan_percent": "circulation_fan_pct",
            "start_irrigation_cycle": "irrigation_active",
            "set_heating_enabled": "heating_enabled",
            "set_cooling_enabled": "cooling_enabled",
        }
        field = field_by_action.get(proposal.action.value)
        if field is not None:
            self.state[field] = proposal.target_value
        self.executed.append(proposal.proposal_id)
        return {
            "execution_id": f"sim-{proposal.proposal_id}",
            "proposal_id": proposal.proposal_id,
            "farm_id": proposal.farm_id,
            "action": proposal.action.value,
            "executed_at": "2026-07-28T01:00:01Z",
            "correlation_id": proposal.correlation_id,
            "actuator_state": dict(self.state),
            "simulated_only": True,
        }


def test_manifest_uses_wot_shape_and_complete_operator_metadata() -> None:
    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    registry = DeviceManifestRegistry(MANIFEST_PATH)
    capabilities = registry.describe()

    assert raw["profile_id"] == "wasabi-greenhouse-v1"
    assert len(capabilities["things"]) == 8
    assert {
        definition["x-smartfarm"]["controlAction"]
        for thing in capabilities["things"]
        for definition in thing["actions"].values()
    } == {action.value for action in ControlAction}
    for thing in capabilities["things"]:
        assert thing["@context"] == WOT_TD_CONTEXT
        assert thing["properties"]
        assert thing["actions"]
        assert thing["events"]
        assert thing["x-smartfarm"]["operatorLabel"]
        assert thing["x-smartfarm"]["ksTtaMappings"]
        assert all(
            definition.get("unit")
            for definition in thing["properties"].values()
        )
        assert all(
            definition["x-smartfarm"]["requiresOperatorApproval"] is True
            for definition in thing["actions"].values()
        )


def test_adapter_contract_reads_modern_feedback_and_legacy_fallback() -> None:
    modern = SimulatorDeviceCommandAdapter(FeedbackTelemetry(modern_feedback=True), MANIFEST_PATH)
    legacy = SimulatorDeviceCommandAdapter(FeedbackTelemetry(modern_feedback=False), MANIFEST_PATH)

    for method in (
        "describe_capabilities",
        "read_snapshot",
        "request_command",
        "read_command_status",
        "confirm_outcome",
    ):
        assert callable(getattr(modern, method))
    modern_snapshot = asyncio.run(modern.read_snapshot("farm-wasabi-a"))
    legacy_snapshot = asyncio.run(legacy.read_snapshot("farm-wasabi-a"))
    modern_chiller = next(
        item for item in modern_snapshot["device_feedback"] if item["device_id"] == "root_zone_chiller"
    )
    legacy_chiller = next(
        item for item in legacy_snapshot["device_feedback"] if item["device_id"] == "root_zone_chiller"
    )
    sensor = next(
        item
        for item in legacy_snapshot["device_feedback"]
        if item["device_id"] == "air_temperature_sensor_reset"
    )

    assert modern_chiller["commanded"] is False
    assert modern_chiller["reported"] is False
    assert modern_chiller["effective"] is False
    assert modern_chiller["health"] == "normal"
    assert modern_chiller["feedback_source"] == "device_twins"
    assert modern_chiller["compatibility_fallback"] is False
    assert legacy_chiller["commanded"] is False
    assert legacy_chiller["reported"] is False
    assert legacy_chiller["effective"] is False
    assert legacy_chiller["feedback_source"] == "legacy_actuator_state"
    assert legacy_chiller["compatibility_fallback"] is True
    assert sensor["reported"] == 16.2
    assert sensor["health"] == "normal"


def test_read_only_device_tools_list_capabilities_and_preview_without_execution() -> None:
    telemetry = FeedbackTelemetry()
    client = TestClient(create_app(telemetry))
    tool_list = client.post(
        "/mcp",
        headers=headers(),
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
    ).json()["result"]["tools"]
    read_only_names = {
        "list_farm_devices",
        "get_device_capabilities",
        "preview_control_impact",
        "track_recent_executions",
    }

    assert read_only_names <= {tool["name"] for tool in tool_list}
    for tool in tool_list:
        assert "farm_id" not in tool["inputSchema"]["properties"]
        if tool["name"] in read_only_names:
            assert tool["annotations"]["readOnlyHint"] is True

    devices = call_tool(client, "list_farm_devices")["structuredContent"]
    capability = call_tool(
        client,
        "get_device_capabilities",
        {"device_id": "root_zone_chiller"},
    )["structuredContent"]
    preview = call_tool(
        client,
        "preview_control_impact",
        {"action": "set_cooling_enabled", "target_value": True},
    )["structuredContent"]

    assert len(devices["devices"]) == 8
    assert next(
        item for item in devices["devices"] if item["device_id"] == "root_zone_chiller"
    )["feedback"]["effective"] is False
    assert capability["things"][0]["@context"] == WOT_TD_CONTEXT
    assert capability["things"][0]["actions"]["setEnabled"]["input"]["unit"] == "boolean"
    assert "KS X 3265" in capability["things"][0]["x-smartfarm"]["ksTtaMappings"]
    assert capability["current_feedback"][0]["effective"] is False
    assert preview["device_id"] == "root_zone_chiller"
    assert preview["current"]["effective"] is False
    assert preview["requires_operator_approval"] is True
    assert preview["execution_performed"] is False
    assert telemetry.executed == []

    invalid = call_tool(
        client,
        "preview_control_impact",
        {"action": "set_roof_vent_open_percent", "target_value": 130},
    )
    assert invalid["isError"] is True
    assert telemetry.executed == []


def test_recent_execution_tracking_preserves_approval_and_durable_status(tmp_path: Path) -> None:
    state_path = tmp_path / "farm-mcp-state.json"
    telemetry = FeedbackTelemetry()
    client = TestClient(create_app(telemetry, state_path=str(state_path)))
    proposed = client.post(
        "/v1/control/proposals",
        headers=headers("operator"),
        json={
            "action": "set_cooling_enabled",
            "target_value": True,
            "rationale": "근권 고온에 대응해 냉각기를 켭니다.",
            "requested_target": "root_zone_chiller",
        },
    ).json()

    before_approval = call_tool(client, "track_recent_executions")["structuredContent"]
    assert before_approval["executions"] == []
    assert telemetry.executed == []

    approved = client.post(
        f"/v1/control/proposals/{proposed['proposal_id']}/approve",
        headers=headers("operator"),
    )
    tracked = call_tool(
        client,
        "track_recent_executions",
        {"proposal_id": proposed["proposal_id"]},
    )["structuredContent"]

    assert approved.status_code == 200
    assert telemetry.executed == [proposed["proposal_id"]]
    assert tracked["executions"][0]["status"] == "applied"
    assert tracked["executions"][0]["commanded"] is True
    assert tracked["executions"][0]["reported"] is True
    assert tracked["executions"][0]["effective"] is True
    assert tracked["executions"][0]["outcome"]["status"] == "confirmed"
    assert tracked["executions"][0]["outcome"]["matched"] is True

    restarted = TestClient(
        create_app(FeedbackTelemetry(), state_path=str(state_path))
    )
    restored = call_tool(restarted, "track_recent_executions")["structuredContent"]

    assert restored["executions"][0]["proposal_id"] == proposed["proposal_id"]
    assert restored["executions"][0]["tracking_source"] == "proposal_ledger"
    assert restored["executions"][0]["commanded"] is True
