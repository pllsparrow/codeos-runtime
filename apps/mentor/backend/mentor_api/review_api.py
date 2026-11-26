"""Private review routes with optional request-owned generation orchestration."""
from __future__ import annotations

import secrets
from datetime import datetime
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict

from .review_store import ReviewStore
from .reviews import ReviewDocument
from .review_service import ReviewUnavailable
from .review_snapshot import SnapshotError
from .review_store import ReviewConflict


class ReviewCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    client_review_id: UUID
    cutoff_message_id: UUID


class ReviewView(BaseModel):
    id: UUID
    session_id: UUID
    cutoff_message_id: UUID
    status: Literal["running", "completed", "failed", "cancelled"]
    schema_version: Literal["review.v1"]
    created_at: datetime
    finished_at: datetime | None
    attempt_count: int
    document: ReviewDocument | None
    error_code: str | None


class ReviewPage(BaseModel):
    items: list[ReviewView]
    next_cursor: UUID | None


def view(row: dict) -> ReviewView:
    fields = {key: row[key] for key in ("id", "session_id", "cutoff_message_id", "status",
                                      "schema_version", "created_at", "finished_at", "error_code")}
    return ReviewView(**fields, document=row["result"],
                      attempt_count=row.get("attempt_count", len(row.get("attempts", []))))


def create_review_router(store: ReviewStore, internal_token: str | None, coordinator=None) -> APIRouter:
    def authorize(authorization: str | None = Header(default=None)) -> None:
        if not internal_token:
            raise HTTPException(503, "Review access is not configured")
        scheme, _, token = (authorization or "").partition(" ")
        if scheme.casefold() != "bearer" or not token or not secrets.compare_digest(token.encode(), internal_token.encode()):
            raise HTTPException(401, "Review authorization required")

    router = APIRouter(prefix="/api/mentor", tags=["private-reviews"], dependencies=[Depends(authorize)])

    if coordinator is not None:
        @router.post("/sessions/{session_id}/reviews", response_model=ReviewView)
        async def generate_review(session_id: UUID, payload: ReviewCreate, request: Request, response: Response) -> ReviewView:
            try:
                row, status = await coordinator.generate(session_id, payload.client_review_id,
                    payload.cutoff_message_id, request.is_disconnected)
                response.status_code = status
                return view(row)
            except KeyError:
                raise HTTPException(404, "Review session or cutoff not found") from None
            except ReviewConflict:
                raise HTTPException(409, "Review request ID belongs to another cutoff") from None
            except SnapshotError as error:
                status = 413 if error.code in {"snapshot_too_large", "context_too_large"} else 409
                raise HTTPException(status, error.code) from None
            except ReviewUnavailable as error:
                raise HTTPException(503, str(error)) from None

    @router.get("/reviews/{review_id}", response_model=ReviewView)
    def get_review(review_id: UUID) -> ReviewView:
        try:
            return view(store.get(review_id))
        except KeyError:
            raise HTTPException(404, "Review not found") from None

    @router.get("/sessions/{session_id}/reviews", response_model=ReviewPage)
    def list_reviews(session_id: UUID, before: UUID | None = None) -> ReviewPage:
        try:
            page = store.list(session_id, before)
            return ReviewPage(items=[view(row) for row in page["items"]], next_cursor=page["next_cursor"])
        except KeyError:
            raise HTTPException(404, "Review session or cursor not found") from None

    @router.post("/reviews/{review_id}/cancel", response_model=ReviewView)
    def cancel_review(review_id: UUID) -> ReviewView:
        try:
            return view(store.cancel(review_id))
        except KeyError:
            raise HTTPException(404, "Review not found") from None

    return router
