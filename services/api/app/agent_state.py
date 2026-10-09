"""Typed records for the persisted, bounded advisor agent state."""

from __future__ import annotations

from typing import Any, Literal, TypedDict


AgentRunStatus = Literal[
    "running",
    "awaiting_approval",
    "executing",
    "verifying",
    "completed",
    "failed",
]
AgentRunStepStatus = Literal["running", "completed", "failed"]

AGENT_RUN_STATUSES: frozenset[str] = frozenset(
    {
        "running",
        "awaiting_approval",
        "executing",
        "verifying",
        "completed",
        "failed",
    }
)
AGENT_RUN_STEP_STATUSES: frozenset[str] = frozenset({"running", "completed", "failed"})


class AgentRunStepRecord(TypedDict):
    id: str
    run_id: str
    sequence: int
    kind: str
    status: AgentRunStepStatus
    tool_name: str | None
    input: dict[str, Any] | None
    output: dict[str, Any] | None
    error: str | None
    created_at: str
    completed_at: str | None


class AgentRunRecord(TypedDict):
    id: str
    session_id: str
    farm_id: str
    owner_id: str
    user_goal: str
    status: AgentRunStatus
    current_target: str | None
    current_action: str | None
    current_value: Any
    context: dict[str, Any]
    result: dict[str, Any] | None
    error: str | None
    created_at: str
    updated_at: str
    completed_at: str | None
    steps: list[AgentRunStepRecord]


class AgentControlContext(TypedDict):
    run_id: str
    target: str
    action: str | None
    value: Any
    updated_at: str
