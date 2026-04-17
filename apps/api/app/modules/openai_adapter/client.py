from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import httpx
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.modules.core.legacy.models import LLMIntegration
from app.modules.openai_adapter.errors import (
    OpenAIAdapterError,
    OpenAIAdapterHTTPError,
    OpenAIAdapterParsingError,
    OpenAIAdapterSchemaError,
)
from app.modules.openai_adapter.schemas import OpenAITraceMetadata
from app.modules.security.adapters.fernet_encryptor import credential_encryptor

OPENAI_BASE_URL = "https://api.openai.com/v1"


@dataclass(frozen=True)
class OpenAIRuntimeConfig:
    api_key: str
    model: str
    integration_id: int | None = None


def resolve_active_openai_runtime(db: Session) -> OpenAIRuntimeConfig | None:
    integration = (
        db.query(LLMIntegration)
        .filter(LLMIntegration.provider == "openai", LLMIntegration.is_active == True)  # noqa: E712
        .order_by(LLMIntegration.updated_at.desc())
        .first()
    )
    if integration is None:
        return None
    try:
        api_key = credential_encryptor.decrypt(integration.encrypted_api_key)
    except Exception:
        return None
    return OpenAIRuntimeConfig(
        api_key=api_key,
        model=integration.model or "gpt-4o-mini",
        integration_id=int(integration.id),
    )


class OpenAIAdapterClient:
    def __init__(
        self,
        *,
        timeout_seconds: float = 30.0,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.4,
        base_url: str = OPENAI_BASE_URL,
    ) -> None:
        self.timeout_seconds = float(timeout_seconds)
        self.max_retries = int(max_retries)
        self.retry_backoff_seconds = float(retry_backoff_seconds)
        self.base_url = base_url.rstrip("/")

    async def responses_request(
        self,
        *,
        runtime: OpenAIRuntimeConfig,
        input_payload: list[dict[str, Any]],
        lens_trace_id: str,
        task: str,
        schema_name: str | None = None,
        text_format: dict[str, Any] | None = None,
        extra_payload: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], OpenAITraceMetadata]:
        payload: dict[str, Any] = {
            "model": runtime.model,
            "store": False,
            "input": input_payload,
        }
        if isinstance(text_format, dict):
            payload["text"] = {"format": text_format}
        if isinstance(extra_payload, dict):
            payload.update(extra_payload)

        headers = {
            "Authorization": f"Bearer {runtime.api_key}",
            "Content-Type": "application/json",
        }
        start = time.perf_counter()
        last_error: Exception | None = None
        attempts = 0
        response_json: dict[str, Any] | None = None
        response_id: str | None = None
        request_id: str | None = None

        for attempt in range(1, self.max_retries + 2):
            attempts = attempt
            try:
                async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                    response = await client.post(f"{self.base_url}/responses", headers=headers, json=payload)
                request_id = response.headers.get("x-request-id")
                if response.status_code >= 400:
                    detail = None
                    try:
                        parsed = response.json()
                        if isinstance(parsed, dict):
                            detail = str((parsed.get("error") or {}).get("message") or "")
                    except Exception:
                        detail = None
                    http_error = OpenAIAdapterHTTPError(
                        "OpenAI Responses request failed",
                        status_code=int(response.status_code),
                        detail=detail,
                    )
                    if self._is_retryable_http_status(response.status_code) and attempt <= self.max_retries:
                        last_error = http_error
                        await asyncio.sleep(self.retry_backoff_seconds * attempt)
                        continue
                    raise http_error
                parsed_json = response.json()
                if not isinstance(parsed_json, dict):
                    raise OpenAIAdapterParsingError("OpenAI response payload is not a JSON object")
                response_json = parsed_json
                if isinstance(parsed_json.get("id"), str):
                    response_id = parsed_json["id"]
                break
            except OpenAIAdapterError:
                raise
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if attempt <= self.max_retries:
                    await asyncio.sleep(self.retry_backoff_seconds * attempt)
                    continue
                raise OpenAIAdapterError("OpenAI request failed due network/timeout", code="openai_network_error") from exc
            except Exception as exc:
                raise OpenAIAdapterError("Unhandled OpenAI adapter request failure", code="openai_unhandled_error") from exc

        if response_json is None:
            if isinstance(last_error, Exception):
                raise OpenAIAdapterError(f"OpenAI call exhausted retries: {last_error}", code="openai_retry_exhausted")
            raise OpenAIAdapterError("OpenAI call exhausted retries with unknown error", code="openai_retry_exhausted")

        latency_ms = int((time.perf_counter() - start) * 1000)
        trace = OpenAITraceMetadata(
            call_id=uuid4().hex,
            lens_trace_id=lens_trace_id,
            task=task,
            model=runtime.model,
            schema_name=schema_name,
            request_id=request_id,
            response_id=response_id,
            success=True,
            accepted=True,
            used_fallback=False,
            attempts=attempts,
            latency_ms=latency_ms,
            metadata={"integration_id": runtime.integration_id},
        )
        return response_json, trace

    async def responses_structured(
        self,
        *,
        runtime: OpenAIRuntimeConfig,
        input_payload: list[dict[str, Any]],
        lens_trace_id: str,
        task: str,
        schema_name: str,
        schema: dict[str, Any],
        output_model: type[BaseModel] | None = None,
    ) -> tuple[dict[str, Any], OpenAITraceMetadata]:
        response_json, trace = await self.responses_request(
            runtime=runtime,
            input_payload=input_payload,
            lens_trace_id=lens_trace_id,
            task=task,
            schema_name=schema_name,
            text_format={"type": "json_schema", "json_schema": schema},
        )
        parsed = self._extract_json_payload(response_json)
        if not isinstance(parsed, dict):
            raise OpenAIAdapterParsingError("Structured output parsing failed: object payload not found")
        if output_model is not None:
            try:
                output_model.model_validate(parsed)
            except ValidationError as exc:
                raise OpenAIAdapterSchemaError(f"Structured output schema validation failed: {exc}") from exc
        return parsed, trace

    def extract_json_payload(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        return self._extract_json_payload(payload)

    def _extract_json_payload(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        top_level_output_text = payload.get("output_text")
        if isinstance(top_level_output_text, str) and top_level_output_text.strip():
            parsed = self._try_parse_json(top_level_output_text)
            if isinstance(parsed, dict):
                return parsed

        output_items = payload.get("output", [])
        if not isinstance(output_items, list):
            return None

        collected_text: list[str] = []
        for item in output_items:
            if not isinstance(item, dict):
                continue
            direct_text = item.get("text")
            if isinstance(direct_text, str):
                collected_text.append(direct_text)
            content_items = item.get("content", [])
            if not isinstance(content_items, list):
                continue
            for content in content_items:
                if not isinstance(content, dict):
                    continue
                if isinstance(content.get("json"), dict):
                    return content["json"]
                if isinstance(content.get("output_json"), dict):
                    return content["output_json"]
                text_value = content.get("text")
                if isinstance(text_value, str):
                    collected_text.append(text_value)
                output_text = content.get("output_text")
                if isinstance(output_text, str):
                    collected_text.append(output_text)

        if len(collected_text) == 0:
            return None
        combined = "\n".join(collected_text).strip()
        parsed = self._try_parse_json(combined)
        return parsed if isinstance(parsed, dict) else None

    def _try_parse_json(self, raw: str) -> Any:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            start = raw.find("{")
            end = raw.rfind("}")
            if start >= 0 and end > start:
                try:
                    return json.loads(raw[start : end + 1])
                except json.JSONDecodeError:
                    return None
            return None

    def _is_retryable_http_status(self, status_code: int) -> bool:
        return int(status_code) in {408, 409, 429, 500, 502, 503, 504}


_openai_adapter_client_singleton: OpenAIAdapterClient | None = None


def get_openai_adapter_client() -> OpenAIAdapterClient:
    global _openai_adapter_client_singleton
    if _openai_adapter_client_singleton is None:
        _openai_adapter_client_singleton = OpenAIAdapterClient()
    return _openai_adapter_client_singleton
