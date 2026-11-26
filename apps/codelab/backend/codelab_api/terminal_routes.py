"""Disposable terminal transport through the private, networkless execution worker."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
import httpx

router = APIRouter(prefix="/api/codelab/lab")


class TerminalInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal["start", "poll", "input", "close"]
    id: UUID
    data: str = Field(default="", max_length=16384)
    sequence: int = Field(default=0, ge=0)
    cursor: int = Field(default=0, ge=0)
    columns: int = Field(default=0, ge=0, le=500)
    rows: int = Field(default=0, ge=0, le=200)


@router.post("/terminal")
def terminal(payload: TerminalInput):
    from .server import _judge

    judge = _judge()
    try:
        response = judge.client.post(
            "/internal/judge/terminal",
            headers={"Authorization": f"Bearer {judge.token}"},
            json=payload.model_dump(mode="json"),
            timeout=7,
        )
        if response.is_error:
            detail = response.json().get("detail", "Terminal is unavailable")
            raise HTTPException(503, detail)
        if len(response.content) > 400_000:
            raise ValueError("Terminal response exceeds its limit")
        return response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(503, "Terminal connection interrupted. Retry to reconnect.") from error
