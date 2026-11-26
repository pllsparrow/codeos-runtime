from __future__ import annotations

import json
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

from .review_generation import AttemptMetadata, REPAIRABLE, ReviewCompletion, ReviewProviderFailure
from .review_request import ReviewMode, build_review_request


@dataclass(frozen=True)
class ProviderResponse:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None


class ProviderError(ReviewProviderFailure):
    """Keep provider diagnostics bounded and independent of private response bodies."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def response_metadata(payload: object, model: str, mode: str) -> AttemptMetadata:
    """Preserve valid counters independently of envelope success or missing peers."""
    usage = payload.get("usage") if isinstance(payload, dict) else None
    counts = []
    for current_name, legacy_name in (("input_tokens", "prompt_tokens"), ("output_tokens", "completion_tokens")):
        value = usage.get(current_name) if isinstance(usage, dict) else None
        if value is None and isinstance(usage, dict):
            value = usage.get(legacy_name)
        counts.append(value if type(value) is int and value >= 0 else None)
    return AttemptMetadata(model, mode, *counts)


def decode_response(payload: object) -> ProviderResponse:
    """Decode the transport envelope; review validation belongs to the generator."""
    if not isinstance(payload, dict):
        raise ProviderError("invalid_envelope")
    choices = payload.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise ProviderError("invalid_envelope")
    choice = choices[0]
    message = choice.get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise ProviderError("invalid_envelope")
    if message.get("refusal"):
        raise ProviderError("provider_refusal")
    if choice.get("finish_reason") != "stop":
        raise ProviderError("incomplete_response")
    text = message.get("content")
    if not isinstance(text, str) or not text.strip():
        raise ProviderError("invalid_envelope")
    try:
        text_size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        raise ProviderError("invalid_envelope") from None
    if text_size > 32 * 1024:
        raise ProviderError("output_limit")
    usage = payload.get("usage")
    if usage is not None and not isinstance(usage, dict):
        raise ProviderError("invalid_usage")
    counts = []
    for name in ("prompt_tokens", "completion_tokens"):
        value = (usage or {}).get(name)
        if value is not None and (type(value) is not int or value < 0):
            raise ProviderError("invalid_usage")
        counts.append(value)
    return ProviderResponse(text, *counts)


def decode_responses_response(payload: object) -> ProviderResponse:
    """Decode one completed Responses API envelope without assuming output item order."""
    if not isinstance(payload, dict):
        raise ProviderError("invalid_envelope")
    if payload.get("status") != "completed":
        raise ProviderError("incomplete_response")
    text = payload.get("output_text")
    refusals = False
    if not isinstance(text, str):
        fragments: list[str] = []
        output = payload.get("output")
        if not isinstance(output, list):
            raise ProviderError("invalid_envelope")
        for item in output:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue
            content = item.get("content")
            if not isinstance(content, list):
                raise ProviderError("invalid_envelope")
            for part in content:
                if not isinstance(part, dict):
                    raise ProviderError("invalid_envelope")
                if part.get("type") == "refusal":
                    refusals = True
                elif part.get("type") == "output_text" and isinstance(part.get("text"), str):
                    fragments.append(part["text"])
        text = "".join(fragments)
    if refusals:
        raise ProviderError("provider_refusal")
    if not text.strip():
        raise ProviderError("invalid_envelope")
    try:
        text_size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        raise ProviderError("invalid_envelope") from None
    if text_size > 32 * 1024:
        raise ProviderError("output_limit")
    usage = payload.get("usage")
    if usage is not None and not isinstance(usage, dict):
        raise ProviderError("invalid_usage")
    counts = []
    for name in ("input_tokens", "output_tokens"):
        value = (usage or {}).get(name)
        if value is not None and (type(value) is not int or value < 0):
            raise ProviderError("invalid_usage")
        counts.append(value)
    return ProviderResponse(text, *counts)


def responses_request(chat_payload: dict) -> dict:
    """Translate the validated review request into the Responses API contract."""
    messages = chat_payload["messages"]
    instructions = "\n\n".join(item["content"] for item in messages if item["role"] == "system")
    payload = {
        "model": chat_payload["model"],
        "input": [dict(item) for item in messages if item["role"] != "system"],
        "instructions": instructions,
        "stream": False,
        "store": False,
        "max_output_tokens": chat_payload["max_completion_tokens"],
    }
    response_format = chat_payload.get("response_format")
    if isinstance(response_format, dict) and isinstance(response_format.get("json_schema"), dict):
        payload["text"] = {"format": {"type": "json_schema", **response_format["json_schema"]}}
    return payload


class ReviewHTTPProvider:
    """A single-review adapter with immutable context and no transport retries."""

    def __init__(self, url: str, key: str, model: str, messages: list[dict[str, str]],
                 mode: ReviewMode, *, transport: httpx.AsyncBaseTransport | None = None,
                 max_completion_tokens: int = 2048):
        target = urlparse(url)
        if (target.scheme not in {"http", "https"} or not target.hostname or target.username
                or target.password or target.fragment or target.query
                or (target.scheme == "http" and target.hostname not in {"localhost", "127.0.0.1", "::1"})):
            raise ValueError("Use HTTPS or a loopback test provider URL")
        chat_payload = build_review_request(model, messages, mode, max_completion_tokens=max_completion_tokens)
        self.responses_api = target.path.rstrip("/").endswith("/responses")
        self.payload = responses_request(chat_payload) if self.responses_api else chat_payload
        self.url, self.key, self.mode = url, key, mode
        self.transport = transport
        self.responses: list[ProviderResponse] = []
        self.attempt_metadata = response_metadata(None, self.payload["model"], self.mode)

    async def __call__(self, repair_code: str | None) -> ReviewCompletion:
        self.attempt_metadata = response_metadata(None, self.payload["model"], self.mode)
        if not self.key.strip():
            error = ProviderError("provider_not_configured")
            error.metadata = self.attempt_metadata
            raise error
        if repair_code is not None and repair_code not in REPAIRABLE:
            raise ValueError("Unsupported repair code")
        message_field = "input" if self.responses_api else "messages"
        payload = {**self.payload, message_field: [dict(m) for m in self.payload[message_field]]}
        if repair_code:
            payload[message_field].append({"role": "user", "content": f"Repair the review. Validation code: {repair_code}"})
        metadata = response_metadata(None, self.payload["model"], self.mode)
        try:
            async with httpx.AsyncClient(timeout=60, transport=self.transport,
                                         follow_redirects=False, trust_env=False) as client:
                async with client.stream("POST", self.url, json=payload,
                                         headers={"Authorization": f"Bearer {self.key}"}) as response:
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 256 * 1024:
                            raise ProviderError("output_limit")
                    try:
                        envelope = json.loads(body)
                    except (ValueError, RecursionError):
                        envelope = None
                    metadata = response_metadata(envelope, self.payload["model"], self.mode)
                    self.attempt_metadata = metadata
                    if response.status_code != 200:
                        error = envelope.get("error") if isinstance(envelope, dict) else None
                        if (self.mode == "strict_schema" and response.status_code in {400, 422}
                                and isinstance(error, dict)
                                and error.get("code") in {"unsupported_parameter", "unsupported_value"}
                                and error.get("param") in {"response_format", "response_format.json_schema",
                                                           "text.format", "text.format.schema"}):
                            raise ProviderError("schema_unsupported")
                        raise ProviderError("provider_http_error")
                    decoded = decode_responses_response(envelope) if self.responses_api else decode_response(envelope)
                    self.responses.append(decoded)
                    return ReviewCompletion(decoded.text, metadata)
        except ProviderError as error:
            error.metadata = metadata
            raise
        except httpx.HTTPError:
            error = ProviderError("provider_network_error")
            error.metadata = metadata
            raise error from None
