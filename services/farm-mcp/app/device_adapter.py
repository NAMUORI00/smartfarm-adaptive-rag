from __future__ import annotations

import copy
import json
import math
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Protocol

from .contracts import ControlAction, ControlProposal, PRODUCT_TARGET_BY_ACTION
from .telemetry_client import TelemetryGateway


WOT_TD_CONTEXT = "https://www.w3.org/2022/wot/td/v1.1"
DEFAULT_MANIFEST_NAME = "wasabi-greenhouse-v1.json"


class DeviceManifestError(ValueError):
    pass


class DeviceCommandAdapter(Protocol):
    """Stable boundary shared by simulated and future physical-device adapters."""

    def describe_capabilities(self, farm_id: str, device_id: str | None = None) -> dict[str, Any]: ...

    async def read_snapshot(self, farm_id: str) -> dict[str, Any]: ...

    async def request_command(self, proposal: ControlProposal) -> dict[str, Any]: ...

    async def read_command_status(self, farm_id: str, proposal_id: str) -> dict[str, Any] | None: ...

    async def confirm_outcome(self, proposal: ControlProposal) -> dict[str, Any]: ...


class DeviceManifestRegistry:
    def __init__(self, manifest_path: str | Path | None = None) -> None:
        self.path = self._resolve_path(manifest_path)
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise DeviceManifestError(f"Unable to load device manifest: {self.path}") from error
        self._payload = self._validate(payload)
        self._things_by_device_id = {
            self.device_id(thing): thing for thing in self._payload["things"]
        }
        self._things_by_action = {
            ControlAction(action_meta["controlAction"]): thing
            for thing in self._payload["things"]
            for action in thing["actions"].values()
            for action_meta in [action["x-smartfarm"]]
        }

    @staticmethod
    def _resolve_path(manifest_path: str | Path | None) -> Path:
        candidates: list[Path] = []
        configured = manifest_path or os.getenv("DEVICE_MANIFEST_PATH")
        if configured:
            candidates.append(Path(configured))
        candidates.append(Path("/app/data/device-manifests") / DEFAULT_MANIFEST_NAME)
        candidates.extend(
            parent / "data" / "device-manifests" / DEFAULT_MANIFEST_NAME
            for parent in Path(__file__).resolve().parents
        )
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        searched = ", ".join(str(candidate) for candidate in candidates)
        raise DeviceManifestError(f"Device manifest was not found; searched: {searched}")

    @staticmethod
    def _validate(payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict) or payload.get("schema_version") != 1:
            raise DeviceManifestError("Device manifest schema_version must be 1")
        things = payload.get("things")
        if not isinstance(things, list) or not things:
            raise DeviceManifestError("Device manifest must contain at least one Thing")

        device_ids: set[str] = set()
        control_actions: set[ControlAction] = set()
        for thing in things:
            if not isinstance(thing, dict) or thing.get("@context") != WOT_TD_CONTEXT:
                raise DeviceManifestError("Every device must use the WoT TD 1.1 context")
            if not all(isinstance(thing.get(field), str) and thing[field] for field in ("id", "title")):
                raise DeviceManifestError("Every device must have a non-empty id and title")
            for section in ("properties", "actions", "events"):
                if not isinstance(thing.get(section), dict):
                    raise DeviceManifestError(f"{thing['id']} must define {section}")
            metadata = thing.get("x-smartfarm")
            if not isinstance(metadata, dict):
                raise DeviceManifestError(f"{thing['id']} must define x-smartfarm metadata")
            device_id = metadata.get("deviceId")
            mappings = metadata.get("ksTtaMappings")
            if not isinstance(device_id, str) or not device_id:
                raise DeviceManifestError(f"{thing['id']} must define deviceId")
            if device_id in device_ids:
                raise DeviceManifestError(f"Duplicate deviceId: {device_id}")
            if not isinstance(metadata.get("operatorLabel"), str) or not metadata["operatorLabel"]:
                raise DeviceManifestError(f"{thing['id']} must define operatorLabel")
            if not isinstance(mappings, list) or not mappings or not all(isinstance(item, str) for item in mappings):
                raise DeviceManifestError(f"{thing['id']} must define KS/TTA mappings")
            device_ids.add(device_id)

            for action in thing["actions"].values():
                if not isinstance(action, dict) or not isinstance(action.get("input"), dict):
                    raise DeviceManifestError(f"{thing['id']} action must define an input schema")
                action_metadata = action.get("x-smartfarm")
                if not isinstance(action_metadata, dict):
                    raise DeviceManifestError(f"{thing['id']} action must define x-smartfarm metadata")
                try:
                    control_action = ControlAction(action_metadata["controlAction"])
                except (KeyError, ValueError) as error:
                    raise DeviceManifestError(f"{thing['id']} has an unsupported controlAction") from error
                if action_metadata.get("requiresOperatorApproval") is not True:
                    raise DeviceManifestError(f"{thing['id']} write actions must require operator approval")
                if control_action in control_actions:
                    raise DeviceManifestError(f"Duplicate controlAction: {control_action.value}")
                control_actions.add(control_action)

        missing = set(ControlAction) - control_actions
        if missing:
            missing_values = ", ".join(sorted(action.value for action in missing))
            raise DeviceManifestError(f"Device manifest is missing control actions: {missing_values}")
        return payload

    @staticmethod
    def device_id(thing: dict[str, Any]) -> str:
        return str(thing["x-smartfarm"]["deviceId"])

    def describe(self, device_id: str | None = None) -> dict[str, Any]:
        if device_id is None:
            things = self._payload["things"]
        else:
            thing = self._things_by_device_id.get(device_id)
            if thing is None:
                raise DeviceManifestError(f"Unknown device: {device_id}")
            things = [thing]
        return {
            "schema_version": self._payload["schema_version"],
            "profile_id": self._payload["profile_id"],
            "title": self._payload["title"],
            "things": copy.deepcopy(things),
        }

    def thing_for_action(self, action: ControlAction) -> dict[str, Any]:
        return self._things_by_action[action]

    def thing_for_device(self, device_id: str) -> dict[str, Any]:
        thing = self._things_by_device_id.get(device_id)
        if thing is None:
            raise DeviceManifestError(f"Unknown device: {device_id}")
        return thing

    def action_definition(self, action: ControlAction) -> dict[str, Any]:
        thing = self.thing_for_action(action)
        return next(
            definition
            for definition in thing["actions"].values()
            if definition["x-smartfarm"]["controlAction"] == action.value
        )


class SimulatorDeviceCommandAdapter:
    """Adapter for the deterministic telemetry service.

    New telemetry responses may expose ``device_twins`` with desired/reported/
    effective feedback. Older responses containing only ``actuator_state`` are
    normalized to the same read model without changing the upstream contract.
    """

    def __init__(
        self,
        telemetry: TelemetryGateway,
        manifest_path: str | Path | None = None,
    ) -> None:
        self._telemetry = telemetry
        self._manifest = DeviceManifestRegistry(manifest_path)
        self._command_statuses: dict[tuple[str, str], dict[str, Any]] = {}
        self._status_lock = threading.Lock()

    def describe_capabilities(self, farm_id: str, device_id: str | None = None) -> dict[str, Any]:
        payload = self._manifest.describe(device_id)
        return {**payload, "farm_id": farm_id, "simulated_only": True}

    async def read_snapshot(self, farm_id: str) -> dict[str, Any]:
        payload = await self._telemetry.snapshot(farm_id)
        return {
            **payload,
            "device_feedback": self._normalize_feedback(payload),
        }

    async def request_command(self, proposal: ControlProposal) -> dict[str, Any]:
        execution = await self._telemetry.execute_simulated_control(proposal)
        status = self._status_from_execution(proposal, execution)
        with self._status_lock:
            self._command_statuses[(proposal.farm_id, proposal.proposal_id)] = status
        return {**execution, "device_command_status": status}

    async def read_command_status(self, farm_id: str, proposal_id: str) -> dict[str, Any] | None:
        with self._status_lock:
            status = self._command_statuses.get((farm_id, proposal_id))
            return copy.deepcopy(status) if status is not None else None

    async def confirm_outcome(self, proposal: ControlProposal) -> dict[str, Any]:
        snapshot = await self.read_snapshot(proposal.farm_id)
        target = PRODUCT_TARGET_BY_ACTION[proposal.action]
        feedback = next(
            (
                item
                for item in snapshot["device_feedback"]
                if item["device_id"] == target and item.get("zone_id", "zone-a") == proposal.zone_id
            ),
            None,
        )
        if feedback is None:
            return {
                "proposal_id": proposal.proposal_id,
                "device_id": target,
                "instance_id": f"{proposal.zone_id}:{target}",
                "zone_id": proposal.zone_id,
                "status": "unavailable",
                "matched": None,
                "simulated_only": True,
            }
        if proposal.action is ControlAction.RECALIBRATE_AIR_TEMPERATURE_SENSOR:
            matched: bool | None = None
            outcome_status = "observed"
        else:
            matched = self._values_match(feedback.get("effective"), proposal.target_value)
            outcome_status = "confirmed" if matched else "pending"
        return {
            "proposal_id": proposal.proposal_id,
            "device_id": target,
            "instance_id": f"{proposal.zone_id}:{target}",
            "zone_id": proposal.zone_id,
            "status": outcome_status,
            "matched": matched,
            "commanded": proposal.target_value,
            "reported": feedback.get("reported"),
            "effective": feedback.get("effective"),
            "health": feedback.get("health"),
            "observed_at": snapshot.get("sampled_at"),
            "simulated_only": True,
        }

    def _normalize_feedback(self, payload: dict[str, Any]) -> list[dict[str, Any]]:
        device_twins = payload.get("device_twins")
        twins = [
            item
            for item in device_twins
            if isinstance(device_twins, list) and isinstance(item, dict) and item.get("device_id")
        ] if isinstance(device_twins, list) else []
        legacy_state = payload.get("actuator_state")
        legacy_state = legacy_state if isinstance(legacy_state, dict) else {}
        readings = payload.get("readings")
        readings = readings if isinstance(readings, list) else []

        feedback: list[dict[str, Any]] = []
        for thing in self._manifest.describe()["things"]:
            device_id = self._manifest.device_id(thing)
            matching_twins = [item for item in twins if str(item.get("device_id")) == device_id]
            for twin in matching_twins:
                zone_id = str(twin.get("zone_id") or "zone-a")
                feedback.append(
                    {
                        "device_id": device_id,
                        "instance_id": str(twin.get("instance_id") or f"{zone_id}:{device_id}"),
                        "zone_id": zone_id,
                        "operator_label": thing["x-smartfarm"]["operatorLabel"],
                        "commanded": twin.get("commanded_value", twin.get("desired_value")),
                        "reported": twin.get("reported_value"),
                        "effective": twin.get("effective_value"),
                        "unit": twin.get("unit"),
                        "mode": twin.get("mode"),
                        "health": twin.get("health", "unknown"),
                        "command_id": twin.get("command_id"),
                        "observed_at": twin.get("effective_at", twin.get("reported_at")),
                        "feedback_source": "device_twins",
                        "compatibility_fallback": False,
                    }
                )
            if matching_twins:
                continue

            legacy = self._legacy_feedback(thing, legacy_state, readings, payload.get("sampled_at"))
            if legacy is not None:
                feedback.append(legacy)
        return feedback

    @staticmethod
    def _legacy_feedback(
        thing: dict[str, Any],
        actuator_state: dict[str, Any],
        readings: list[Any],
        sampled_at: Any,
    ) -> dict[str, Any] | None:
        metadata = thing["x-smartfarm"]
        for property_definition in thing["properties"].values():
            property_metadata = property_definition.get("x-smartfarm", {})
            telemetry_field = property_metadata.get("telemetryField")
            if telemetry_field in actuator_state:
                value = actuator_state[telemetry_field]
                return {
                    "device_id": metadata["deviceId"],
                    "instance_id": f"zone-a:{metadata['deviceId']}",
                    "zone_id": "zone-a",
                    "operator_label": metadata["operatorLabel"],
                    "commanded": value,
                    "reported": value,
                    "effective": value,
                    "unit": property_definition.get("unit"),
                    "mode": None,
                    "health": "normal",
                    "command_id": None,
                    "observed_at": sampled_at,
                    "feedback_source": "legacy_actuator_state",
                    "compatibility_fallback": True,
                }
            telemetry_metric = property_metadata.get("telemetryMetric")
            reading = next(
                (
                    item
                    for item in readings
                    if isinstance(item, dict)
                    and item.get("metric") == telemetry_metric
                    and item.get("zone_id", "zone-a") == "zone-a"
                ),
                None,
            )
            if reading is not None:
                health_by_quality = {
                    "good": "normal",
                    "suspect": "degraded",
                    "bad": "fault",
                    "missing": "fault",
                    "stale": "offline",
                }
                return {
                    "device_id": metadata["deviceId"],
                    "instance_id": f"zone-a:{metadata['deviceId']}",
                    "zone_id": "zone-a",
                    "operator_label": metadata["operatorLabel"],
                    "commanded": None,
                    "reported": reading.get("value"),
                    "effective": reading.get("value"),
                    "unit": reading.get("unit", property_definition.get("unit")),
                    "mode": None,
                    "health": health_by_quality.get(str(reading.get("quality", "good")), "unknown"),
                    "command_id": None,
                    "observed_at": reading.get("observed_at", sampled_at),
                    "feedback_source": "legacy_sensor_reading",
                    "compatibility_fallback": True,
                }
        return None

    def _status_from_execution(
        self,
        proposal: ControlProposal,
        execution: dict[str, Any],
    ) -> dict[str, Any]:
        device_id = PRODUCT_TARGET_BY_ACTION[proposal.action]
        actuator_state = execution.get("actuator_state")
        actuator_state = actuator_state if isinstance(actuator_state, dict) else {}
        thing = self._manifest.thing_for_device(device_id)
        modern = next(
            (
                item
                for item in self._normalize_feedback(execution)
                if item["device_id"] == device_id
                and item.get("zone_id", "zone-a") == proposal.zone_id
            ),
            None,
        )
        legacy = self._legacy_feedback(
            thing,
            actuator_state,
            [],
            execution.get("executed_at"),
        )
        feedback = modern or legacy or {}
        return {
            "proposal_id": proposal.proposal_id,
            "execution_id": execution.get("execution_id"),
            "farm_id": proposal.farm_id,
            "device_id": device_id,
            "instance_id": f"{proposal.zone_id}:{device_id}",
            "zone_id": proposal.zone_id,
            "action": proposal.action.value,
            "status": "applied",
            "commanded": proposal.target_value,
            "reported": feedback.get("reported", execution.get("reported_value")),
            "effective": feedback.get("effective", execution.get("effective_value")),
            "health": feedback.get("health", execution.get("health", "unknown")),
            "observed_at": execution.get("executed_at")
            or datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
            "simulated_only": execution.get("simulated_only") is True,
        }

    @staticmethod
    def _values_match(actual: Any, expected: float | bool) -> bool:
        if isinstance(expected, bool):
            return actual is expected
        return (
            not isinstance(actual, bool)
            and isinstance(actual, (int, float))
            and math.isclose(float(actual), float(expected), abs_tol=0.01)
        )


def summarize_devices(
    capabilities: dict[str, Any],
    snapshot: dict[str, Any],
) -> list[dict[str, Any]]:
    result = []
    for thing in capabilities["things"]:
        metadata = thing["x-smartfarm"]
        device_id = metadata["deviceId"]
        matching_feedback = [
            item
            for item in snapshot.get("device_feedback", [])
            if isinstance(item, dict) and item.get("device_id") == device_id
        ]
        for feedback in matching_feedback or [None]:
            zone_id = str(feedback.get("zone_id") or "zone-a") if feedback else "zone-a"
            result.append(
                {
                    "device_id": device_id,
                    "instance_id": (
                        str(feedback.get("instance_id") or f"{zone_id}:{device_id}")
                        if feedback
                        else f"{zone_id}:{device_id}"
                    ),
                    "zone_id": zone_id,
                    "operator_label": metadata["operatorLabel"],
                    "category": metadata["category"],
                    "available_actions": [
                        definition["x-smartfarm"]["controlAction"]
                        for definition in thing["actions"].values()
                    ],
                    "feedback": feedback,
                    "simulated_only": True,
                }
            )
    return result


def preview_control_impact(
    capabilities: dict[str, Any],
    snapshot: dict[str, Any],
    action: ControlAction,
    target_value: float | bool,
    zone_id: str = "zone-a",
) -> dict[str, Any]:
    matching: tuple[dict[str, Any], dict[str, Any]] | None = None
    for thing in capabilities["things"]:
        for definition in thing["actions"].values():
            if definition["x-smartfarm"]["controlAction"] == action.value:
                matching = (thing, definition)
                break
        if matching is not None:
            break
    if matching is None:
        raise DeviceManifestError(f"No device supports {action.value}")

    thing, action_definition = matching
    _validate_target_value(action, target_value, action_definition["input"])
    device_id = thing["x-smartfarm"]["deviceId"]
    feedback = next(
        (
            item
            for item in snapshot.get("device_feedback", [])
            if isinstance(item, dict)
            and item.get("device_id") == device_id
            and item.get("zone_id", "zone-a") == zone_id
        ),
        None,
    )
    metadata = action_definition["x-smartfarm"]
    return {
        "device_id": device_id,
        "instance_id": f"{zone_id}:{device_id}",
        "zone_id": zone_id,
        "operator_label": thing["x-smartfarm"]["operatorLabel"],
        "action": action.value,
        "action_label": action_definition["title"],
        "target_value": target_value,
        "unit": action_definition["input"].get("unit"),
        "current": feedback,
        "expected_effects": list(metadata.get("expectedEffects", [])),
        "requires_operator_approval": True,
        "execution_performed": False,
        "simulated_only": True,
    }


def _validate_target_value(
    action: ControlAction,
    target_value: float | bool,
    schema: dict[str, Any],
) -> None:
    expected_type = schema.get("type")
    if expected_type == "boolean":
        if not isinstance(target_value, bool):
            raise DeviceManifestError(f"{action.value} requires a boolean target_value")
        if "const" in schema and target_value != schema["const"]:
            raise DeviceManifestError(f"{action.value} requires target_value={schema['const']!r}")
        return
    if expected_type == "number":
        if isinstance(target_value, bool) or not isinstance(target_value, (int, float)):
            raise DeviceManifestError(f"{action.value} requires a numeric target_value")
        minimum = float(schema.get("minimum", -math.inf))
        maximum = float(schema.get("maximum", math.inf))
        if not minimum <= float(target_value) <= maximum:
            raise DeviceManifestError(
                f"{action.value} target_value must be between {minimum:g} and {maximum:g}"
            )
        return
    raise DeviceManifestError(f"Unsupported input type for {action.value}: {expected_type}")
