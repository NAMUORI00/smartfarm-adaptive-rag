from __future__ import annotations

import os
from typing import Any, Protocol

import httpx

from .contracts import ControlProposal


class TelemetryGatewayError(RuntimeError):
    pass


class TelemetryGatewayConflictError(TelemetryGatewayError):
    pass


class TelemetryGateway(Protocol):
    async def snapshot(self, farm_id: str) -> dict[str, Any]: ...

    async def timeseries(
        self,
        farm_id: str,
        metric: str,
        start: str,
        end: str,
        interval_minutes: int,
        zone_id: str = "zone-a",
    ) -> dict[str, Any]: ...

    async def alerts(self, farm_id: str, status: str | None = None) -> list[dict[str, Any]]: ...

    async def execute_simulated_control(self, proposal: ControlProposal) -> dict[str, Any]: ...


class HttpTelemetryGateway:
    def __init__(self, base_url: str | None = None, internal_token: str | None = None) -> None:
        self.base_url = (base_url or os.getenv("TELEMETRY_BASE_URL", "http://telemetry:8001")).rstrip("/")
        self.internal_token = internal_token or os.getenv("TELEMETRY_INTERNAL_TOKEN", "local-development-token")

    async def snapshot(self, farm_id: str) -> dict[str, Any]:
        return await self._request("GET", "/v1/telemetry/snapshot", params={"farm_id": farm_id})

    async def timeseries(
        self,
        farm_id: str,
        metric: str,
        start: str,
        end: str,
        interval_minutes: int,
        zone_id: str = "zone-a",
    ) -> dict[str, Any]:
        return await self._request(
            "GET",
            "/v1/telemetry/series",
            params={
                "farm_id": farm_id,
                "metric": metric,
                "start": start,
                "end": end,
                "interval_minutes": interval_minutes,
                "zone_id": zone_id,
            },
        )

    async def alerts(self, farm_id: str, status: str | None = None) -> list[dict[str, Any]]:
        params = {"farm_id": farm_id}
        if status:
            params["status"] = status
        payload = await self._request("GET", "/v1/telemetry/alerts", params=params)
        if not isinstance(payload, list):
            raise TelemetryGatewayError("Telemetry alerts response was not a list")
        return payload

    async def execute_simulated_control(self, proposal: ControlProposal) -> dict[str, Any]:
        return await self._request(
            "POST",
            "/v1/internal/simulated-control-commands",
            headers={
                "X-Internal-Service-Token": self.internal_token,
                "X-Correlation-Id": proposal.correlation_id,
            },
            json={
                "proposal_id": proposal.proposal_id,
                "farm_id": proposal.farm_id,
                "action": proposal.action.value,
                "target_value": proposal.target_value,
                "zone_id": proposal.zone_id,
                "requested_by": proposal.proposed_by,
                "alert_id": proposal.alert_id,
                "alert_occurrence_id": proposal.alert_occurrence_id,
                "correlation_id": proposal.correlation_id,
            },
        )

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with httpx.AsyncClient(base_url=self.base_url, timeout=5.0) as client:
                response = await client.request(method, path, **kwargs)
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as error:
            detail = error.response.text
            try:
                detail = str(error.response.json().get("detail", detail))
            except (AttributeError, ValueError):
                pass
            if error.response.status_code == 409:
                raise TelemetryGatewayConflictError(detail) from error
            raise TelemetryGatewayError(f"Telemetry service request failed: {error}") from error
        except (httpx.HTTPError, ValueError) as error:
            raise TelemetryGatewayError(f"Telemetry service request failed: {error}") from error
