"""Narrow local-only client for the FarmOps MCP HTTP facade.

The product API is the only browser-facing boundary.  It resolves the demo
identity itself, then passes the trusted farm and actor context to the MCP
service.  There is deliberately no direct telemetry-control fallback here:
when the local MCP service is unavailable, an approval is not executed.
"""

from __future__ import annotations

import json
import os
import socket
from dataclasses import dataclass
from typing import Any, Literal, TypedDict, cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


LOCAL_MCP_HOSTS = {"farm-mcp", "localhost", "127.0.0.1"}
# The MCP call must outlive its own telemetry timeout (5 seconds) so the
# product boundary normally receives the final simulator execution record.
MCP_TIMEOUT_SECONDS = 7.0


class McpToolDefinition(TypedDict):
    name: str
    description: str
    inputSchema: dict[str, Any]


ControlActionName = Literal[
    "set_roof_vent_open_percent",
    "set_side_vent_open_percent",
    "set_thermal_curtain_percent",
    "set_circulation_fan_percent",
    "start_irrigation_cycle",
    "set_heating_enabled",
    "set_cooling_enabled",
    "recalibrate_air_temperature_sensor",
]


class FarmDeviceListResult(TypedDict):
    farm_id: str
    profile_id: str
    devices: list[dict[str, Any]]
    correlation_id: str
    simulated_only: bool


class DeviceCapabilitiesResult(TypedDict):
    farm_id: str
    profile_id: str
    things: list[dict[str, Any]]
    current_feedback: list[dict[str, Any]]
    correlation_id: str
    simulated_only: bool


class ControlImpactPreviewResult(TypedDict):
    farm_id: str
    device_id: str
    instance_id: str
    zone_id: Literal["zone-a", "zone-b"]
    operator_label: str
    action: str
    target_value: float | bool
    current: dict[str, Any] | None
    expected_effects: list[str]
    requires_operator_approval: bool
    execution_performed: bool
    correlation_id: str
    simulated_only: bool


class ExecutionTrackingResult(TypedDict):
    farm_id: str
    executions: list[dict[str, Any]]
    correlation_id: str
    simulated_only: bool


_CONTROL_ACTION_NAMES = {
    "set_roof_vent_open_percent",
    "set_side_vent_open_percent",
    "set_thermal_curtain_percent",
    "set_circulation_fan_percent",
    "start_irrigation_cycle",
    "set_heating_enabled",
    "set_cooling_enabled",
    "recalibrate_air_temperature_sensor",
}
_PERCENTAGE_ACTIONS = {
    "set_roof_vent_open_percent",
    "set_side_vent_open_percent",
    "set_thermal_curtain_percent",
    "set_circulation_fan_percent",
}
_BOOLEAN_ACTIONS = {
    "start_irrigation_cycle",
    "set_heating_enabled",
    "set_cooling_enabled",
    "recalibrate_air_temperature_sensor",
}


@dataclass(frozen=True)
class McpClientError(RuntimeError):
    """Sanitized failure returned by the local MCP boundary."""

    message: str
    status_code: int = 503
    ambiguous: bool = False

    def __str__(self) -> str:
        return self.message


def _base_url() -> str:
    value = os.getenv("MCP_BASE_URL", "").strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme != "http" or parsed.hostname not in LOCAL_MCP_HOSTS:
        raise McpClientError("Local FarmOps MCP endpoint is not configured.")
    return value


def _service_token() -> str:
    token = os.getenv("MCP_SERVICE_TOKEN", "").strip()
    if not token:
        raise McpClientError("Local FarmOps MCP service token is not configured.")
    return token


def _command_for_target(
    target: str,
    value: Any,
    requested_action: str = "set_actuator_state",
) -> tuple[str, float | bool]:
    """Translate the compact dashboard controls to the typed MCP contract."""

    if requested_action == "recalibrate_air_temperature_sensor" or target == "air_temperature_sensor_reset":
        if (
            requested_action != "recalibrate_air_temperature_sensor"
            or target != "air_temperature_sensor_reset"
            or value is not True
        ):
            raise McpClientError("Sensor recalibration requires its typed target and boolean true.", 422)
        return "recalibrate_air_temperature_sensor", True
    if requested_action != "set_actuator_state":
        raise McpClientError("This control action is not supported by the FarmOps MCP contract.", 422)
    if target == "ventilation_fan":
        return "set_circulation_fan_percent", _percentage(value, enabled=80.0, opened=80.0, closed=0.0)
    if target == "roof_vent":
        return "set_roof_vent_open_percent", _percentage(value, enabled=100.0, opened=100.0, closed=0.0)
    if target == "side_vent":
        return "set_side_vent_open_percent", _percentage(value, enabled=100.0, opened=100.0, closed=0.0)
    if target == "thermal_curtain":
        return "set_thermal_curtain_percent", _percentage(value, enabled=100.0, opened=0.0, closed=100.0)
    if target == "irrigation_pump":
        return "start_irrigation_cycle", _boolean(value)
    if target == "irrigation_valve":
        return "start_irrigation_cycle", _boolean(value)
    if target == "heater":
        return "set_heating_enabled", _boolean(value)
    if target == "root_zone_chiller":
        return "set_cooling_enabled", _boolean(value)
    if target == "shade_curtain":
        return "set_thermal_curtain_percent", _percentage(value, enabled=70.0, opened=0.0, closed=100.0)
    raise McpClientError("This actuator target is not supported by the FarmOps MCP contract.", 422)


def _boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"on", "open", "enabled", "true", "1"}:
            return True
        if normalized in {"off", "closed", "disabled", "false", "0"}:
            return False
    raise McpClientError("The requested actuator value is invalid for the local simulator.", 422)


def _percentage(value: Any, *, enabled: float, opened: float, closed: float) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        numeric = float(value)
        if 0 <= numeric <= 100:
            return numeric
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"on", "enabled", "true"}:
            return enabled
        if normalized in {"off", "disabled", "false"}:
            return 0.0
        if normalized == "open":
            return opened
        if normalized == "closed":
            return closed
    raise McpClientError("The requested percentage must be between 0 and 100.", 422)


def _request(
    method: str,
    path: str,
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
    payload: dict[str, Any] | None = None,
) -> Any:
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = Request(
        f"{_base_url()}{path}",
        data=body,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Internal-Service-Token": _service_token(),
            "X-Farm-Id": farm_id,
            "X-Actor-Id": actor_id,
            "X-Actor-Role": actor_role,
            "X-Correlation-Id": correlation_id,
        },
        method=method,
    )
    try:
        with urlopen(request, timeout=MCP_TIMEOUT_SECONDS) as response:  # noqa: S310 - local Compose service allow-listed above.
            decoded = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = "FarmOps MCP rejected the request."
        try:
            body = json.loads(error.read().decode("utf-8"))
            detail = str(body.get("detail") or detail) if isinstance(body, dict) else detail
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        raise McpClientError(detail, error.code) from error
    except (TimeoutError, socket.timeout) as error:
        raise McpClientError(
            "FarmOps MCP response timed out; the authoritative proposal state will be checked.",
            ambiguous=True,
        ) from error
    except URLError as error:
        if isinstance(error.reason, (TimeoutError, socket.timeout)):
            raise McpClientError(
                "FarmOps MCP response timed out; the authoritative proposal state will be checked.",
                ambiguous=True,
            ) from error
        raise McpClientError("Local FarmOps MCP is unavailable; the simulator was not changed.") from error
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise McpClientError("Local FarmOps MCP is unavailable; the simulator was not changed.") from error
    return decoded


def _validated_proposal(result: Any, farm_id: str, proposal_id: str | None = None) -> dict[str, Any]:
    if (
        not isinstance(result, dict)
        or result.get("farm_id") != farm_id
        or not result.get("proposal_id")
        or result.get("simulated_only") is not True
        or result.get("zone_id", "zone-a") not in {"zone-a", "zone-b"}
        or (proposal_id is not None and result.get("proposal_id") != proposal_id)
    ):
        raise McpClientError("FarmOps MCP returned an invalid simulator-only proposal.")
    execution = result.get("execution")
    if isinstance(execution, dict) and execution.get("zone_id", result.get("zone_id", "zone-a")) != result.get(
        "zone_id", "zone-a"
    ):
        raise McpClientError("FarmOps MCP returned an execution for a different cultivation zone.")
    return result


def _mcp_rpc(
    *,
    method: str,
    params: dict[str, Any],
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> dict[str, Any]:
    response = _request(
        "POST",
        "/mcp",
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
        payload={
            "jsonrpc": "2.0",
            "id": correlation_id,
            "method": method,
            "params": params,
        },
    )
    if not isinstance(response, dict) or response.get("jsonrpc") != "2.0":
        raise McpClientError("FarmOps MCP returned an invalid JSON-RPC response.")
    if isinstance(response.get("error"), dict):
        raise McpClientError(str(response["error"].get("message") or "FarmOps MCP rejected the request."), 422)
    result = response.get("result")
    if not isinstance(result, dict):
        raise McpClientError("FarmOps MCP returned an invalid JSON-RPC result.")
    return result


def _call_tool(
    name: str,
    arguments: dict[str, Any],
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> Any:
    result = _mcp_rpc(
        method="tools/call",
        params={"name": name, "arguments": arguments},
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    if result.get("isError") is True:
        structured = result.get("structuredContent")
        detail = structured.get("error") if isinstance(structured, dict) else None
        raise McpClientError(str(detail or "FarmOps MCP tool rejected the request."), 422)
    if "structuredContent" not in result:
        raise McpClientError("FarmOps MCP tool returned no structured result.")
    return result["structuredContent"]


def _validated_read_only_result(result: Any, farm_id: str, label: str) -> dict[str, Any]:
    if (
        not isinstance(result, dict)
        or result.get("farm_id") != farm_id
        or result.get("simulated_only") is not True
    ):
        raise McpClientError(f"FarmOps MCP returned an invalid {label} result.")
    return result


def list_tools(
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> list[str]:
    result = _mcp_rpc(
        method="tools/list",
        params={},
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    tools = result.get("tools")
    if not isinstance(tools, list):
        raise McpClientError("FarmOps MCP returned an invalid tool list.")
    names = [item.get("name") for item in tools if isinstance(item, dict)]
    if not names or any(not isinstance(name, str) or not name for name in names):
        raise McpClientError("FarmOps MCP returned an invalid tool definition.")
    return list(dict.fromkeys(names))


def list_tool_definitions(
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> list[McpToolDefinition]:
    """Return the complete MCP discovery contract for agent tool selection."""

    result = _mcp_rpc(
        method="tools/list",
        params={},
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    tools = result.get("tools")
    if not isinstance(tools, list):
        raise McpClientError("FarmOps MCP returned an invalid tool list.")

    definitions: list[McpToolDefinition] = []
    seen: set[str] = set()
    for item in tools:
        if not isinstance(item, dict):
            raise McpClientError("FarmOps MCP returned an invalid tool definition.")
        name = item.get("name")
        description = item.get("description")
        input_schema = item.get("inputSchema")
        if (
            not isinstance(name, str)
            or not name
            or not isinstance(description, str)
            or not description
            or not isinstance(input_schema, dict)
        ):
            raise McpClientError("FarmOps MCP returned an invalid tool definition.")
        if name in seen:
            continue
        seen.add(name)
        definitions.append(
            {
                "name": name,
                "description": description,
                "inputSchema": input_schema,
            }
        )
    if not definitions:
        raise McpClientError("FarmOps MCP returned an invalid tool definition.")
    return definitions


def get_farm_snapshot(
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> dict[str, Any]:
    result = _call_tool(
        "get_farm_snapshot",
        {},
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    if (
        not isinstance(result, dict)
        or not isinstance(result.get("farm"), dict)
        or result["farm"].get("farm_id") != farm_id
        or not isinstance(result.get("readings"), list)
        or not isinstance(result.get("actuator_state"), dict)
    ):
        raise McpClientError("FarmOps MCP returned an invalid farm snapshot.")
    return result


def get_sensor_timeseries(
    *,
    metric: str,
    start: str,
    end: str,
    interval_minutes: int = 10,
    zone_id: Literal["zone-a", "zone-b"] = "zone-a",
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> dict[str, Any]:
    if (
        not isinstance(metric, str)
        or not metric.strip()
        or not isinstance(start, str)
        or not start.strip()
        or not isinstance(end, str)
        or not end.strip()
    ):
        raise McpClientError("Metric, start, and end are required for a telemetry series.", 422)
    if not isinstance(interval_minutes, int) or isinstance(interval_minutes, bool) or not 1 <= interval_minutes <= 60:
        raise McpClientError("Telemetry interval must be between 1 and 60 minutes.", 422)
    if zone_id not in {"zone-a", "zone-b"}:
        raise McpClientError("Telemetry zone must be zone-a or zone-b.", 422)
    result = _call_tool(
        "get_sensor_timeseries",
        {
            "metric": metric,
            "start": start,
            "end": end,
            "interval_minutes": interval_minutes,
            "zone_id": zone_id,
        },
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    if (
        not isinstance(result, dict)
        or result.get("farm_id") != farm_id
        or result.get("metric") != metric
        or result.get("zone_id", "zone-a") != zone_id
        or not isinstance(result.get("points"), list)
    ):
        raise McpClientError("FarmOps MCP returned an invalid telemetry series.")
    return result


def list_alerts(
    *,
    status: Literal["open", "acknowledged"] | None = None,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> list[dict[str, Any]]:
    if status not in (None, "open", "acknowledged"):
        raise McpClientError("Alert status must be open or acknowledged.", 422)
    arguments = {"status": status} if status is not None else {}
    result = _call_tool(
        "list_alerts",
        arguments,
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    if not isinstance(result, list) or any(
        not isinstance(alert, dict) or alert.get("farm_id") != farm_id for alert in result
    ):
        raise McpClientError("FarmOps MCP returned an invalid alert list.")
    return result


def list_farm_devices(
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> FarmDeviceListResult:
    result = _validated_read_only_result(
        _call_tool(
            "list_farm_devices",
            {},
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        ),
        farm_id,
        "device list",
    )
    if (
        not isinstance(result.get("profile_id"), str)
        or not result["profile_id"]
        or not isinstance(result.get("devices"), list)
        or any(
            not isinstance(device, dict)
            or not isinstance(device.get("device_id"), str)
            or not device["device_id"]
            or not isinstance(device.get("operator_label"), str)
            or not device["operator_label"]
            or device.get("zone_id", "zone-a") not in {"zone-a", "zone-b"}
            for device in result["devices"]
        )
    ):
        raise McpClientError("FarmOps MCP returned an invalid device list result.")
    return cast(FarmDeviceListResult, result)


def get_device_capabilities(
    *,
    device_id: str | None = None,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> DeviceCapabilitiesResult:
    if device_id is not None and (not isinstance(device_id, str) or not device_id.strip()):
        raise McpClientError("Device identifier must be a non-empty string.", 422)
    arguments = {"device_id": device_id.strip()} if device_id is not None else {}
    result = _validated_read_only_result(
        _call_tool(
            "get_device_capabilities",
            arguments,
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        ),
        farm_id,
        "device capability",
    )
    things = result.get("things")
    feedback = result.get("current_feedback")
    if (
        not isinstance(result.get("profile_id"), str)
        or not result["profile_id"]
        or not isinstance(things, list)
        or not things
        or any(
            not isinstance(thing, dict)
            or not isinstance(thing.get("id"), str)
            or not thing["id"]
            or not isinstance(thing.get("properties"), dict)
            or not isinstance(thing.get("actions"), dict)
            or not isinstance(thing.get("events"), dict)
            for thing in things
        )
        or not isinstance(feedback, list)
        or any(not isinstance(item, dict) for item in feedback)
    ):
        raise McpClientError("FarmOps MCP returned an invalid device capability result.")
    return cast(DeviceCapabilitiesResult, result)


def preview_control_impact(
    *,
    action: ControlActionName,
    target_value: float | bool,
    zone_id: Literal["zone-a", "zone-b"] = "zone-a",
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> ControlImpactPreviewResult:
    _validate_control_preview(action, target_value)
    result = _validated_read_only_result(
        _call_tool(
            "preview_control_impact",
            {"action": action, "target_value": target_value, "zone_id": zone_id},
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        ),
        farm_id,
        "control impact preview",
    )
    result = {
        **result,
        "zone_id": result.get("zone_id", "zone-a"),
        "instance_id": result.get("instance_id") or f"{zone_id}:{result.get('device_id', '')}",
    }
    expected_effects = result.get("expected_effects")
    if (
        result.get("action") != action
        or result.get("target_value") != target_value
        or result.get("zone_id", "zone-a") != zone_id
        or not isinstance(result.get("device_id"), str)
        or not result["device_id"]
        or not isinstance(result.get("instance_id"), str)
        or not result["instance_id"]
        or result["instance_id"] != f"{zone_id}:{result['device_id']}"
        or not isinstance(result.get("operator_label"), str)
        or not result["operator_label"]
        or not isinstance(expected_effects, list)
        or any(not isinstance(item, str) or not item for item in expected_effects)
        or result.get("requires_operator_approval") is not True
        or result.get("execution_performed") is not False
    ):
        raise McpClientError("FarmOps MCP returned an invalid control impact preview result.")
    return cast(ControlImpactPreviewResult, result)


def track_recent_executions(
    *,
    proposal_id: str | None = None,
    limit: int = 10,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> ExecutionTrackingResult:
    if proposal_id is not None and (not isinstance(proposal_id, str) or not proposal_id.strip()):
        raise McpClientError("Proposal identifier must be a non-empty string.", 422)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 50:
        raise McpClientError("Execution tracking limit must be between 1 and 50.", 422)
    arguments: dict[str, Any] = {"limit": limit}
    if proposal_id is not None:
        arguments["proposal_id"] = proposal_id.strip()
    result = _validated_read_only_result(
        _call_tool(
            "track_recent_executions",
            arguments,
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        ),
        farm_id,
        "execution tracking",
    )
    executions = result.get("executions")
    if (
        not isinstance(executions, list)
        or len(executions) > limit
        or any(
            not isinstance(item, dict)
            or item.get("farm_id") != farm_id
            or not isinstance(item.get("proposal_id"), str)
            or not item["proposal_id"]
            for item in executions
        )
        or (
            proposal_id is not None
            and any(item.get("proposal_id") != proposal_id.strip() for item in executions)
        )
    ):
        raise McpClientError("FarmOps MCP returned an invalid execution tracking result.")
    return cast(ExecutionTrackingResult, result)


def _validate_control_preview(action: str, target_value: Any) -> None:
    if action not in _CONTROL_ACTION_NAMES:
        raise McpClientError("Control action is not supported by the FarmOps MCP contract.", 422)
    if action in _PERCENTAGE_ACTIONS:
        if (
            isinstance(target_value, bool)
            or not isinstance(target_value, (int, float))
            or not 0 <= float(target_value) <= 100
        ):
            raise McpClientError("Control preview percentage must be between 0 and 100.", 422)
        return
    if action in _BOOLEAN_ACTIONS and not isinstance(target_value, bool):
        raise McpClientError("Control preview requires a boolean target value.", 422)
    if action in {"start_irrigation_cycle", "recalibrate_air_temperature_sensor"} and target_value is not True:
        raise McpClientError("This control preview requires target_value=true.", 422)


def health() -> bool:
    """Check only the internal, allow-listed MCP health route."""

    try:
        request = Request(
            f"{_base_url()}/health",
            headers={"Accept": "application/json", "X-Internal-Service-Token": _service_token()},
            method="GET",
        )
        with urlopen(request, timeout=MCP_TIMEOUT_SECONDS) as response:  # noqa: S310 - local Compose service allow-listed above.
            payload = json.loads(response.read().decode("utf-8"))
        return isinstance(payload, dict) and payload.get("service") == "farm-mcp" and payload.get("simulated_only") is True
    except (McpClientError, HTTPError, OSError, URLError, ValueError, json.JSONDecodeError):
        return False


def propose_control(
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
    target: str,
    value: Any,
    zone_id: Literal["zone-a", "zone-b"] = "zone-a",
    rationale: str,
    requested_action: str = "set_actuator_state",
    origin: str | None = None,
    advisor_run_id: str | None = None,
    evidence_ids: list[str] | None = None,
    alert_id: str | None = None,
    alert_occurrence_id: str | None = None,
) -> dict[str, Any]:
    action, target_value = _command_for_target(target, value, requested_action)
    try:
        result = _call_tool(
            "propose_control_action",
            {
                "action": action,
                "target_value": target_value,
                "zone_id": zone_id,
                "rationale": rationale,
                "requested_action": requested_action,
                "requested_target": target,
                "origin": origin,
                "advisor_run_id": advisor_run_id,
                "evidence_ids": list(evidence_ids or []),
                "alert_id": alert_id,
                "alert_occurrence_id": alert_occurrence_id,
            },
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        )
    except McpClientError as error:
        if not error.ambiguous:
            raise
        proposals = list_control_proposals(
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        )
        match = next((item for item in proposals if item.get("correlation_id") == correlation_id), None)
        if match is None:
            raise error
        result = match
    validated = _validated_proposal(result, farm_id)
    if validated.get("zone_id", "zone-a") != zone_id:
        raise McpClientError("FarmOps MCP returned a proposal for a different cultivation zone.")
    return validated


def list_control_proposals(
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> list[dict[str, Any]]:
    result = _request(
        "GET",
        "/v1/control/proposals",
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    if not isinstance(result, list):
        raise McpClientError("FarmOps MCP returned an invalid proposal list.")
    return [_validated_proposal(item, farm_id) for item in result]


def get_control_proposal(
    *,
    proposal_id: str,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> dict[str, Any]:
    result = _request(
        "GET",
        f"/v1/control/proposals/{proposal_id}",
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    return _validated_proposal(result, farm_id, proposal_id)


def approve_control(
    *,
    proposal_id: str,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> dict[str, Any]:
    try:
        result = _call_tool(
            "approve_control_proposal",
            {"proposal_id": proposal_id},
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        )
    except McpClientError as error:
        if not error.ambiguous:
            raise
        result = get_control_proposal(
            proposal_id=proposal_id,
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        )
        if result.get("status") == "pending":
            raise error
    return _validated_proposal(result, farm_id, proposal_id)


def reject_control(
    *,
    proposal_id: str,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
    reason: str | None,
) -> dict[str, Any]:
    try:
        result = _call_tool(
            "reject_control_proposal",
            {"proposal_id": proposal_id, "reason": reason},
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        )
    except McpClientError as error:
        if not error.ambiguous:
            raise
        result = get_control_proposal(
            proposal_id=proposal_id,
            farm_id=farm_id,
            actor_id=actor_id,
            actor_role=actor_role,
            correlation_id=correlation_id,
        )
        if result.get("status") == "pending":
            raise error
    result = _validated_proposal(result, farm_id, proposal_id)
    if result.get("status") != "rejected":
        raise McpClientError("FarmOps MCP did not confirm rejection of this proposal.")
    return result


def reset_demo_state(
    *,
    farm_id: str,
    actor_id: str,
    actor_role: str,
    correlation_id: str,
) -> int:
    result = _request(
        "POST",
        "/v1/internal/demo-reset",
        farm_id=farm_id,
        actor_id=actor_id,
        actor_role=actor_role,
        correlation_id=correlation_id,
    )
    if result.get("farm_id") != farm_id or result.get("simulated_only") is not True:
        raise McpClientError("FarmOps MCP did not confirm the local demo reset.")
    return int(result.get("reset_proposals") or 0)
