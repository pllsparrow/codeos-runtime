"""Canonical Notebook operations; tracked source files remain read-only."""
from __future__ import annotations

from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from codelab_catalog import build_catalog, load_notebook, safe_content_path

from .database import CodelabDatabase


class NotebookService:
    def __init__(self, database: CodelabDatabase, content_root: Path):
        self.database = database
        self.content_root = content_root

    def directory(self, *, query: str, folder: str, sort: str, page: int, limit: int, exclude_paths: set[str] | None = None, only_paths: set[str] | None = None) -> dict[str, Any]:
        saved = self.database.list_workspace_metadata()
        hidden = {row["resource_path"] for row in saved} | {row["source_path"] for row in saved if row.get("source_path")}
        entries = [
            {"path": row["resource_path"], "title": row["title"], "updated_at": row["updated_at"]}
            for row in saved
        ]
        entries.extend(
            {"path": resource.path, "title": resource.title, "updated_at": None}
            for resource in build_catalog(self.content_root)
            if resource.kind == "notebook" and resource.path not in hidden
        )
        if exclude_paths is not None:
            entries = [entry for entry in entries if entry['path'] not in exclude_paths and not entry['path'].startswith('workspace/course--')]
        if only_paths is not None:
            entries = [entry for entry in entries if entry['path'] in only_paths]
        folders: dict[str, int] = {}
        for entry in entries:
            parts = entry["path"].split("/")[:-1]
            for depth in range(1, len(parts) + 1):
                prefix = "/".join(parts[:depth])
                folders[prefix] = folders.get(prefix, 0) + 1
        needle = query.strip().casefold()
        selected = [entry for entry in entries
                    if (not folder or entry["path"].startswith(folder + "/"))
                    and (not needle or needle in entry["title"].casefold())]
        if sort == "updated":
            def order(entry):
                value = entry["updated_at"]
                stamp = datetime.fromisoformat(value) if value else None
                if stamp and stamp.tzinfo is None:
                    stamp = stamp.replace(tzinfo=timezone.utc)
                return (-(stamp.timestamp() if stamp else float("-inf")), entry["path"])
            selected.sort(key=order)
        else:
            selected.sort(key=lambda entry: (entry[sort].casefold(), entry["path"]))
        page_count = max(1, (len(selected) + limit - 1) // limit)
        actual_page = min(page, page_count - 1)
        return {"items": selected[actual_page * limit:(actual_page + 1) * limit],
                "total": len(selected), "page": actual_page, "page_count": page_count,
                "limit": limit, "notebook_count": len(entries),
                "folders": [{"path": path, "count": count} for path, count in sorted(folders.items())]}

    def save(self, path: str, notebook: dict[str, Any], key: str, create_only: bool, expected_version: Any = None) -> dict[str, Any]:
        existing = self.database.workspace(path)
        if existing and existing["resource_path"] != path:
            raise ValueError("Notebook was renamed; reopen it before saving")
        source_path = None
        if not path.startswith("workspace/") and existing is None:
            load_notebook(self.content_root, path)
            source_path = path
        return self.database.save_workspace(resource_path=path, title=notebook["title"], notebook=notebook, idempotency_key=key, create_only=create_only, source_path=source_path, expected_version=expected_version)

    def rename(self, old_path: str, new_path: str, key: str, title: str | None, expected_version: Any) -> dict[str, Any]:
        if Path(old_path).parent != Path(new_path).parent:
            raise ValueError("Rename must stay in the same Notebook directory")
        if safe_content_path(self.content_root, new_path).exists():
            raise ValueError("Notebook filename already exists; choose another filename")
        source = None
        if not old_path.startswith("workspace/"):
            try:
                source = asdict(load_notebook(self.content_root, old_path))
            except FileNotFoundError:
                pass
        return self.database.rename_workspace(old_path, new_path, key, title=title or Path(new_path).stem, source_notebook=source, expected_version=expected_version)
