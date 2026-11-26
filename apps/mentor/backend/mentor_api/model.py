from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

from .config import model_key, model_name, model_reasoning_effort, model_url


class ModelFailure(RuntimeError):
    """A provider failure that must be shown as a retryable degraded state."""


async def stream_completion(messages: list[dict[str, str]]) -> AsyncIterator[str]:
    url = model_url()
    key = model_key()
    if not url or not key:
        raise ModelFailure("Mentor model provider is not configured")
    responses_api = url.rstrip("/").endswith("/responses")
    payload: dict[str, Any] = {"model": model_name(), "stream": True}
    if responses_api:
        instructions = "\n\n".join(
            item["content"] for item in messages if item.get("role") == "system"
        )
        payload.update(
            {
                "input": [item for item in messages if item.get("role") != "system"],
                "store": False,
            }
        )
        if instructions:
            payload["instructions"] = instructions
        effort = model_reasoning_effort()
        if effort:
            payload["reasoning"] = {"effort": effort}
    else:
        payload["messages"] = messages
    headers = {"Authorization": f"Bearer {key}"}
    finished = False
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            async with client.stream("POST", url, json=payload, headers=headers) as response:
                if response.status_code >= 400:
                    raise ModelFailure(f"Model provider returned HTTP {response.status_code}")
                async for line in response.aiter_lines():
                    if line == "data: [DONE]":
                        finished = True
                        break
                    if not line:
                        continue
                    if line.startswith("data: "):
                        try:
                            data: dict[str, Any] = json.loads(line[6:])
                        except json.JSONDecodeError as error:
                            raise ModelFailure("Model provider returned an invalid stream") from error
                        if not isinstance(data, dict):
                            raise ModelFailure("Model provider returned an invalid stream")
                        if responses_api:
                            event_type = data.get("type")
                            if event_type == "response.output_text.delta":
                                content = data.get("delta")
                                if not isinstance(content, str):
                                    raise ModelFailure("Model provider returned invalid answer text")
                                if content:
                                    yield content
                            elif event_type == "response.completed":
                                provider_response = data.get("response")
                                if isinstance(provider_response, dict) and provider_response.get("status") not in {None, "completed"}:
                                    raise ModelFailure("Model response stopped before a complete answer")
                                finished = True
                            elif event_type in {"response.failed", "response.incomplete", "error"}:
                                raise ModelFailure("Model response stopped before a complete answer")
                            continue
                        if not isinstance(data.get("choices", []), list):
                            raise ModelFailure("Model provider returned an invalid stream")
                        for choice in data.get("choices", []):
                            if not isinstance(choice, dict) or not isinstance(choice.get("delta", {}), dict):
                                raise ModelFailure("Model provider returned an invalid stream")
                            reason = choice.get("finish_reason")
                            if reason == "stop":
                                finished = True
                            elif reason is not None:
                                raise ModelFailure("Model response stopped before a complete answer")
                            content = choice.get("delta", {}).get("content")
                            if content:
                                if not isinstance(content, str):
                                    raise ModelFailure("Model provider returned invalid answer text")
                                yield content
                if not finished:
                    raise ModelFailure("Model connection ended before the answer was complete")
    except httpx.HTTPError as error:
        raise ModelFailure("Model provider network request failed") from error
