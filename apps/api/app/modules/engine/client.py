from __future__ import annotations

from typing import Any

import httpx
from fastapi import HTTPException

from app.modules.engine.service_auth import mint_service_token
from app.shared.infrastructure.settings import get_settings


class EngineClient:
    def __init__(self) -> None:
        self._settings = get_settings()

    async def execute_query(
        self,
        *,
        datasource_id: int,
        workspace_id: int,
        query_spec: dict[str, Any],
        dataset_id: int | None = None,
        datasource_url: str | None = None,
        actor_user_id: int | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            method="POST",
            path="/query/execute",
            json_payload={
                "datasource_id": datasource_id,
                "dataset_id": dataset_id,
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "spec": query_spec,
            },
            datasource_id=datasource_id,
            workspace_id=workspace_id,
            dataset_id=dataset_id,
            datasource_url=datasource_url,
            actor_user_id=actor_user_id,
            correlation_id=correlation_id,
        )

    async def execute_query_batch(
        self,
        *,
        datasource_id: int,
        workspace_id: int,
        queries: list[dict[str, Any]],
        dataset_id: int | None = None,
        datasource_url: str | None = None,
        actor_user_id: int | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            method="POST",
            path="/query/execute/batch",
            json_payload={
                "datasource_id": datasource_id,
                "dataset_id": dataset_id,
                "workspace_id": workspace_id,
                "actor_user_id": actor_user_id,
                "queries": queries,
            },
            datasource_id=datasource_id,
            workspace_id=workspace_id,
            dataset_id=dataset_id,
            datasource_url=datasource_url,
            actor_user_id=actor_user_id,
            correlation_id=correlation_id,
        )

    async def list_resources(
        self,
        *,
        datasource_id: int,
        workspace_id: int,
        dataset_id: int | None = None,
        datasource_url: str | None = None,
        actor_user_id: int | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            method="GET",
            path="/catalog/resources",
            query_params={
                "datasource_id": datasource_id,
                "workspace_id": workspace_id,
                "dataset_id": dataset_id,
            },
            datasource_id=datasource_id,
            workspace_id=workspace_id,
            dataset_id=dataset_id,
            datasource_url=datasource_url,
            actor_user_id=actor_user_id,
            correlation_id=correlation_id,
        )

    async def get_schema(
        self,
        *,
        datasource_id: int,
        workspace_id: int,
        resource_id: str,
        dataset_id: int | None = None,
        datasource_url: str | None = None,
        actor_user_id: int | None = None,
        correlation_id: str | None = None,
    ) -> dict[str, Any]:
        return await self._request(
            method="GET",
            path=f"/schema/{resource_id}",
            query_params={
                "datasource_id": datasource_id,
                "workspace_id": workspace_id,
                "dataset_id": dataset_id,
            },
            datasource_id=datasource_id,
            workspace_id=workspace_id,
            dataset_id=dataset_id,
            datasource_url=datasource_url,
            actor_user_id=actor_user_id,
            correlation_id=correlation_id,
        )

    async def _request(
        self,
        *,
        method: str,
        path: str,
        datasource_id: int,
        workspace_id: int,
        dataset_id: int | None = None,
        datasource_url: str | None = None,
        actor_user_id: int | None = None,
        correlation_id: str | None = None,
        json_payload: dict[str, Any] | None = None,
        query_params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        service_token = mint_service_token(
            secret=self._settings.engine_service_secret,
            subject="istari-api-service",
            workspace_id=workspace_id,
            actor_user_id=actor_user_id,
            datasource_id=datasource_id,
            dataset_id=dataset_id,
            ttl_seconds=int(getattr(self._settings, "engine_service_token_ttl_seconds", 120)),
        )
        headers: dict[str, str] = {"Authorization": f"Bearer {service_token}"}
        if correlation_id:
            headers["x-correlation-id"] = correlation_id

        timeout = float(getattr(self._settings, "engine_timeout_seconds", 30))

        try:
            async with httpx.AsyncClient(base_url=self._settings.engine_base_url, timeout=timeout) as client:
                if datasource_url:
                    register_payload = {
                        "datasource_id": datasource_id,
                        "datasource_url": datasource_url,
                        "workspace_id": workspace_id,
                        "dataset_id": dataset_id,
                    }
                    register_response = await client.post(
                        "/internal/datasources/register",
                        json=register_payload,
                        headers=headers,
                    )
                    if register_response.status_code >= 400:
                        raise HTTPException(status_code=register_response.status_code, detail="Failed to register datasource")

                response = await client.request(
                    method=method,
                    url=path,
                    json=json_payload,
                    params=query_params,
                    headers=headers,
                )
        except httpx.RequestError as exc:
            raise HTTPException(status_code=503, detail=f"Engine service unavailable: {exc}") from exc

        if response.status_code >= 400:
            try:
                detail: Any = response.json()
            except Exception:
                detail = {"error": {"code": "engine_error", "message": response.text or "Engine request failed"}}
            raise HTTPException(status_code=response.status_code, detail=detail)

        return response.json()


_engine_client = EngineClient()


def get_engine_client() -> EngineClient:
    return _engine_client
