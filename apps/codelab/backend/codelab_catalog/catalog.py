from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from .models import CatalogResource, CellType, LearningChapter, NotebookCell, NotebookSummary


def safe_content_path(content_root: Path, relative_path: str) -> Path:
    """Resolve a content path while preventing traversal outside its root."""
    root = content_root.resolve()
    candidate = (root / relative_path).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("content path escapes the configured Codelab root")
    return candidate


def _text(value: Any, *, field: str) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return "".join(value)
    raise ValueError(f"Notebook {field} must be a string or list of strings")


def _title_from_source(source: str, fallback: str) -> str:
    for line in source.splitlines():
        if line.startswith("#"):
            title = line.lstrip("#").strip()
            if title:
                return title
    return fallback


def _language(notebook: dict[str, Any]) -> str | None:
    metadata = notebook.get("metadata", {})
    if not isinstance(metadata, dict):
        return None
    language_info = metadata.get("language_info", {})
    if isinstance(language_info, dict) and isinstance(language_info.get("name"), str):
        return language_info["name"]
    kernelspec = metadata.get("kernelspec", {})
    if isinstance(kernelspec, dict) and isinstance(kernelspec.get("language"), str):
        return kernelspec["language"]
    return None


def load_notebook(content_root: Path, relative_path: str) -> NotebookSummary:
    """Parse Notebook structure without executing cells or trusting outputs."""
    if Path(relative_path).suffix.casefold() != ".ipynb":
        raise ValueError("Notebook path must end with .ipynb")
    path = safe_content_path(content_root, relative_path)
    if not path.is_file():
        raise FileNotFoundError(relative_path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError(f"invalid Notebook: {relative_path}") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("cells"), list):
        raise ValueError("Notebook must contain a cells array")

    cells: list[NotebookCell] = []
    for raw_cell in payload["cells"]:
        if not isinstance(raw_cell, dict):
            raise ValueError("Notebook cells must be objects")
        raw_type = raw_cell.get("cell_type")
        if raw_type not in {"markdown", "code", "raw"}:
            raise ValueError(f"unsupported Notebook cell type: {raw_type!r}")
        source = _text(raw_cell.get("source", ""), field="source")
        execution_count = raw_cell.get("execution_count")
        if execution_count is not None and not isinstance(execution_count, int):
            execution_count = None
        outputs = raw_cell.get("outputs", [])
        if not isinstance(outputs, list):
            raise ValueError("Notebook outputs must be an array")
        cells.append(
            NotebookCell(
                cell_type=raw_type,
                source=source,
                execution_count=execution_count,
                output_count=len(outputs),
            )
        )

    title = _title_from_source(
        next((cell.source for cell in cells if cell.cell_type == "markdown"), ""),
        path.stem,
    )
    return NotebookSummary(
        path=relative_path,
        title=title,
        language=_language(payload),
        cells=tuple(cells),
    )


def _markdown_title(path: Path) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return path.stem
    return _title_from_source(text, path.stem)


def build_catalog(content_root: Path) -> tuple[CatalogResource, ...]:
    """Build a deterministic Markdown/Notebook catalog below one content root."""
    root = content_root.resolve()
    if not root.is_dir():
        raise FileNotFoundError(str(content_root))
    resources: list[CatalogResource] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name.startswith("."):
            continue
        relative_path = path.relative_to(root).as_posix()
        if path.suffix.casefold() == ".md":
            resources.append(
                CatalogResource(
                    path=relative_path,
                    title=_markdown_title(path),
                    kind="markdown",
                )
            )
        elif path.suffix.casefold() == ".ipynb":
            notebook = load_notebook(root, relative_path)
            resources.append(
                CatalogResource(
                    path=relative_path,
                    title=notebook.title,
                    kind="notebook",
                    notebook=notebook,
                )
            )
    return tuple(resources)


def _display_name(path_name: str) -> str:
    """Turn an ordered filesystem name into a readable navigation label."""
    name = path_name.split("_", 1)[-1]
    return name.replace("-", " ").replace("_", " ").title()


def _resource_role(resource_path: str, chapter_path: str, kind: str) -> str:
    if resource_path == f"{chapter_path}/README.md":
        return "hub"
    if kind == "notebook":
        return "experiment"
    parent_name = Path(resource_path).parent.name.casefold()
    if parent_name in {"practice", "practices", "question_bank"}:
        return "practice"
    if parent_name in {"review", "reviews", "review_logs", "records"}:
        return "review"
    if parent_name in {"notes", "concepts"}:
        return "concept"
    return "resource"


def _navigation_track(chapter_path: str) -> tuple[str, str]:
    """Keep written-test and interview material in their own bottom-level navigation groups."""
    if chapter_path == "05_assessments/records":
        return "08_exam", "Exam"
    if chapter_path.startswith("04_interviews/"):
        return "04_interviews", "Interviews"
    track_id = chapter_path.split("/", 1)[0]
    return track_id, _display_name(track_id)


def build_chapters(content_root: Path) -> tuple[LearningChapter, ...]:
    """Build chapter hubs and their authored Markdown/Notebook resources."""
    root = content_root.resolve()
    if not root.is_dir():
        raise FileNotFoundError(str(content_root))
    resources = build_catalog(root)
    chapters: list[LearningChapter] = []
    for hub_path in sorted(root.rglob("README.md")):
        if hub_path.parent == root or not hub_path.is_file():
            continue
        chapter_path = hub_path.parent.relative_to(root).as_posix()
        if chapter_path == "05_assessments/records/reviews":
            continue
        chapter_resources = tuple(
            replace(
                resource,
                role=_resource_role(resource.path, chapter_path, resource.kind),
            )
            for resource in resources
            if resource.path == f"{chapter_path}/README.md"
            or resource.path.startswith(f"{chapter_path}/")
        )
        track_id, track_title = _navigation_track(chapter_path)
        chapters.append(
            LearningChapter(
                id=chapter_path,
                title=next(
                    resource.title
                    for resource in chapter_resources
                    if resource.path == f"{chapter_path}/README.md"
                ),
                track_id=track_id,
                track_title=track_title,
                hub_path=f"{chapter_path}/README.md",
                resources=chapter_resources,
            )
        )
    return tuple(chapters)
