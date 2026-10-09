from __future__ import annotations

from .contracts import ControlAction


_ACTION_VALUES = [action.value for action in ControlAction]

TOOL_DEFINITIONS = [
    {
        "name": "get_farm_snapshot",
        "description": "Return the current simulated sensor, actuator, and alert snapshot for the caller's authorized farm.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "get_sensor_timeseries",
        "description": "Return a bounded telemetry series for the caller's authorized farm.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "metric": {"type": "string", "description": "Telemetry metric identifier."},
                "start": {"type": "string", "format": "date-time"},
                "end": {"type": "string", "format": "date-time"},
                "interval_minutes": {"type": "integer", "minimum": 1, "maximum": 60, "default": 10},
                "zone_id": {
                    "type": "string",
                    "enum": ["zone-a", "zone-b"],
                    "default": "zone-a",
                    "description": "Optional cultivation zone identifier.",
                },
            },
            "required": ["metric", "start", "end"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_alerts",
        "description": "List current simulated farm alerts for the caller's authorized farm.",
        "inputSchema": {
            "type": "object",
            "properties": {"status": {"type": "string", "enum": ["open", "acknowledged"]}},
            "additionalProperties": False,
        },
    },
    {
        "name": "list_farm_devices",
        "description": "List the devices available to the authorized farm, their operator-facing labels, actions, health, and current feedback.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "get_device_capabilities",
        "description": "Return the WoT Thing Description shaped properties, actions, events, ranges, units, and KS/TTA mappings for one or all available devices.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "device_id": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 128,
                    "description": "Optional device identifier returned by list_farm_devices.",
                }
            },
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "preview_control_impact",
        "description": "Preview the current device feedback and expected operational effects of a bounded control value without creating or executing a proposal.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": _ACTION_VALUES},
                "target_value": {
                    "description": "Boolean for enabled/irrigation actions, true for recalibration, or 0-100 percent otherwise."
                },
                "zone_id": {
                    "type": "string",
                    "enum": ["zone-a", "zone-b"],
                    "default": "zone-a",
                    "description": "Cultivation zone containing the target device instance.",
                },
            },
            "required": ["action", "target_value"],
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "track_recent_executions",
        "description": "Track recent approved executions from the durable proposal ledger. Supply proposal_id to also compare its latest effective device feedback.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "proposal_id": {"type": "string", "minLength": 1, "maxLength": 128},
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10},
            },
            "additionalProperties": False,
        },
        "annotations": {
            "readOnlyHint": True,
            "destructiveHint": False,
            "idempotentHint": True,
            "openWorldHint": False,
        },
    },
    {
        "name": "propose_control_action",
        "description": "Create a simulated-only control proposal. It cannot affect physical equipment and requires an explicit operator approval step.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": _ACTION_VALUES},
                "target_value": {
                    "description": "Boolean for enabled/irrigation actions, true for sensor recalibration, or 0-100 percent otherwise."
                },
                "zone_id": {
                    "type": "string",
                    "enum": ["zone-a", "zone-b"],
                    "default": "zone-a",
                    "description": "Cultivation zone containing the target device instance.",
                },
                "rationale": {"type": "string", "minLength": 3, "maxLength": 1000},
                "requested_action": {
                    "type": "string",
                    "enum": ["set_actuator_state", "recalibrate_air_temperature_sensor"],
                    "default": "set_actuator_state",
                },
                "requested_target": {
                    "type": "string",
                    "enum": [
                        "ventilation_fan",
                        "roof_vent",
                        "side_vent",
                        "irrigation_pump",
                        "heater",
                        "root_zone_chiller",
                        "shade_curtain",
                        "air_temperature_sensor_reset",
                    ],
                },
                "origin": {"type": "string", "enum": ["verified_telemetry_rule", "manual"]},
                "advisor_run_id": {"type": "string", "minLength": 1, "maxLength": 128},
                "evidence_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "maxItems": 20,
                    "description": "Evidence identifiers only; source text is not accepted.",
                },
                "alert_id": {"type": "string", "minLength": 1, "maxLength": 200},
                "alert_occurrence_id": {"type": "string", "minLength": 1, "maxLength": 128},
            },
            "required": ["action", "target_value", "rationale"],
            "additionalProperties": False,
        },
    },
    {
        "name": "approve_control_proposal",
        "description": "Approve a pending simulated-only proposal and apply it only to the deterministic simulator.",
        "inputSchema": {
            "type": "object",
            "properties": {"proposal_id": {"type": "string", "minLength": 1}},
            "required": ["proposal_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "reject_control_proposal",
        "description": "Close a pending simulated-only proposal without executing telemetry control.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "proposal_id": {"type": "string", "minLength": 1},
                "reason": {"type": "string", "minLength": 2, "maxLength": 1000},
            },
            "required": ["proposal_id"],
            "additionalProperties": False,
        },
    },
]
