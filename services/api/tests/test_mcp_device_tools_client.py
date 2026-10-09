from __future__ import annotations

import json
from typing import Any

import pytest

from app import mcp_client


COMMON_CONTEXT = {
    "farm_id": "farm-wasabi-a",
    "actor_id": "operator-01",
    "actor_role": "operator",
    "correlation_id": "device-tools-001",
}


def tool_response(structured: Any, *, is_error: bool = False) -> dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": "device-tools-001",
        "result": {
            "content": [{"type": "text", "text": json.dumps(structured)}],
            "structuredContent": structured,
            "isError": is_error,
        },
    }


def valid_results() -> dict[str, dict[str, Any]]:
    return {
        "list_farm_devices": {
            "farm_id": "farm-wasabi-a",
            "profile_id": "wasabi-greenhouse-v1",
            "devices": [
                {
                    "device_id": "root_zone_chiller",
                    "operator_label": "근권 냉각기",
                    "category": "root-zone",
                    "available_actions": ["set_cooling_enabled"],
                    "feedback": {"effective": False, "health": "normal"},
                }
            ],
            "correlation_id": "device-tools-001",
            "simulated_only": True,
        },
        "get_device_capabilities": {
            "farm_id": "farm-wasabi-a",
            "profile_id": "wasabi-greenhouse-v1",
            "things": [
                {
                    "@context": "https://www.w3.org/2022/wot/td/v1.1",
                    "id": "urn:smartfarm:device-model:root-zone-chiller:v1",
                    "title": "근권 냉각기",
                    "properties": {"enabled": {"type": "boolean", "unit": "boolean"}},
                    "actions": {"setEnabled": {"input": {"type": "boolean"}}},
                    "events": {"healthChanged": {"data": {"type": "string"}}},
                }
            ],
            "current_feedback": [
                {"device_id": "root_zone_chiller", "effective": False, "health": "normal"}
            ],
            "correlation_id": "device-tools-001",
            "simulated_only": True,
        },
        "preview_control_impact": {
            "farm_id": "farm-wasabi-a",
            "device_id": "root_zone_chiller",
            "operator_label": "근권 냉각기",
            "action": "set_cooling_enabled",
            "target_value": True,
            "current": {"effective": False, "health": "normal"},
            "expected_effects": ["근권 온도 하강"],
            "requires_operator_approval": True,
            "execution_performed": False,
            "correlation_id": "device-tools-001",
            "simulated_only": True,
        },
        "track_recent_executions": {
            "farm_id": "farm-wasabi-a",
            "executions": [
                {
                    "farm_id": "farm-wasabi-a",
                    "proposal_id": "proposal-001",
                    "execution_id": "execution-001",
                    "device_id": "root_zone_chiller",
                    "status": "applied",
                    "commanded": True,
                    "reported": True,
                    "effective": True,
                    "health": "normal",
                }
            ],
            "correlation_id": "device-tools-001",
            "simulated_only": True,
        },
    }


def test_typed_device_tool_clients_send_only_tool_arguments_and_trusted_context(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    results = valid_results()

    def fake_request(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        payload = kwargs["payload"]
        name = payload["params"]["name"]
        calls.append({"method": method, "path": path, **kwargs})
        return tool_response(results[name])

    monkeypatch.setattr(mcp_client, "_request", fake_request)

    devices = mcp_client.list_farm_devices(**COMMON_CONTEXT)
    capabilities = mcp_client.get_device_capabilities(
        device_id="root_zone_chiller",
        **COMMON_CONTEXT,
    )
    preview = mcp_client.preview_control_impact(
        action="set_cooling_enabled",
        target_value=True,
        **COMMON_CONTEXT,
    )
    executions = mcp_client.track_recent_executions(
        proposal_id="proposal-001",
        limit=5,
        **COMMON_CONTEXT,
    )

    assert devices["devices"][0]["device_id"] == "root_zone_chiller"
    assert capabilities["current_feedback"][0]["health"] == "normal"
    assert preview["execution_performed"] is False
    assert executions["executions"][0]["effective"] is True
    assert [call["payload"]["params"]["name"] for call in calls] == [
        "list_farm_devices",
        "get_device_capabilities",
        "preview_control_impact",
        "track_recent_executions",
    ]
    for call in calls:
        assert call["method"] == "POST"
        assert call["path"] == "/mcp"
        assert {key: call[key] for key in COMMON_CONTEXT} == COMMON_CONTEXT
        assert "farm_id" not in call["payload"]["params"]["arguments"]


def test_list_farm_devices_injects_context_as_http_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    response_payload = tool_response(valid_results()["list_farm_devices"])

    class FakeResponse:
        def __enter__(self) -> "FakeResponse":
            return self

        def __exit__(self, *_args: Any) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps(response_payload).encode("utf-8")

    def fake_urlopen(request: Any, timeout: float) -> FakeResponse:
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setenv("MCP_BASE_URL", "http://farm-mcp:8002")
    monkeypatch.setenv("MCP_SERVICE_TOKEN", "internal-device-token")
    monkeypatch.setattr(mcp_client, "urlopen", fake_urlopen)

    result = mcp_client.list_farm_devices(**COMMON_CONTEXT)
    request = captured["request"]
    request_headers = {name.lower(): value for name, value in request.header_items()}
    request_body = json.loads(request.data.decode("utf-8"))

    assert result["farm_id"] == "farm-wasabi-a"
    assert request_headers["x-internal-service-token"] == "internal-device-token"
    assert request_headers["x-farm-id"] == "farm-wasabi-a"
    assert request_headers["x-actor-id"] == "operator-01"
    assert request_headers["x-actor-role"] == "operator"
    assert request_headers["x-correlation-id"] == "device-tools-001"
    assert request_body["params"] == {"name": "list_farm_devices", "arguments": {}}


@pytest.mark.parametrize(
    ("call", "message"),
    [
        (
            lambda: mcp_client.get_device_capabilities(device_id=" ", **COMMON_CONTEXT),
            "Device identifier",
        ),
        (
            lambda: mcp_client.preview_control_impact(
                action="unsupported_action",  # type: ignore[arg-type]
                target_value=True,
                **COMMON_CONTEXT,
            ),
            "Control action",
        ),
        (
            lambda: mcp_client.preview_control_impact(
                action="set_roof_vent_open_percent",
                target_value=101,
                **COMMON_CONTEXT,
            ),
            "percentage",
        ),
        (
            lambda: mcp_client.preview_control_impact(
                action="start_irrigation_cycle",
                target_value=False,
                **COMMON_CONTEXT,
            ),
            "target_value=true",
        ),
        (
            lambda: mcp_client.track_recent_executions(limit=0, **COMMON_CONTEXT),
            "limit",
        ),
    ],
)
def test_device_tool_clients_reject_invalid_input_before_transport(
    monkeypatch: pytest.MonkeyPatch,
    call: Any,
    message: str,
) -> None:
    def unexpected_request(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("invalid input must not reach Farm MCP")

    monkeypatch.setattr(mcp_client, "_request", unexpected_request)

    with pytest.raises(mcp_client.McpClientError, match=message) as captured:
        call()

    assert captured.value.status_code == 422


def test_device_tool_clients_reject_tool_errors_and_cross_farm_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def tool_error(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return tool_response({"error": "Unknown device: missing"}, is_error=True)

    monkeypatch.setattr(mcp_client, "_request", tool_error)
    with pytest.raises(mcp_client.McpClientError, match="Unknown device") as tool_failure:
        mcp_client.get_device_capabilities(device_id="missing", **COMMON_CONTEXT)
    assert tool_failure.value.status_code == 422

    cross_farm = valid_results()["list_farm_devices"]
    cross_farm["farm_id"] = "farm-other"
    monkeypatch.setattr(
        mcp_client,
        "_request",
        lambda *_args, **_kwargs: tool_response(cross_farm),
    )
    with pytest.raises(mcp_client.McpClientError, match="invalid device list"):
        mcp_client.list_farm_devices(**COMMON_CONTEXT)


def test_device_tool_clients_reject_unsafe_or_malformed_structured_results(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unsafe_preview = valid_results()["preview_control_impact"]
    unsafe_preview["execution_performed"] = True
    monkeypatch.setattr(
        mcp_client,
        "_request",
        lambda *_args, **_kwargs: tool_response(unsafe_preview),
    )
    with pytest.raises(mcp_client.McpClientError, match="invalid control impact"):
        mcp_client.preview_control_impact(
            action="set_cooling_enabled",
            target_value=True,
            **COMMON_CONTEXT,
        )

    malformed_tracking = valid_results()["track_recent_executions"]
    malformed_tracking["executions"][0]["farm_id"] = "farm-other"
    monkeypatch.setattr(
        mcp_client,
        "_request",
        lambda *_args, **_kwargs: tool_response(malformed_tracking),
    )
    with pytest.raises(mcp_client.McpClientError, match="invalid execution tracking"):
        mcp_client.track_recent_executions(**COMMON_CONTEXT)
