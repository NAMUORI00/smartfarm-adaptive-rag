from __future__ import annotations

import os
import logging
from contextlib import asynccontextmanager
from threading import Event, Thread
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Annotated, Any, Callable, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, status
from pydantic import BaseModel, Field, ValidationError
from . import operating_runtime


class OperatingRequest(BaseModel):
    farm_id: str
    action: Literal["start", "pause", "resume", "repair", "stop"]
    seed: int | None = Field(default=None, ge=0, le=2147483647)
    instance_id: str | None = None
    request_id: str | None = None

from .contracts import (
    AlertStatus,
    ControlExecution,
    CultivationStrategyRuntime,
    CultivationStrategyUpdateRequest,
    DemoScenarioActivationRequest,
    DemoScenarioDefinition,
    DemoScenarioState,
    FarmInfo,
    FarmSnapshot,
    GatewayStatus,
    HealthResponse,
    IncidentRecord,
    SensorMetric,
    SimulatedControlCommand,
    TelemetryIngressRequest,
    TelemetryIngressValidationResponse,
    TelemetryReplayRequest,
    TelemetryReplayResponse,
    TelemetryAlert,
    TimeseriesResponse,
    VirtualClockState,
    VirtualClockUpdateRequest,
)
from .simulator import (
    ControlProposalConflictError,
    InvalidControlCommandError,
    InvalidTelemetryIngressError,
    KoreanGreenhouseSimulator,
    TelemetryIngressConflictError,
    UnknownFarmError,
)


DEFAULT_INTERNAL_TOKEN = "local-development-token"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def create_app(
    now_provider: Callable[[], datetime] = _utc_now,
    state_path: str | Path | None = None,
) -> FastAPI:
    app = FastAPI(
        title="SmartFarm Telemetry Simulator",
        version="0.1.0",
        description="Deterministic local-only Korean facility-horticulture telemetry simulator.",
    )
    simulator = KoreanGreenhouseSimulator(
        state_path=state_path if state_path is not None else os.getenv("TELEMETRY_STATE_PATH")
    )
    app.state.simulator = simulator

    def wall_time() -> datetime:
        value = now_provider()
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)

    def current_time() -> datetime:
        return simulator.virtual_time(wall_time())

    def require_internal_token(
        x_internal_service_token: Annotated[str | None, Header()] = None,
    ) -> None:
        expected_token = os.getenv("TELEMETRY_INTERNAL_TOKEN", DEFAULT_INTERNAL_TOKEN)
        if x_internal_service_token != expected_token:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal service token")

    def ingress_identity(payload: dict[str, Any]) -> tuple[str, str | None, str | None]:
        farm_id = payload.get("farm_id")
        source = payload.get("source")
        message_id = payload.get("message_id")
        return (
            str(farm_id) if isinstance(farm_id, str) and farm_id else "farm-wasabi-a",
            str(source) if isinstance(source, str) else None,
            str(message_id) if isinstance(message_id, str) else None,
        )

    stop_runtime = Event()

    def runtime_loop():
        while not stop_runtime.wait(2):
            try:
                with simulator._state_lock:
                    for farm_id in list(simulator._operating_runs):
                        operating_runtime.tick(simulator, farm_id, wall_time())
            except Exception:
                logging.getLogger(__name__).exception("Continuous simulation paused after tick failure")
                with simulator._state_lock:
                    for run in simulator._operating_runs.values():
                        run["status"] = "paused"
                        run["stable_since"] = None

    def start_runtime_loop():
        # One process owns the persisted simulator, including read-driven legacy state.
        if simulator._store:
            lease = open(str(simulator._store.path) + ".owner.lock", "a+b")
            lease.seek(0)
            if os.name == "nt":
                import msvcrt
                if not lease.read(1):
                    lease.write(b"0")
                    lease.flush()
                lease.seek(0)
                msvcrt.locking(lease.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
            app.state.runtime_lease = lease
        stop_runtime.clear()
        app.state.runtime_thread = Thread(target=runtime_loop, daemon=True)
        app.state.runtime_thread.start()

    def stop_runtime_loop():
        stop_runtime.set()
        if hasattr(app.state, "runtime_thread"):
            app.state.runtime_thread.join(timeout=5)
        if hasattr(app.state, "runtime_lease"):
            app.state.runtime_lease.close()

    @asynccontextmanager
    async def runtime_lifespan(application):
        start_runtime_loop()
        try:
            yield
        finally:
            stop_runtime_loop()

    app.router.lifespan_context = runtime_lifespan

    @app.get("/v1/telemetry/runtime")
    def operating_state(farm_id: str, request_id: str | None = None):
        simulator._farm(farm_id)
        with simulator._state_lock:
            run = simulator._operating_runs.get(farm_id)
            result = operating_runtime.public_state(run)
            if request_id:
                result["request_status"] = "confirmed" if run and any(e.get("request_id") == request_id for saved in [run, *run.get("previous_runs", [])] for e in saved.get("history", [])) else "unknown"
            return result

    @app.post("/v1/internal/demo-runtime", dependencies=[Depends(require_internal_token)])
    def operating_change(request: OperatingRequest):
        with simulator._state_lock:
            try:
                if request.action == "start":
                    return operating_runtime.start(simulator, request.farm_id, wall_time(), request.seed)
                run = simulator._operating_runs.get(request.farm_id)
                if not run:
                    raise ValueError("시뮬레이션 운영을 먼저 시작하세요.")
                if run["status"] == "stopped" and request.action != "stop":
                    raise ValueError("종료된 시연입니다. 새 실행을 시작하세요.")
                if request.action == "repair":
                    if not request.request_id or not request.instance_id:
                        raise ValueError("점검 대상과 요청 번호가 필요합니다.")
                    return operating_runtime.repair(simulator, request.farm_id, wall_time(), request.instance_id, request.request_id)
                run["status"] = "stopped" if request.action == "stop" else "paused" if request.action == "pause" else "running"
                run["last_tick"] = wall_time().isoformat()
                run["stable_since"] = None
                simulator._alert_clear_candidates.pop(request.farm_id, None)
                simulator._persist_state()
                return operating_runtime.public_state(run)
            except ValueError as error:
                raise HTTPException(409, str(error)) from error

    def validation_reason(error: ValidationError) -> tuple[str, list[str]]:
        issues = [item["msg"] for item in error.errors()]
        combined = " ".join(issues).lower()
        if "duplicate sensor" in combined:
            return "duplicate_sensor", issues
        if "canonical unit" in combined:
            return "unit", issues
        return "schema", issues

    @app.get("/health", response_model=HealthResponse, tags=["system"])
    def health() -> HealthResponse:
        return HealthResponse()

    @app.get("/v1/telemetry/farms", response_model=list[FarmInfo], tags=["telemetry"])
    def list_farms() -> list[FarmInfo]:
        return simulator.list_farms()

    @app.get("/v1/telemetry/scenarios", response_model=list[DemoScenarioDefinition], tags=["telemetry"])
    def list_scenarios() -> list[DemoScenarioDefinition]:
        """Describe the deterministic conditions that can be selected for a local demo."""
        return simulator.list_scenarios()

    @app.get("/v1/telemetry/clock", response_model=VirtualClockState, tags=["telemetry"])
    def get_clock(
        farm_id: Annotated[str, Query(min_length=1)],
    ) -> VirtualClockState:
        try:
            return simulator.clock_state(farm_id, wall_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.patch(
        "/v1/internal/telemetry/clock",
        response_model=VirtualClockState,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def update_clock(request: VirtualClockUpdateRequest) -> VirtualClockState:
        try:
            return simulator.update_clock(request, wall_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.get("/v1/telemetry/incidents", response_model=list[IncidentRecord], tags=["telemetry"])
    def list_incidents(
        farm_id: Annotated[str, Query(min_length=1)],
        limit: Annotated[int, Query(ge=1, le=500)] = 200,
    ) -> list[IncidentRecord]:
        try:
            return simulator.incident_history(farm_id, limit)
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.get("/v1/telemetry/gateway-status", response_model=GatewayStatus, tags=["telemetry"])
    def gateway_status(
        farm_id: Annotated[str, Query(min_length=1)],
    ) -> GatewayStatus:
        try:
            return simulator.gateway_status(farm_id, current_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.get(
        "/v1/internal/cultivation-strategy",
        response_model=CultivationStrategyRuntime | None,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def active_cultivation_strategy(
        farm_id: Annotated[str, Query(min_length=1)],
    ) -> CultivationStrategyRuntime | None:
        try:
            return simulator.active_cultivation_strategy(farm_id)
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.put(
        "/v1/internal/cultivation-strategy",
        response_model=CultivationStrategyRuntime,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def apply_cultivation_strategy(
        request: CultivationStrategyUpdateRequest,
    ) -> CultivationStrategyRuntime:
        try:
            return simulator.apply_cultivation_strategy(request, current_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.post(
        "/v1/internal/telemetry/incidents/{incident_id}/acknowledge",
        response_model=IncidentRecord,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def acknowledge_incident(
        incident_id: str,
        farm_id: Annotated[str, Query(min_length=1)],
    ) -> IncidentRecord:
        try:
            return simulator.acknowledge_incident(farm_id, incident_id, current_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.get("/v1/telemetry/scenario", response_model=DemoScenarioState, tags=["telemetry"])
    def get_scenario_state(
        farm_id: Annotated[str, Query(min_length=1)],
    ) -> DemoScenarioState:
        try:
            return simulator.scenario_state(farm_id, current_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.get("/v1/telemetry/snapshot", response_model=FarmSnapshot, tags=["telemetry"])
    def get_snapshot(
        farm_id: Annotated[str, Query(min_length=1)],
        at: datetime | None = None,
    ) -> FarmSnapshot:
        try:
            request_wall_time = wall_time()
            return simulator.snapshot(
                farm_id,
                at or simulator.virtual_time(request_wall_time),
                wall_now=request_wall_time,
                reconcile_alert_occurrences=at is None,
            )
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.get("/v1/telemetry/series", response_model=TimeseriesResponse, tags=["telemetry"])
    def get_series(
        farm_id: Annotated[str, Query(min_length=1)],
        metric: SensorMetric,
        start: datetime,
        end: datetime,
        interval_minutes: Annotated[int, Query(ge=1, le=60)] = 10,
        zone_id: Annotated[Literal["zone-a", "zone-b"], Query()] = "zone-a",
    ) -> TimeseriesResponse:
        if end <= start:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="end must be after start")
        if end - start > timedelta(days=7):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="series range is limited to seven days")
        point_count = int((end - start).total_seconds() / (interval_minutes * 60)) + 1
        if point_count > 1_000:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="series has too many points")
        try:
            return simulator.timeseries(farm_id, metric, start, end, interval_minutes, zone_id)
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error

    @app.get("/v1/telemetry/alerts", response_model=list[TelemetryAlert], tags=["telemetry"])
    def list_alerts(
        farm_id: Annotated[str, Query(min_length=1)],
        status_filter: Annotated[AlertStatus | None, Query(alias="status")] = None,
        at: datetime | None = None,
    ) -> list[TelemetryAlert]:
        try:
            snapshot = simulator.snapshot(
                farm_id,
                at or current_time(),
                reconcile_alert_occurrences=at is None,
            )
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        if status_filter is None:
            return snapshot.alerts
        return [alert for alert in snapshot.alerts if alert.status == status_filter]

    @app.post(
        "/v1/internal/simulated-control-commands",
        response_model=ControlExecution,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def execute_simulated_control(
        command: SimulatedControlCommand,
        x_correlation_id: Annotated[str | None, Header(alias="X-Correlation-Id")] = None,
    ) -> ControlExecution:
        try:
            correlated_command = command.model_copy(update={"correlation_id": x_correlation_id or command.correlation_id})
            return simulator.apply_simulated_command(correlated_command, current_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except InvalidControlCommandError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
        except ControlProposalConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error

    @app.post(
        "/v1/internal/telemetry/validate",
        response_model=TelemetryIngressValidationResponse,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def validate_telemetry(payload: dict[str, Any]) -> TelemetryIngressValidationResponse:
        farm_id, source, message_id = ingress_identity(payload)
        try:
            validated = TelemetryIngressRequest.model_validate(payload)
        except ValidationError as error:
            _reason_code, issues = validation_reason(error)
            return TelemetryIngressValidationResponse(
                valid=False,
                farm_id=farm_id,
                source=source,
                message_id=message_id,
                issues=issues,
            )
        return TelemetryIngressValidationResponse(
            valid=True,
            farm_id=validated.farm_id,
            source=validated.source,
            message_id=validated.message_id,
        )

    @app.post(
        "/v1/internal/telemetry/ingest",
        response_model=FarmSnapshot,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def ingest_telemetry(
        raw_payload: dict[str, Any],
    ) -> FarmSnapshot:
        """Accept a latest-reading payload from a future broker or device adapter.

        The endpoint is intentionally internal. In this local prototype callers
        keep ``simulated_only=true``; a deployment adapter can use the same
        schema without changing the Product API's read path.
        """
        farm_id, source, message_id = ingress_identity(raw_payload)
        try:
            payload = TelemetryIngressRequest.model_validate(raw_payload)
        except ValidationError as error:
            reason_code, issues = validation_reason(error)
            try:
                simulator.record_ingress_rejection(
                    farm_id=farm_id,
                    source=source,
                    message_id=message_id,
                    rejected_at=current_time(),
                    reason_code=reason_code,
                    detail="; ".join(issues),
                )
            except UnknownFarmError:
                pass
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail={"code": reason_code, "issues": issues},
            ) from error
        try:
            return simulator.ingest_telemetry(payload, current_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except TelemetryIngressConflictError as error:
            simulator.record_ingress_rejection(
                farm_id=payload.farm_id,
                source=payload.source,
                message_id=payload.message_id,
                rejected_at=current_time(),
                reason_code="duplicate_message",
                detail=str(error),
            )
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except InvalidTelemetryIngressError as error:
            reason_code = "ordering" if "older" in str(error) or "sequence" in str(error) else "timestamp"
            simulator.record_ingress_rejection(
                farm_id=payload.farm_id,
                source=payload.source,
                message_id=payload.message_id,
                rejected_at=current_time(),
                reason_code=reason_code,
                detail=str(error),
            )
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error

    @app.post(
        "/v1/internal/telemetry/replay",
        response_model=TelemetryReplayResponse,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def replay_telemetry(request: TelemetryReplayRequest) -> TelemetryReplayResponse:
        try:
            return simulator.replay(request, wall_time())
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except TelemetryIngressConflictError as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except InvalidTelemetryIngressError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error

    @app.post(
        "/v1/internal/demo-scenarios",
        response_model=DemoScenarioState,
        dependencies=[Depends(require_internal_token)],
        tags=["internal"],
    )
    def activate_demo_scenario(
        request: DemoScenarioActivationRequest,
        x_correlation_id: Annotated[str | None, Header(alias="X-Correlation-Id")] = None,
    ) -> DemoScenarioState:
        """Activate one deterministic local-only scenario for a farm."""
        try:
            return simulator.activate_scenario(
                farm_id=request.farm_id,
                scenario_id=request.scenario_id,
                applied_at=current_time(),
                correlation_id=x_correlation_id or request.correlation_id,
                scenario_ids=request.scenario_ids,
                zone_ids=request.zone_ids,
                seed=request.seed,
            )
        except UnknownFarmError as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error

    return app


app = create_app()
