from __future__ import annotations

import os
import sys
from dataclasses import asdict
from datetime import datetime
from pathlib import Path as FilePath
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Path, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from psycopg import Error as DatabaseError
from psycopg.errors import UniqueViolation

from codelab_catalog import build_catalog, build_chapters, load_notebook, safe_content_path

from .languages import PROFILES
from .database import CodelabDatabase
from .notebooks import NotebookService
from .notes_routes import notes_router
from .writing_routes import writing_router
from .experiment_routes import router as experiment_router
from .terminal_routes import router as terminal_router
from .learning_paths_routes import learning_paths_router
from .judge import JudgeClient, JudgeContractError, JudgeUnavailable


app = FastAPI(title="Codelab API", docs_url="/api/docs", redoc_url=None)
DATABASE: CodelabDatabase | None = None
JUDGE: JudgeClient | None = None
CODING_REPOSITORY: Any | None = None


def _allowed_origins() -> list[str]:
    raw = os.environ.get(
        "CODELAB_ALLOWED_ORIGINS",
        "http://127.0.0.1:8002,http://localhost:8002,https://127.0.0.1:8443,https://localhost:8443",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "PUT", "POST"],
    allow_headers=["Content-Type", "Idempotency-Key"],
)


class DraftPayload(BaseModel):
    language: Literal["python","go"] = "python"
    source: str = Field(max_length=256_000)

    @field_validator("source")
    @classmethod
    def source_fits_byte_limit(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 256_000:
            raise ValueError("source is too large")
        return value


class SubmissionPayload(BaseModel):
    language: Literal["python","go"] = "python"
    model_config = ConfigDict(extra="forbid")

    problem_index: int = Field(gt=0)
    problem_slug: str = Field(min_length=1, max_length=200)
    source: str = Field(max_length=256_000)

    @field_validator("source")
    @classmethod
    def source_fits_byte_limit(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 256_000:
            raise ValueError("source is too large")
        return value


class RunPayload(BaseModel):
    language: Literal["python","go"] = "python"
    model_config = ConfigDict(extra="forbid")

    problem_index: int = Field(gt=0)
    problem_slug: str = Field(min_length=1, max_length=200)
    source: str = Field(max_length=256_000)
    stdin: str = Field(max_length=256_000)

    @field_validator("source", "stdin")
    @classmethod
    def text_fits_byte_limit(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 256_000:
            raise ValueError("execution input is too large")
        return value


class WorkspaceOutputPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["stream", "result", "error"]
    text: str = Field(max_length=64_000)

    @field_validator("text")
    @classmethod
    def text_fits_byte_limit(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 64_000:
            raise ValueError("Notebook output is too large")
        return value


class WorkspaceExecutionPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["success", "error", "interrupted", "timeout"]
    started_at: datetime
    finished_at: datetime
    duration_ms: int = Field(ge=0, le=86_400_000)
    source: str = Field(max_length=256_000)
    message: str = Field(default="", max_length=2_000)
    prediction: str = Field(default="", max_length=2_000)

    @field_validator("started_at", "finished_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Execution timestamps must include a timezone")
        return value

    @field_validator("source", "message")
    @classmethod
    def text_fits_byte_limit(cls, value: str, info: Any) -> str:
        limit = 256_000 if info.field_name == "source" else 8_000
        if len(value.encode("utf-8")) > limit:
            raise ValueError("Execution metadata text is too large")
        return value

    @model_validator(mode="after")
    def ordered_timestamps(self) -> WorkspaceExecutionPayload:
        if self.finished_at < self.started_at:
            raise ValueError("Execution finish must not precede start")
        return self


class WorkspaceCellPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cell_type: Literal["markdown", "code", "raw"]
    source: str = Field(max_length=256_000)
    execution_count: int | None = Field(default=None, ge=0)
    output_count: int = Field(default=0, ge=0, le=1_000)
    outputs: list[WorkspaceOutputPayload] = Field(default_factory=list, max_length=100)
    execution: WorkspaceExecutionPayload | None = None
    prediction: str = Field(default="", max_length=2_000)

    @model_validator(mode="after")
    def execution_is_code_only(self) -> WorkspaceCellPayload:
        if self.execution is not None and self.cell_type != "code":
            raise ValueError("Execution metadata belongs to code cells only")
        if self.prediction and self.cell_type != "code":
            raise ValueError("Predictions belong to code cells only")
        return self

    @field_validator("source")
    @classmethod
    def source_fits_byte_limit(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 256_000:
            raise ValueError("Notebook cell source is too large")
        return value


class WorkspaceNotebookPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=1_000)
    title: str = Field(min_length=1, max_length=300)
    language: str | None = Field(default=None, max_length=100)
    cells: list[WorkspaceCellPayload] = Field(min_length=0, max_length=500)

    @field_validator("title")
    @classmethod
    def title_is_not_whitespace(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Enter a Notebook title")
        return value


class WorkspacePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    notebook: WorkspaceNotebookPayload
    create_only: bool = False
    expected_version: datetime | Literal["unpersisted"] | None = None

    @model_validator(mode="after")
    def require_revision(self):
        if not self.create_only and self.expected_version is None:
            raise ValueError("expected_version is required; reopen the Notebook before saving")
        if isinstance(self.expected_version, datetime) and self.expected_version.tzinfo is None:
            raise ValueError("expected_version must include a timezone")
        return self

    @field_validator("notebook")
    @classmethod
    def notebook_fits_byte_limit(cls, value: WorkspaceNotebookPayload) -> WorkspaceNotebookPayload:
        if len(value.model_dump_json().encode("utf-8")) > 1_000_000:
            raise ValueError("Notebook workspace is too large")
        return value


class WorkspaceRenamePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_version: datetime | Literal["unpersisted"]

    @field_validator("expected_version")
    @classmethod
    def revision_timezone(cls, value):
        if isinstance(value, datetime) and value.tzinfo is None:
            raise ValueError("expected_version must include a timezone")
        return value

    new_path: str = Field(min_length=1, max_length=1_000)
    title: str | None = Field(default=None, max_length=300)


def _database() -> CodelabDatabase:
    global DATABASE
    if DATABASE is None:
        DATABASE = CodelabDatabase()
    return DATABASE


def _judge() -> JudgeClient:
    global JUDGE
    if JUDGE is None:
        base_url = os.environ.get("CODELAB_JUDGE_URL")
        token = os.environ.get("CODELAB_JUDGE_TOKEN")
        if not base_url or not token:
            raise HTTPException(status_code=503, detail="Codelab execution service is not configured")
        JUDGE = JudgeClient(base_url, token)
    return JUDGE


def _coding_repository() -> Any:
    global CODING_REPOSITORY
    if CODING_REPOSITORY is None:
        coding_root = FilePath(
            os.environ.get("CODELAB_CODING_ROOT", FilePath(__file__).resolve().parents[2] / "coding")
        ).resolve()
        if str(coding_root) not in sys.path:
            sys.path.insert(0, str(coding_root))
        from app.backend.service import Repository

        CODING_REPOSITORY = Repository(coding_root)
    return CODING_REPOSITORY


def _problem_spec(problem_index: int, problem_slug: str) -> dict[str, Any]:
    from app.backend.service import ApiError

    repository = _coding_repository()
    try:
        problem = repository.problem(problem_index)
    except ApiError as error:
        raise HTTPException(status_code=error.status, detail=error.message) from error
    if problem["slug"] != problem_slug:
        raise HTTPException(status_code=409, detail="Problem index and slug do not match")
    try:
        return repository.specs[problem_slug]
    except KeyError as error:
        raise HTTPException(status_code=503, detail="Codelab test catalog is unavailable") from error


def _problem_progress(progress: dict[str, dict[str, Any]], problem_slug: str) -> str:
    record = progress.get(problem_slug, {})
    if record.get("accepted", 0) > 0:
        return "accepted"
    value = record.get("status", "todo")
    return value if isinstance(value, str) else "todo"


def _problem_summary(repository: Any, problem: dict[str, Any], progress: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        key: problem[key]
        for key in ("index", "slug", "title", "difficulty", "category", "collection")
    } | {
        "collection_name": repository.collections.get(problem["collection"], {}).get(
            "name", problem["collection"]
        ),
        "progress": _problem_progress(progress, problem["slug"]),
    }


def _problem_judge_contract(problem_index: int, problem_slug: str) -> tuple[list[dict[str, str]], str | None]:
    from app.judge.providers import materialize_cases

    spec = _problem_spec(problem_index, problem_slug)
    try:
        return materialize_cases(spec), spec.get("validator")
    except (KeyError, ValueError) as error:
        raise HTTPException(status_code=503, detail="Codelab test catalog is unavailable") from error


def _content_root() -> FilePath:
    configured = os.environ.get("CODELAB_CONTENT_ROOT")
    if configured:
        return FilePath(configured).resolve()
    return FilePath(__file__).resolve().parents[2] / "library"


def _resource_metadata(resource: Any) -> dict[str, Any]:
    payload = {
        "path": resource.path,
        "title": resource.title,
        "kind": resource.kind,
    }
    if resource.notebook is not None:
        payload["notebook"] = {
            "path": resource.notebook.path,
            "title": resource.notebook.title,
            "language": resource.notebook.language,
            "code_cell_count": resource.notebook.code_cell_count,
            "markdown_cell_count": resource.notebook.markdown_cell_count,
            "output_count": resource.notebook.output_count,
        }
    if resource.role is not None:
        payload["role"] = resource.role
    return payload


def _chapter_summary(chapter: Any) -> dict[str, Any]:
    return {
        "id": chapter.id,
        "title": chapter.title,
        "track_id": chapter.track_id,
        "track_title": chapter.track_title,
        "hub_path": chapter.hub_path,
        "resource_count": len(chapter.resources),
        "markdown_count": sum(item.kind == "markdown" for item in chapter.resources),
        "notebook_count": sum(item.kind == "notebook" for item in chapter.resources),
    }


def _catalog_chapters() -> tuple[Any, ...]:
    try:
        return build_chapters(_content_root())
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(status_code=503, detail=f"Codelab catalog unavailable: {error}") from error


def _resource_preview(root: FilePath, resource_path: str) -> dict[str, Any]:
    try:
        path = safe_content_path(root, resource_path)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Codelab resource not found")
    if path.suffix.casefold() == ".md":
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as error:
            raise HTTPException(status_code=422, detail="Codelab Markdown resource cannot be read") from error
        resources = {item.path: item for item in build_catalog(root)}
        metadata = resources.get(resource_path)
        if metadata is None:
            raise HTTPException(status_code=404, detail="Codelab resource not found")
        return {**_resource_metadata(metadata), "content": content}
    if path.suffix.casefold() == ".ipynb":
        try:
            notebook = load_notebook(root, resource_path)
        except (FileNotFoundError, ValueError) as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {
            "path": notebook.path,
            "title": notebook.title,
            "kind": "notebook",
            "notebook": asdict(notebook),
        }
    raise HTTPException(status_code=415, detail="Only Markdown and Notebook resources are supported")


def _idempotency_key(value: str | None) -> str:
    if not value or len(value) > 200:
        raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
    return value


def _workspace_resource_path(resource_path: str) -> str:
    if resource_path.startswith("workspace/experiments/"):
        raise HTTPException(400, "Use the Lab experiment API for this resource")
    if "\\" in resource_path or any(ord(character) < 32 for character in resource_path):
        raise HTTPException(status_code=400, detail="Workspace path contains invalid characters")
    path = FilePath(resource_path)
    if path.is_absolute() or path.as_posix() != resource_path or any(part in {"", ".", ".."} for part in path.parts):
        raise HTTPException(status_code=400, detail="Workspace path must be a normalized relative path")
    if path.suffix.casefold() != ".ipynb":
        raise HTTPException(status_code=400, detail="Workspace path must end with .ipynb")
    try:
        safe_content_path(_content_root(), resource_path)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return resource_path


def _note_path(resource_path: str) -> str:
    path = FilePath(resource_path)
    if path.is_absolute() or path.as_posix() != resource_path or any(part in {"", ".", ".."} for part in path.parts):
        raise HTTPException(status_code=400, detail="Unsafe Learning Note path")
    return resource_path


def _library_notebook(resource_path: str) -> None:
    """Require a workspace to be a real, readable Library Notebook."""
    try:
        load_notebook(_content_root(), resource_path)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Library Notebook not found") from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail="Library Notebook cannot be read") from error


def _is_user_workspace(resource_path: str) -> bool:
    return resource_path.startswith("workspace/")


@app.get("/api/codelab/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/codelab/ready")
def ready() -> dict[str, str]:
    try:
        _database().check()
        _judge().check()
    except (RuntimeError, DatabaseError, JudgeUnavailable, JudgeContractError) as error:
        raise HTTPException(status_code=503, detail="Codelab storage or execution service is unavailable") from error
    return {"status": "ready"}


@app.get("/api/codelab/learning/notes")
def learning_notes() -> list[dict[str, Any]]:
    try:
        return _database().list_notes()
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="Learning Notes storage is unavailable") from error


@app.get("/api/codelab/learning/notes/{path:path}")
def learning_note(path: str) -> dict[str, Any] | None:
    normalized = _note_path(path)
    try:
        note = _database().note(normalized)
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="Learning Notes storage is unavailable") from error
    if note is None:
        raise HTTPException(status_code=404, detail="Learning Note not found")
    return note


@app.put("/api/codelab/learning/notes/{path:path}")
def retired_note_write(path: str) -> None:
    raise HTTPException(status_code=410, detail="Use the Notes workspace API with an expected version to protect concurrent edits")


app.include_router(notes_router(_database))
app.include_router(writing_router(_database))
app.include_router(experiment_router)
app.include_router(terminal_router)
app.include_router(learning_paths_router(_database))


@app.get("/api/codelab/overview")
def overview() -> dict[str, Any]:
    try:
        resources = build_catalog(_content_root())
    except (FileNotFoundError, ValueError) as error:
        raise HTTPException(status_code=503, detail=f"Codelab catalog unavailable: {error}") from error
    return {
        "resources": [_resource_metadata(resource) for resource in resources],
        "chapters": [_chapter_summary(chapter) for chapter in _catalog_chapters()],
        "counts": {
            "resources": len(resources),
            "markdown": sum(resource.kind == "markdown" for resource in resources),
            "notebook": sum(resource.kind == "notebook" for resource in resources),
        },
    }


@app.get("/api/codelab/chapters")
def chapters() -> dict[str, Any]:
    return {"chapters": [_chapter_summary(chapter) for chapter in _catalog_chapters()]}


@app.get("/api/codelab/chapters/{chapter_id:path}")
def chapter(
    chapter_id: str,
) -> dict[str, Any]:
    selected = next((item for item in _catalog_chapters() if item.id == chapter_id), None)
    if selected is None:
        raise HTTPException(status_code=404, detail="Codelab chapter not found")
    return {
        **_chapter_summary(selected),
        "hub": _resource_preview(_content_root(), selected.hub_path),
        "resources": [_resource_metadata(resource) for resource in selected.resources],
    }


@app.get("/api/codelab/resources/{resource_path:path}")
def resource(
    resource_path: str,
) -> dict[str, Any]:
    return _resource_preview(_content_root(), resource_path)


@app.get("/api/codelab/coding/progress")
def progress() -> dict[str, dict[str, Any]]:
    return _database().progress()


@app.get("/api/codelab/coding/problems")
def coding_problems() -> list[dict[str, Any]]:
    repository = _coding_repository()
    try:
        current_progress = _database().progress()
        return [_problem_summary(repository, problem, current_progress) for problem in repository.problems]
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="Codelab progress storage is unavailable") from error


@app.get("/api/codelab/coding/problems/{problem_index}")
def coding_problem(problem_index: int = Path(gt=0), language: Literal["python","go"] = "python") -> dict[str, Any]:
    from app.backend.service import ApiError

    repository = _coding_repository()
    try:
        problem = repository.problem(problem_index)
        specification = repository.specs[problem["slug"]]
        source = repository.solution_path(problem).read_text(encoding="utf-8")
        draft_record = _database().draft(problem_index,language) if language != "python" else _database().draft(problem_index)
        current_progress = _database().progress()
    except ApiError as error:
        raise HTTPException(status_code=error.status, detail=error.message) from error
    except (KeyError, OSError, RuntimeError, DatabaseError) as error:
        raise HTTPException(status_code=503, detail="Codelab problem catalog is unavailable") from error
    return {
        **problem,
        **_problem_summary(repository, problem, current_progress),
        "source": source if language == "python" else "package main\n\nfunc main() {\n\t// Write your stdin/stdout program.\n}\n",
        "language": language,
        "draft_source": draft_record["source"] if draft_record else None,
        "draft_updated_at": draft_record["updated_at"] if draft_record else None,
        "format": specification["format"],
        "examples": repository.examples.get(problem["slug"], []),
    }


@app.get("/api/codelab/coding/problems/{problem_index}/submissions")
def coding_problem_submissions(
    problem_index: int = Path(gt=0),
    before_id: int | None = Query(default=None, gt=0),
    limit: int = Query(default=20, ge=1, le=50),
) -> dict[str, Any]:
    from app.backend.service import ApiError

    try:
        problem = _coding_repository().problem(problem_index)
        return _database().submissions(problem["slug"], before_id=before_id, limit=limit)
    except ApiError as error:
        raise HTTPException(status_code=error.status, detail=error.message) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail="Codelab submission history is unavailable") from error


@app.get("/api/codelab/lab/workspaces")
def workspaces() -> list[dict[str, Any]]:
    try:
        return _database().list_workspaces()
    except (RuntimeError, DatabaseError) as error:
        raise HTTPException(status_code=503, detail="Codelab workspace storage is unavailable") from error


@app.get("/api/codelab/lab/notebooks")
def notebook_directory(
    scope: Literal["all", "independent", "course"] = "all",
    lesson: str | None = Query(default=None, pattern=r"^[a-z0-9-]{1,80}$"),
    q: str = Query(default="", max_length=200),
    folder: str = Query(default="", max_length=1_000),
    sort: Literal["updated", "title"] = "updated",
    page: int = Query(default=0, ge=0),
    limit: int = Query(default=25, ge=1, le=100),
) -> dict[str, Any]:
    path = FilePath(folder)
    if folder and (not path.parts or path.is_absolute() or path.as_posix() != folder or ".." in path.parts or "\\" in folder or any(ord(character) < 32 for character in folder)):
        raise HTTPException(status_code=400, detail="Notebook folder must be a normalized relative path")
    try:
        from .learning_study import LearningStudy
        from .notes import NotesError
        excluded = included = None
        if scope == 'independent':
            excluded = set(LearningStudy(_database()).experiment_references())
        elif scope == 'course':
            if not lesson:
                raise HTTPException(status_code=422, detail='Course Notebook scope requires a lesson')
            included = set(LearningStudy(_database()).experiment_references(lesson))
        return NotebookService(_database(), _content_root()).directory(query=q, folder=folder, sort=sort, page=page, limit=limit, exclude_paths=excluded, only_paths=included)
    except NotesError as error:
        raise HTTPException(status_code=error.status, detail=str(error)) from error
    except (RuntimeError, DatabaseError, OSError, ValueError) as error:
        raise HTTPException(status_code=503, detail="Notebook directory is unavailable; retry when catalog and storage are ready") from error


@app.get("/api/codelab/lab/workspaces/{resource_path:path}")
def workspace(resource_path: str) -> dict[str, Any] | None:
    try:
        return _database().workspace(_workspace_resource_path(resource_path))
    except (RuntimeError, DatabaseError) as error:
        raise HTTPException(status_code=503, detail="Codelab workspace storage is unavailable") from error


@app.put("/api/codelab/lab/workspaces/{resource_path:path}")
def save_workspace(
    payload: WorkspacePayload,
    resource_path: str,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    request_id = _idempotency_key(idempotency_key)
    normalized_path = _workspace_resource_path(resource_path)
    notebook = payload.notebook
    if notebook.path != normalized_path:
        raise HTTPException(status_code=422, detail="Notebook path must match the workspace path")
    try:
        return NotebookService(_database(), _content_root()).save(
            normalized_path, notebook.model_dump(mode="json", exclude_unset=True), request_id, payload.create_only, payload.expected_version
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail="Notebook source not found") from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (RuntimeError, DatabaseError) as error:
        raise HTTPException(status_code=503, detail="Codelab workspace storage is unavailable") from error


@app.patch("/api/codelab/lab/workspaces/{resource_path:path}")
def rename_workspace(
    payload: WorkspaceRenamePayload,
    resource_path: str,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    request_id = _idempotency_key(idempotency_key)
    old_path = _workspace_resource_path(resource_path)
    new_path = _workspace_resource_path(payload.new_path)
    if old_path == new_path:
        raise HTTPException(status_code=422, detail="New Notebook path must be different")
    try:
        return NotebookService(_database(), _content_root()).rename(old_path, new_path, request_id, payload.title, payload.expected_version)
    except UniqueViolation as error:
        raise HTTPException(status_code=409, detail="Notebook filename already exists; choose another filename") from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    except (RuntimeError, DatabaseError) as error:
        raise HTTPException(status_code=503, detail="Codelab workspace storage is unavailable") from error


@app.get("/api/codelab/coding/languages")
def execution_languages() -> list[dict[str, Any]]:
    try:
        return _judge().languages()
    except JudgeUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@app.get("/api/codelab/coding/drafts/{problem_index}")
def draft(
    problem_index: int = Path(gt=0),
    language: Literal["python","go"] = "python",
) -> dict[str, Any] | None:
    return _database().draft(problem_index,language) if language != "python" else _database().draft(problem_index)


@app.put("/api/codelab/coding/drafts/{problem_index}")
def save_draft(
    payload: DraftPayload,
    problem_index: int = Path(gt=0),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    try:
        return _database().save_draft(problem_index, payload.source, _idempotency_key(idempotency_key),payload.language)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/codelab/coding/submissions")
def record_submission(
    payload: SubmissionPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    request_id = _idempotency_key(idempotency_key)
    try:
        cached = _database().submission_response(request_id,payload.model_dump())
        if cached is not None:
            return cached
        cases, validator = _problem_judge_contract(payload.problem_index, payload.problem_slug)
        judged = _judge().submit(
            problem_index=payload.problem_index,
            problem_slug=payload.problem_slug,
            source=payload.source,
            language=payload.language,
            request_id=request_id,
            cases=cases,
            validator=validator,
        )
        judged.result.update(language=payload.language,language_profile=PROFILES[payload.language])
        return _database().record_submission(
            problem_index=payload.problem_index,
            problem_slug=payload.problem_slug,
            status=judged.verdict,
            source=payload.source,
            language=payload.language,
            passed=judged.passed,
            total=judged.total,
            first_failure=judged.first_failure,
            result=judged.result,
            idempotency_key=request_id,
        )
    except JudgeUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except JudgeContractError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/api/codelab/coding/submissions/{submission_id}")
def read_submission(submission_id: int = Path(gt=0)) -> dict[str, Any]:
    submission = _database().submission(submission_id)
    if submission is None:
        raise HTTPException(status_code=404, detail="Codelab submission not found")
    return submission


@app.post("/api/codelab/coding/runs")
def record_run(
    payload: RunPayload,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict[str, Any]:
    request_id = _idempotency_key(idempotency_key)
    try:
        cached = _database().run_response(request_id,payload.model_dump())
        if cached is not None:
            return cached
        _problem_spec(payload.problem_index, payload.problem_slug)
        result = _judge().run(source=payload.source, stdin=payload.stdin, request_id=request_id,language=payload.language)
        result.update(language=payload.language,language_profile=PROFILES[payload.language])
        return _database().record_run(
            problem_index=payload.problem_index,
            problem_slug=payload.problem_slug,
            source=payload.source,
            language=payload.language,
            stdin=payload.stdin,
            result=result,
            idempotency_key=request_id,
        )
    except JudgeUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except JudgeContractError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


def main() -> None:
    import uvicorn

    uvicorn.run(app, host=os.environ.get("CODELAB_HOST", "127.0.0.1"), port=int(os.environ.get("CODELAB_PORT", "8001")))


if __name__ == "__main__":
    main()
