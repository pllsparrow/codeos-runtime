"""Transport contracts for independent Writing and its published projection."""
from typing import Any, Callable, Literal
from uuid import UUID
from fastapi import APIRouter, Header, HTTPException, Path, Query, Response
from pydantic import BaseModel, ConfigDict, Field
from psycopg import Error as DatabaseError
from .notes import NotesError
from .writing import WritingService
from .notes_routes import NoteRecord

class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")

class DraftSave(Strict):
    note_id: int | None = Field(default=None, ge=1)
    kind: Literal["notes", "plans", "knowledge", "courses", "reviews"]
    collection_id: str | None = Field(default=None, max_length=100)
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(default="", max_length=1_000_000)
    folder: str = Field(default="", max_length=500)
    base_note_version: str | None = Field(default=None, max_length=80)
    review_company: str = Field(default="", max_length=120)
    review_provenance: Literal["owner", "external", "mixed", "unknown"] = "unknown"
    expected_version: int | None = Field(default=None, ge=1)

class Version(Strict):
    expected_version: int = Field(ge=1)

class Reclassification(Strict):
    kind: Literal["notes", "plans"]
    expected_version: str = Field(min_length=1, max_length=80)

class Entry(Strict):
    noteId: int = Field(ge=1)
    title: str = Field(min_length=1, max_length=300)

class PracticeLesson(Strict):
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,99}$")
    title: str = Field(min_length=1, max_length=300)
    objective: str = Field(default="", max_length=2000)
    stage: str = Field(default="", max_length=100)
    reading_note_id: int | None = Field(default=None, ge=1)
    experiment_plan: list[str] = Field(default_factory=list, max_length=12)
    experiment_setup: str = Field(default="", max_length=20000)

class PathBase(Strict):
    revision: int
    lessons: dict[str, str]

class CollectionBody(Strict):
    title: str = Field(min_length=1, max_length=300)
    description: str = Field(default="", max_length=2000)
    track: Literal["python", "go", "backend", "ai"]
    practice: str = Field(default="", max_length=300)
    kind: Literal["Project", "Learning plan"] | None = None
    overview: int | None = Field(default=None, ge=1)
    entries: list[Entry] = Field(default_factory=list, max_length=500)
    courses: list[str] = Field(default_factory=list, max_length=100)
    notes: list[int] = Field(default_factory=list, max_length=200)
    archived: bool = False
    path_id: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9-]{0,70}$")
    subject: Literal["algorithms", "sql"] | None = None
    path_base: PathBase | None = None
    lessons: list[PracticeLesson] = Field(default_factory=list, max_length=500)

class CollectionSave(Strict):
    kind: Literal["knowledge", "courses"]
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,79}$")
    body: CollectionBody
    expected_version: int | None = Field(default=None, ge=1)

class DraftMetadata(BaseModel):
    review_company: str = ""
    review_provenance: str = "unknown"
    id: UUID
    note_id: int | None
    kind: Literal["notes", "plans", "knowledge", "courses", "reviews"]
    collection_id: str | None
    title: str
    version: int
    updated_at: str
    base_note_version: str | None

class DraftRecord(DraftMetadata):
    review_company: str
    review_provenance: str
    content: str
    folder: str

class DocumentMetadata(BaseModel):
    display_title: str | None = None
    review_company: str | None = None
    review_provenance: str | None = None
    note_id: int
    kind: Literal["notes", "plans", "knowledge", "courses", "reference", "reviews"]
    collection_id: str | None
    title: str
    updated_at: str
    deleted_at: str | None

class CollectionRecord(BaseModel):
    id: str
    kind: Literal["knowledge", "courses"]
    slug: str
    published: dict[str, Any] | None
    draft: dict[str, Any] | None = None
    version: int
    updated_at: str | None = None

class CatalogResponse(BaseModel):
    collections: list[CollectionRecord]
    documents: list[DocumentMetadata]
    drafts: list[DraftMetadata]

def writing_router(database: Callable[[], Any]) -> APIRouter:
    router = APIRouter(prefix="/api/codelab/learning", tags=["Writing"])
    def call(action):
        try:
            return action(WritingService(database()))
        except NotesError as error:
            raise HTTPException(error.status, str(error)) from error
        except (RuntimeError, DatabaseError) as error:
            raise HTTPException(503, "Writing storage is unavailable; keep or export your draft and retry") from error

    @router.get("/content/catalog", response_model=CatalogResponse, response_model_exclude_unset=True)
    def published_catalog(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return call(lambda s: s.catalog())

    @router.get("/writing/catalog", response_model=CatalogResponse, response_model_exclude_unset=True)
    def authoring_catalog(response: Response, q: str = Query(default="", max_length=300)):
        response.headers["Cache-Control"] = "no-store"
        return call(lambda s: s.catalog(authoring=True, query=q.strip()))

    @router.get("/writing/drafts/{identity}", response_model=DraftRecord)
    def draft(identity: UUID, response: Response):
        response.headers["Cache-Control"] = "no-store"
        return call(lambda s: s.draft(str(identity)))

    @router.post("/writing/drafts", status_code=201, response_model=DraftRecord)
    def new_draft(payload: DraftSave, key: str = Header(alias="Idempotency-Key")):
        return call(lambda s: s.save_draft(key, payload.model_dump()))

    @router.put("/writing/drafts/{identity}", response_model=DraftRecord)
    def save_draft(identity: UUID, payload: DraftSave, key: str = Header(alias="Idempotency-Key")):
        return call(lambda s: s.save_draft(key, payload.model_dump(), str(identity)))

    @router.post("/writing/drafts/{identity}/publish", response_model=NoteRecord)
    def publish(identity: UUID, payload: Version, key: str = Header(alias="Idempotency-Key")):
        return call(lambda s: s.publish(key, str(identity), payload.expected_version))

    @router.put("/writing/documents/{note_id}/kind", response_model=NoteRecord)
    def reclassify(payload: Reclassification, note_id: int = Path(ge=1), key: str = Header(alias="Idempotency-Key")):
        return call(lambda s: s.reclassify(key, note_id, payload.kind, payload.expected_version))

    @router.put("/writing/collections/{identity}", response_model=CollectionRecord)
    def save_collection(payload: CollectionSave, identity: str = Path(pattern=r"^[a-z0-9][a-z0-9:_-]{0,99}$"), key: str = Header(alias="Idempotency-Key")):
        return call(lambda s: s.save_collection(key, identity, payload.kind, payload.slug, payload.body.model_dump(exclude_none=True), payload.expected_version))

    @router.post("/writing/collections/{identity}/publish", response_model=CollectionRecord)
    def publish_collection(payload: Version, identity: str = Path(pattern=r"^[a-z0-9][a-z0-9:_-]{0,99}$"), key: str = Header(alias="Idempotency-Key")):
        return call(lambda s: s.publish_collection(key, identity, payload.expected_version))
    return router
