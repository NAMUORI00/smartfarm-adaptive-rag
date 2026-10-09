from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .contracts import VirtualClockState, VirtualClockUpdateRequest


def normalize_time(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc, microsecond=0)
    return value.astimezone(timezone.utc).replace(microsecond=0)


class VirtualClock:
    """Small deterministic clock for local replay and meeting-time acceleration."""

    def __init__(self, state: VirtualClockState | None = None) -> None:
        self._state = state

    def state(self, wall_now: datetime) -> VirtualClockState:
        wall = normalize_time(wall_now)
        if self._state is None:
            self._state = VirtualClockState(wall_anchor=wall, virtual_anchor=wall)
        return self._state

    def now(self, wall_now: datetime) -> datetime:
        state = self.state(wall_now)
        if state.paused:
            return normalize_time(state.virtual_anchor)
        wall = normalize_time(wall_now)
        elapsed = max(0.0, (wall - normalize_time(state.wall_anchor)).total_seconds())
        return normalize_time(state.virtual_anchor) + timedelta(seconds=elapsed * state.speed)

    def update(self, wall_now: datetime, request: VirtualClockUpdateRequest) -> VirtualClockState:
        wall = normalize_time(wall_now)
        current = self.now(wall)
        previous = self.state(wall)
        virtual_anchor = normalize_time(request.reset_to) if request.reset_to is not None else current
        self._state = VirtualClockState(
            speed=request.speed if request.speed is not None else previous.speed,
            paused=request.paused if request.paused is not None else previous.paused,
            wall_anchor=wall,
            virtual_anchor=virtual_anchor,
            seed=request.seed if request.seed is not None else previous.seed,
            revision=previous.revision + 1,
        )
        return self._state

    def restore(self, state: VirtualClockState | None) -> None:
        self._state = state

    def stored_state(self) -> VirtualClockState | None:
        return self._state
