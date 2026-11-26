"""Request correlation and safe platform API error responses."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import Response


_REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")


class ErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str
    retryable: bool
    request_id: str


class ErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: ErrorDetail


@dataclass
class PlatformAPIError(Exception):
    """A platform error containing only an approved public code and message."""

    status_code: int
    code: str
    message: str
    retryable: bool = False


def request_id_for(request: Request) -> str:
    request_id = getattr(request.state, "request_id", None)
    if isinstance(request_id, str) and request_id:
        return request_id
    return f"req_{uuid.uuid4().hex}"


def error_response(request: Request, error: PlatformAPIError) -> JSONResponse:
    request_id = request_id_for(request)
    payload = ErrorEnvelope(
        error=ErrorDetail(
            code=error.code,
            message=error.message,
            retryable=error.retryable,
            request_id=request_id,
        )
    )
    return JSONResponse(
        status_code=error.status_code,
        content=payload.model_dump(),
        headers={"X-Request-ID": request_id},
    )


class RequestIDMiddleware(BaseHTTPMiddleware):
    """Assign one bounded correlation ID before platform handlers run."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        supplied = request.headers.get("X-Request-ID", "")
        request.state.request_id = (
            supplied if _REQUEST_ID_PATTERN.fullmatch(supplied) else f"req_{uuid.uuid4().hex}"
        )
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response
