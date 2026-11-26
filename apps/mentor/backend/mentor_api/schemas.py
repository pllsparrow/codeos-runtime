from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


ContextMode = Literal["auto", "none", "selected"]
RunStatus = Literal["queued", "running", "completed", "failed"]
RefreshStatus = Literal["queued", "running", "succeeded", "failed"]
IndexStatus = Literal["healthy", "degraded", "unavailable"]


class SessionCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    context_mode: ContextMode = "auto"


class SessionView(BaseModel):
    id: UUID
    context_mode: ContextMode
    archived: bool
    created_at: datetime


class SourceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    service: Literal["codelab", "prep"]
    source_id: str = Field(min_length=1, max_length=512)
    version: str | None = Field(default=None, max_length=128)


class RefreshCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(min_length=1, max_length=128)
    source_refs: list[SourceRef] = Field(default_factory=list, max_length=32)


class RefreshView(BaseModel):
    id: UUID
    idempotency_key: str
    status: RefreshStatus
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


class IndexStatusView(BaseModel):
    status: IndexStatus
    source_count: int
    last_job: RefreshView | None = None


class MessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(min_length=1, max_length=32_000)
    client_message_id: str | None = Field(default=None, min_length=1, max_length=128)
    source_refs: list[SourceRef] = Field(default_factory=list, max_length=8)

    @field_validator("content")
    @classmethod
    def nonblank_content(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Message must not be blank")
        return value


class MessageView(BaseModel):
    id: UUID
    session_id: UUID
    role: Literal["user", "assistant"]
    content: str
    created_at: datetime


class RunView(BaseModel):
    id: UUID
    message_id: UUID
    status: RunStatus
    model: str
    attempt_no: int
    partial_output: str
    error: str | None = None
    created_at: datetime
    completed_at: datetime | None = None


class MessageAccepted(BaseModel):
    message: MessageView
    run: RunView


class RetryAccepted(BaseModel):
    run: RunView


class RetrievalView(BaseModel):
    id: UUID
    message_id: UUID
    sources: list[dict]
    created_at: datetime


class HistoryMessage(MessageView):
    source_refs: list[SourceRef] = Field(default_factory=list)
    run: RunView | None = None
    retrievals: list[RetrievalView] = Field(default_factory=list)


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    hypothesis: str = Field(min_length=1, max_length=2_000)
    confidence: float = Field(ge=0, le=1)
    user_correction: str | None = Field(default=None, max_length=2_000)


class ProfileWrite(ProfileUpdate):
    topic: str = Field(min_length=1, max_length=200)

    @field_validator("topic")
    @classmethod
    def nonblank_topic(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Profile topic must not be blank")
        return value


class ProfileView(ProfileUpdate):
    topic: str
    updated_at: datetime


class LearningPlanItem(BaseModel):
    evidence_topic: str
    title: str
    observation: str
    priority: Literal["focus", "reinforce", "inspect"]
    action_label: str
    href: str
    confidence: float = Field(ge=0, le=1)
    corrected_by_user: bool
    successful_count: int = Field(ge=0)
    observation_count: int = Field(ge=0)
    source_refs: list[SourceRef] = Field(default_factory=list)


class LearningPlanView(BaseModel):
    evidence_count: int
    focus_count: int
    items: list[LearningPlanItem]
    disclaimer: str


class LearningDirectionRefreshView(BaseModel):
    refresh: RefreshView
    profile: list[ProfileView]
    plan: LearningPlanView
