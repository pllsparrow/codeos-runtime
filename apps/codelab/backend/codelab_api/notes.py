"""Learning-owned Notes business rules hosted by the transitional Codelab API."""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from datetime import datetime, timezone
from typing import Any, Callable
from uuid import uuid4

from psycopg.types.json import Jsonb


class NotesError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def folder_path(value: str, *, allow_root: bool = True) -> str:
    if value == "" and allow_root:
        return value
    parts = value.split("/")
    if (not value or len(value) > 500 or len(parts) > 8 or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)
            or any(p in {"", ".", ".."} or p != p.strip() for p in parts)):
        raise NotesError(422, "Use a relative folder path with up to 8 levels; dot paths are not allowed")
    return value


def note_path(value: str) -> str:
    if not value.endswith(".md"):
        raise NotesError(422, "Note path must end with .md")
    if len(value) > 800:
        raise NotesError(422, "Note path is too long")
    folder_path(folder_of(value))
    folder_path(value.rsplit("/", 1)[-1], allow_root=False)
    return value


def clean_title(value: str) -> str:
    title = value.strip()
    if not title or len(title) > 300:
        raise NotesError(422, "A title of 1 to 300 characters is required")
    return title


def record(row: Any) -> dict[str, Any]:
    return {key: value.isoformat() if isinstance(value, datetime) else value for key, value in dict(row).items()}


def folder_of(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def is_below(path: str, folder: str) -> bool:
    return path == folder or path.startswith(folder + "/")


class NotesService:
    def __init__(self, database: Any):
        self.database = database

    def ready(self) -> bool:
        with self.database.connection() as connection:
            row = connection.execute("select to_regclass('learning.note_folders') as folders, to_regclass('learning.note_requests') as requests").fetchone()
            return bool(row and row["folders"] and row["requests"])

    def _require_ready(self) -> None:
        if not self.ready():
            raise NotesError(503, "Notes management is awaiting the approved database migration. Existing notes remain readable.")

    @staticmethod
    def _folders(connection: Any, *, explicit_available: bool = True) -> list[dict[str, str]]:
        notes = connection.execute("select id, path, updated_at, deleted_at from learning.notes order by id").fetchall()
        explicit = connection.execute("select path, updated_at from learning.note_folders order by path").fetchall() if explicit_available else []
        paths: set[str] = set()
        for row in notes:
            parent = folder_of(row["path"])
            while parent:
                paths.add(parent)
                parent = folder_of(parent)
        for row in explicit:
            parent = row["path"]
            while parent:
                paths.add(parent)
                parent = folder_of(parent)
        result = []
        for path in sorted(paths):
            snapshot = [record(row) for row in notes if is_below(row["path"], path)]
            snapshot += [record(row) for row in explicit if is_below(row["path"], path)]
            version = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
            result.append({"path": path, "version": version})
        return result

    def catalog(self, query: str = "", sort: str = "updated", trash: bool = False) -> dict[str, Any]:
        order = "lower(title), id" if sort == "title" else "updated_at desc, id desc"
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""select id, path, title, source_path, created_at, updated_at, deleted_at
                from learning.notes where (deleted_at is not null) = %s
                and (strpos(lower(title), lower(%s)) > 0 or strpos(lower(content), lower(%s)) > 0
                     or strpos(lower(path), lower(%s)) > 0) order by {order}""",
                (trash, query, query, query),
            ).fetchall()
            ready = connection.execute("select to_regclass('learning.note_folders') as folders, to_regclass('learning.note_requests') as requests").fetchone()
            available = bool(ready["folders"] and ready["requests"])
            folders = self._folders(connection, explicit_available=available)
        return {"notes": [record(row) for row in rows], "folders": folders, "management_ready": available}

    def get(self, note_id: int) -> dict[str, Any]:
        with self.database.connection() as connection:
            row = connection.execute("select * from learning.notes where id = %s", (note_id,)).fetchone()
        if not row:
            raise NotesError(404, "Note not found")
        return record(row)

    def _write(self, key: str, payload: dict[str, Any], action: Callable[[Any], dict[str, Any]]) -> dict[str, Any]:
        self._require_ready()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", key):
            raise NotesError(422, "An Idempotency-Key of 1 to 200 letters, numbers, hyphens or underscores is required")
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self.database.connection() as connection:
            # Serializing Notes writes also protects folder subtree rename from new descendants.
            connection.execute("select pg_advisory_xact_lock(20261005, 1)")
            cached = connection.execute("select request_hash, response from learning.note_requests where key = %s", (key,)).fetchone()
            if cached:
                if cached["request_hash"] != digest:
                    raise NotesError(409, "This retry key belongs to different changes. Start a new request.")
                return cached["response"]
            response = action(connection)
            connection.execute("insert into learning.note_requests(key, request_hash, response) values (%s, %s, %s)", (key, digest, Jsonb(response)))
            return response

    @staticmethod
    def _current(connection: Any, note_id: int, version: str, *, deleted: bool = False) -> Any:
        row = connection.execute("select * from learning.notes where id = %s for update", (note_id,)).fetchone()
        if not row:
            raise NotesError(404, "Note not found")
        try:
            expected = datetime.fromisoformat(version)
        except ValueError:
            raise NotesError(422, "A last-read version is required") from None
        if expected.tzinfo is None or expected != row["updated_at"] or bool(row["deleted_at"]) != deleted:
            raise NotesError(409, "This note has changed in another page. Your draft is retained; open the current version before saving.")
        return row

    @staticmethod
    def _ensure_folder(connection: Any, path: str) -> None:
        parent = path
        while parent:
            if connection.execute("select id from learning.notes where path = %s", (parent,)).fetchone():
                raise NotesError(409, "A Note already uses a parent folder path. Choose a different folder.")
            connection.execute("insert into learning.note_folders(path) values (%s) on conflict do nothing", (parent,))
            parent = folder_of(parent)

    def create(self, key: str, title: str, content: str, folder: str, *, path: str | None = None) -> dict[str, Any]:
        title, folder = clean_title(title), folder_path(folder)
        if len(content) > 1_000_000:
            raise NotesError(422, "Note body exceeds 1,000,000 characters")
        if path:
            note_path(path)
        payload = {"action": "create", "title": title, "content": content, "folder": folder, "path": path}
        def action(connection: Any) -> dict[str, Any]:
            target = path or (folder + "/" if folder else "") + str(uuid4()) + ".md"
            note_path(target)
            if any(row["path"] == target for row in self._folders(connection)):
                raise NotesError(409, "A folder already uses this Note path")
            if connection.execute("select id from learning.notes where path = %s", (target,)).fetchone():
                raise NotesError(409, "A note already uses this path, including in Trash")
            self._ensure_folder(connection, folder_of(target))
            row = connection.execute("insert into learning.notes(path, title, content, updated_at) values (%s, %s, %s, clock_timestamp()) returning *", (target, title, content)).fetchone()
            return record(row)
        return self._write(key, payload, action)

    def change(self, key: str, note_id: int, version: str, *, action: str = "save", title: str | None = None, content: str | None = None, folder: str | None = None) -> dict[str, Any]:
        if action not in {"save", "trash", "restore"}:
            raise NotesError(422, "Unknown note action")
        if action == "save":
            title = clean_title(title or "")
            folder = folder_path(folder or "")
            if content is None or len(content) > 1_000_000:
                raise NotesError(422, "Note body is required and must be at most 1,000,000 characters")
        payload = {"action": action, "id": note_id, "version": version, "title": title, "content": content, "folder": folder}
        def apply(connection: Any) -> dict[str, Any]:
            row = self._current(connection, note_id, version, deleted=action == "restore")
            if action == "save":
                table = connection.execute("select to_regclass('learning.writing_documents') as documents").fetchone()
                if table["documents"] and connection.execute("select note_id from learning.writing_documents where note_id=%s", (note_id,)).fetchone():
                    raise NotesError(409, "This document is managed in Writing. Save a draft and publish it there.")
                path = (folder + "/" if folder else "") + row["path"].rsplit("/", 1)[-1]
                note_path(path)
                if any(item["path"] == path for item in self._folders(connection)):
                    raise NotesError(409, "A folder already uses this Note path")
                collision = connection.execute("select id from learning.notes where path = %s and id <> %s", (path, note_id)).fetchone()
                if collision:
                    raise NotesError(409, "The destination already contains a note with this filename")
                self._ensure_folder(connection, folder or "")
                row = connection.execute("update learning.notes set title=%s, content=%s, path=%s, updated_at=clock_timestamp() where id=%s returning *", (title, content, path, note_id)).fetchone()
            else:
                row = connection.execute("update learning.notes set deleted_at=%s, updated_at=clock_timestamp() where id=%s returning *", (datetime.now(timezone.utc) if action == "trash" else None, note_id)).fetchone()
            return record(row)
        return self._write(key, payload, apply)

    def create_folder(self, key: str, path: str) -> dict[str, Any]:
        path = folder_path(path, allow_root=False)
        def action(connection: Any) -> dict[str, Any]:
            if any(row["path"] == path for row in self._folders(connection)):
                raise NotesError(409, "This folder already exists")
            self._ensure_folder(connection, path)
            return {"path": path}
        return self._write(key, {"action": "folder-create", "path": path}, action)

    def rename_folder(self, key: str, path: str, target: str, version: str) -> dict[str, Any]:
        path, target = folder_path(path, allow_root=False), folder_path(target, allow_root=False)
        if is_below(target, path):
            raise NotesError(422, "Choose a different destination outside this folder")
        def action(connection: Any) -> dict[str, Any]:
            folders = {row["path"]: row["version"] for row in self._folders(connection)}
            if path not in folders:
                raise NotesError(404, "Folder not found")
            if folders[path] != version:
                raise NotesError(409, "Folder contents changed. Reload the directory before renaming.")
            if target in folders:
                raise NotesError(409, "Destination folder already exists")
            notes = connection.execute("select id, path from learning.notes order by id for update").fetchall()
            moving = [row for row in notes if is_below(row["path"], path)]
            remaining = {row["path"] for row in notes if row not in moving}
            if any(target + row["path"][len(path):] in remaining for row in moving):
                raise NotesError(409, "Destination contains a conflicting note")
            for row in moving:
                note_path(target + row["path"][len(path):])
            for item in folders:
                if is_below(item, path):
                    folder_path(target + item[len(path):], allow_root=False)
            for row in moving:
                connection.execute("update learning.notes set path=%s, updated_at=clock_timestamp() where id=%s", (target + row["path"][len(path):], row["id"]))
            for row in connection.execute("select path from learning.note_folders order by path").fetchall():
                if is_below(row["path"], path):
                    connection.execute("update learning.note_folders set path=%s, updated_at=clock_timestamp() where path=%s", (target + row["path"][len(path):], row["path"]))
            self._ensure_folder(connection, target)
            return {"path": target, "moved_notes": len(moving)}
        return self._write(key, {"action": "folder-rename", "path": path, "target": target, "version": version}, action)

    def export_zip(self, folder: str | None = None) -> bytes:
        if folder is not None:
            folder_path(folder)
        with self.database.connection() as connection:
            connection.execute("set transaction isolation level repeatable read")
            total = connection.execute("select coalesce(sum(octet_length(content)), 0) as bytes, count(*) as count from learning.notes where deleted_at is null and (%s::text is null or path like %s escape '!' or (%s = '' and strpos(path, '/') = 0))", (folder, (folder.replace('!', '!!').replace('%', '!%').replace('_', '!_') + '/%') if folder else None, folder)).fetchone()
            if total["bytes"] > 50 * 1024 * 1024 or total["count"] > 10000:
                raise NotesError(413, "This download exceeds 50 MiB or 10,000 Notes. Download a smaller folder instead.")
            rows = connection.execute("select path, content from learning.notes where deleted_at is null and (%s::text is null or path like %s escape '!' or (%s = '' and strpos(path, '/') = 0)) order by path", (folder, (folder.replace('!', '!!').replace('%', '!%').replace('_', '!_') + '/%') if folder else None, folder)).fetchall()
        selected = [row for row in rows if folder is None or (folder == "" and folder_of(row["path"]) == "") or (folder and row["path"].startswith(folder + "/"))]
        if not selected:
            raise NotesError(404, "No saved Notes in this download")
        output = io.BytesIO()
        size = 0
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for row in selected:
                note_path(row["path"])
                body = row["content"].encode("utf-8")
                size += len(body)
                if size > 50 * 1024 * 1024:
                    raise NotesError(413, "This download exceeds 50 MiB or 10,000 Notes. Download a smaller folder instead.")
                archive.writestr(row["path"], body)
        return output.getvalue()
