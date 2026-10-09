from __future__ import annotations

import json
import hmac
import os
import uuid
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse

from .contracts import (
    ActorRole,
    AlertToolArguments,
    AuditEvent,
    ControlProposal,
    ControlProposalCreate,
    ControlProposalReject,
    JsonRpcRequest,
    RequestContext,
    TimeseriesToolArguments,
    ToolCallRequest,
)
from .mcp_schema import TOOL_DEFINITIONS
from .device_adapter import DeviceCommandAdapter
from .service import FarmOperationsService, ToolInputError
from .telemetry_client import HttpTelemetryGateway, TelemetryGateway, TelemetryGatewayError


def _require_internal_service_token(
    x_internal_service_token: Annotated[str | None, Header(alias="X-Internal-Service-Token")] = None,
) -> None:
    """Only the authenticated product API may call this internal service."""
    expected_token = os.getenv("MCP_SERVICE_TOKEN", "local-mcp-development-token")
    if not x_internal_service_token or not hmac.compare_digest(x_internal_service_token, expected_token):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid internal service token")


def _context_from_headers(
    request: Request,
    x_farm_id: Annotated[str | None, Header(alias="X-Farm-Id")] = None,
    x_actor_id: Annotated[str | None, Header(alias="X-Actor-Id")] = None,
    x_actor_role: Annotated[str | None, Header(alias="X-Actor-Role")] = None,
    x_correlation_id: Annotated[str | None, Header(alias="X-Correlation-Id")] = None,
) -> RequestContext:
    if not x_farm_id or not x_actor_id or not x_actor_role:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Trusted farm, actor, and role headers are required",
        )
    try:
        role = ActorRole(x_actor_role.lower())
    except ValueError as error:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid actor role") from error
    return RequestContext(
        farm_id=x_farm_id,
        actor_id=x_actor_id,
        actor_role=role,
        correlation_id=x_correlation_id or request.state.correlation_id,
    )


def _json_rpc_result(request_id: str | int | None, result: dict[str, Any]) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": request_id, "result": result})


def _json_rpc_error(request_id: str | int | None, code: int, message: str) -> JSONResponse:
    return JSONResponse({"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}})


def _tool_result(payload: Any, is_error: bool = False) -> dict[str, Any]:
    if hasattr(payload, "model_dump"):
        serializable = payload.model_dump(mode="json")
    else:
        serializable = payload
    return {
        "content": [{"type": "text", "text": json.dumps(serializable, ensure_ascii=False)}],
        "structuredContent": serializable,
        "isError": is_error,
    }


def create_app(
    telemetry: TelemetryGateway | None = None,
    state_path: str | None = None,
    audit_retention: int = 1_000,
    device_adapter: DeviceCommandAdapter | None = None,
) -> FastAPI:
    app = FastAPI(
        title="SmartFarm FarmOps MCP",
        version="0.2.0",
        description=(
            "Internal MCP server for read-only farm context and approval-gated, "
            "simulated-only control proposals. It cannot control physical devices."
        ),
        dependencies=[Depends(_require_internal_service_token)],
    )
    service = FarmOperationsService(
        telemetry or HttpTelemetryGateway(),
        state_path=state_path or os.getenv("FARM_MCP_STATE_PATH"),
        audit_retention=audit_retention,
        device_adapter=device_adapter,
    )
    app.state.farm_operations = service

    @app.middleware("http")
    async def attach_correlation_id(request: Request, call_next: Any) -> Response:
        correlation_id = request.headers.get("X-Correlation-Id") or str(uuid.uuid4())
        request.state.correlation_id = correlation_id
        response = await call_next(request)
        response.headers["X-Correlation-Id"] = correlation_id
        return response

    @app.get("/health", tags=["system"])
    def health() -> dict[str, Any]:
        return {"status": "ok", "service": "farm-mcp", "simulated_only": True}

    @app.get("/v1/farm/snapshot", tags=["farm"])
    async def get_snapshot(context: Annotated[RequestContext, Depends(_context_from_headers)]) -> dict[str, Any]:
        try:
            return await service.snapshot(context)
        except TelemetryGatewayError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.get("/v1/farm/telemetry/series", tags=["farm"])
    async def get_timeseries(
        metric: str,
        start: str,
        end: str,
        interval_minutes: int = Query(default=10, ge=1, le=60),
        zone_id: Literal["zone-a", "zone-b"] = "zone-a",
        context: RequestContext = Depends(_context_from_headers),
    ) -> dict[str, Any]:
        try:
            arguments = TimeseriesToolArguments.model_validate(
                {
                    "metric": metric,
                    "start": start,
                    "end": end,
                    "interval_minutes": interval_minutes,
                    "zone_id": zone_id,
                }
            )
            return await service.timeseries(context, arguments)
        except ValueError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
        except TelemetryGatewayError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.get("/v1/farm/alerts", tags=["farm"])
    async def list_alerts(
        status_filter: Annotated[str | None, Query(alias="status")] = None,
        context: RequestContext = Depends(_context_from_headers),
    ) -> list[dict[str, Any]]:
        try:
            arguments = AlertToolArguments(status=status_filter)
            return await service.alerts(context, arguments.status)
        except ValueError as error:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)) from error
        except TelemetryGatewayError as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error

    @app.post("/v1/control/proposals", response_model=ControlProposal, tags=["control"])
    def propose_control(
        request: ControlProposalCreate,
        context: Annotated[RequestContext, Depends(_context_from_headers)],
    ) -> ControlProposal:
        return service.propose_control(context, request)

    @app.get("/v1/control/proposals", response_model=list[ControlProposal], tags=["control"])
    def list_control_proposals(
        context: Annotated[RequestContext, Depends(_context_from_headers)],
    ) -> list[ControlProposal]:
        return service.list_proposals(context)

    @app.get("/v1/control/proposals/{proposal_id}", response_model=ControlProposal, tags=["control"])
    def get_control_proposal(
        proposal_id: str,
        context: Annotated[RequestContext, Depends(_context_from_headers)],
    ) -> ControlProposal:
        return service.get_proposal(context, proposal_id)

    @app.post("/v1/internal/demo-reset", tags=["control"])
    def reset_demo_state(
        context: Annotated[RequestContext, Depends(_context_from_headers)],
    ) -> dict[str, Any]:
        return {
            "farm_id": context.farm_id,
            "reset_proposals": service.reset_demo_state(context),
            "simulated_only": True,
        }

    @app.post("/v1/control/proposals/{proposal_id}/approve", response_model=ControlProposal, tags=["control"])
    async def approve_control(
        proposal_id: str,
        context: Annotated[RequestContext, Depends(_context_from_headers)],
    ) -> ControlProposal:
        return await service.approve_control(context, proposal_id)

    @app.post("/v1/control/proposals/{proposal_id}/reject", response_model=ControlProposal, tags=["control"])
    def reject_control(
        proposal_id: str,
        request: ControlProposalReject,
        context: Annotated[RequestContext, Depends(_context_from_headers)],
    ) -> ControlProposal:
        return service.reject_control(context, proposal_id, request.reason)

    @app.get("/v1/audit/events", response_model=list[AuditEvent], tags=["audit"])
    def list_audit_events(
        context: Annotated[RequestContext, Depends(_context_from_headers)],
        limit: int = Query(default=100, ge=1, le=500),
    ) -> list[AuditEvent]:
        return service.audit_events(context, limit)

    @app.post("/mcp", tags=["mcp"])
    async def mcp(
        request: JsonRpcRequest,
        context: Annotated[RequestContext, Depends(_context_from_headers)],
    ) -> Response:
        if request.method == "initialize":
            return _json_rpc_result(
                request.id,
                {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "smartfarm-farmops", "version": "0.2.0"},
                },
            )
        if request.method == "notifications/initialized":
            return Response(status_code=status.HTTP_202_ACCEPTED)
        if request.method == "tools/list":
            return _json_rpc_result(request.id, {"tools": TOOL_DEFINITIONS})
        if request.method != "tools/call":
            return _json_rpc_error(request.id, -32601, "Method not found")
        try:
            tool_request = ToolCallRequest.model_validate(request.params)
            payload = await service.call_tool(context, tool_request.name, tool_request.arguments.copy())
            return _json_rpc_result(request.id, _tool_result(payload))
        except (ToolInputError, ValueError) as error:
            return _json_rpc_result(request.id, _tool_result({"error": str(error)}, is_error=True))
        except HTTPException as error:
            return _json_rpc_result(request.id, _tool_result({"error": error.detail}, is_error=True))
        except TelemetryGatewayError as error:
            return _json_rpc_result(request.id, _tool_result({"error": str(error)}, is_error=True))

    return app


app = create_app()
