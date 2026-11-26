"""HTTP contracts for the Learning Notes workspace."""
from __future__ import annotations

from typing import Annotated, Any, Callable, Literal

from fastapi import APIRouter, Header, HTTPException, Path, Query
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field
from psycopg import Error as DatabaseError

from .notes import NotesError, NotesService


class NoteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=300)
    content: str = Field(default="", max_length=1_000_000)
    folder: str = Field(default="", max_length=500)


class NoteSave(NoteCreate):
    expected_version: str = Field(min_length=1, max_length=80)


class NoteVersion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: str = Field(min_length=1, max_length=80)


class FolderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    path: str = Field(min_length=1, max_length=500)


class FolderRename(FolderCreate):
    target: str = Field(min_length=1, max_length=500)
    expected_version: str = Field(min_length=1, max_length=64)



class NoteMetadata(BaseModel):
    id: int
    path: str
    title: str
    source_path: str | None
    created_at: str
    updated_at: str
    deleted_at: str | None


class NoteRecord(NoteMetadata):
    content: str


class FolderMetadata(BaseModel):
    path: str
    version: str


class NotesCatalog(BaseModel):
    notes: list[NoteMetadata]
    folders: list[FolderMetadata]
    management_ready: bool


def notes_router(database: Callable[[], Any]) -> APIRouter:
    router = APIRouter(prefix="/api/codelab/learning/note-workspace", tags=["Learning Notes"])

    def call(action: Callable[[NotesService], Any]) -> Any:
        try:
            return action(NotesService(database()))
        except NotesError as error:
            raise HTTPException(status_code=error.status, detail=str(error)) from error
        except (RuntimeError, DatabaseError) as error:
            raise HTTPException(status_code=503, detail="Notes storage is unavailable. Your draft can be retained or exported; retry when storage returns.") from error

    @router.get("", response_model=NotesCatalog)
    def catalog(q: str = Query(default="", max_length=300), sort: Literal["updated", "title"] = "updated", trash: bool = False) -> Any:
        return call(lambda service: service.catalog(q.strip(), sort, trash))

    @router.get("/export")
    def export(folder: str | None = Query(default=None, max_length=500)) -> Response:
        body = call(lambda service: service.export_zip(folder))
        return Response(body, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="codeos-notes.zip"', "Cache-Control": "no-store"})

    @router.post("/notes", status_code=201, response_model=NoteRecord)
    def create(payload: NoteCreate, key: str = Header(alias="Idempotency-Key")) -> Any:
        return call(lambda service: service.create(key, payload.title, payload.content, payload.folder))

    @router.get("/notes/{note_id}", response_model=NoteRecord)
    def get(note_id: Annotated[int, Path(ge=1)]) -> Any:
        return call(lambda service: service.get(note_id))

    @router.put("/notes/{note_id}", response_model=NoteRecord)
    def save(note_id: Annotated[int, Path(ge=1)], payload: NoteSave, key: str = Header(alias="Idempotency-Key")) -> Any:
        return call(lambda service: service.change(key, note_id, payload.expected_version, title=payload.title, content=payload.content, folder=payload.folder))

    @router.post("/notes/{note_id}/{action}", response_model=NoteRecord)
    def lifecycle(note_id: Annotated[int, Path(ge=1)], action: Literal["trash", "restore"], payload: NoteVersion, key: str = Header(alias="Idempotency-Key")) -> Any:
        return call(lambda service: service.change(key, note_id, payload.expected_version, action=action))

    @router.post("/folders", status_code=201)
    def create_folder(payload: FolderCreate, key: str = Header(alias="Idempotency-Key")) -> Any:
        return call(lambda service: service.create_folder(key, payload.path))

    @router.post("/folders/rename")
    def rename_folder(payload: FolderRename, key: str = Header(alias="Idempotency-Key")) -> Any:
        return call(lambda service: service.rename_folder(key, payload.path, payload.target, payload.expected_version))

    return router
