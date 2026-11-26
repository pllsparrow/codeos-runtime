from __future__ import annotations

import json
from .languages import operation
import os
import re
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any


_SCHEMA_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def database_schema() -> str:
    value = os.environ.get("CODELAB_DATABASE_SCHEMA", "practice").strip()
    if not _SCHEMA_NAME.fullmatch(value):
        raise RuntimeError("CODELAB_DATABASE_SCHEMA must be a lowercase PostgreSQL identifier")
    return value


def _workspace_display_title(resource_path: str, title: str) -> str:
    if resource_path.startswith("workspace/") and title.lower().startswith("untitled"):
        return resource_path.rsplit("/", 1)[-1].removesuffix(".ipynb")
    return title


class _SchemaConnection:
    """Qualify Codelab SQL against the configured schema."""

    def __init__(self, connection: Any, schema: str) -> None:
        self._connection = connection
        self._schema = schema

    def execute(self, query: str, params: Any = None) -> Any:
        return self._connection.execute(query.replace("codelab.", f"{self._schema}."), params or ())

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


class CodelabDatabase:
    """Persist Codelab runtime metadata without exposing a database connection to clients."""

    def __init__(self, database_url: str | None = None, connect: Callable[..., Any] | None = None) -> None:
        self.database_url = database_url or os.environ.get("CODELAB_DATABASE_URL")
        self.schema = database_schema()
        self._connect = connect
        if not self.database_url and self._connect is None:
            raise RuntimeError("CODELAB_DATABASE_URL is required for the Codelab API")

    @contextmanager
    def connection(self) -> Iterator[Any]:
        connect = self._connect
        if connect is None:
            try:
                import psycopg
                from psycopg.rows import dict_row
            except ImportError as error:
                raise RuntimeError(
                    "Install Codelab API dependencies: python3 -m pip install -r apps/codelab/backend/requirements.txt"
                ) from error
            connect = lambda: psycopg.connect(self.database_url, row_factory=dict_row)

        with connect() as connection:
            yield _SchemaConnection(connection, self.schema)

    def progress(self) -> dict[str, dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                select problem_slug, status, attempts, accepted, note, updated_at
                from codelab.coding_progress
                order by problem_slug
                """
            ).fetchall()
        return {row["problem_slug"]: dict(row) for row in rows}

    def check(self) -> None:
        """Verify the migrated Codelab schema is reachable."""
        with self.connection() as connection:
            row = connection.execute(
                "select to_regclass('codelab.coding_progress') as progress_table, "
                "to_regclass('codelab.notebooks') as workspace_table"
            ).fetchone()
        if row is None or row["progress_table"] is None or row["workspace_table"] is None:
            raise RuntimeError("Codelab migrations are not applied")

    def draft(self, problem_index: int, language: str = "python") -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute(
                """
                select problem_index, source, updated_at, coalesce(to_jsonb(d)->>'language','python') as language
                from codelab.coding_drafts d
                where problem_index = %s and coalesce(to_jsonb(d)->>'language','python')=%s
                """,
                (problem_index, language),
            ).fetchone()
        return dict(row) if row else None

    def workspace(self, resource_path: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute(
                """
                select path as resource_path, title, notebook_json, source_path, created_at, updated_at
                from codelab.notebooks
                where (path = %s or source_path = %s) and deleted_at is null
                order by (path = %s) desc
                limit 1
                """,
                (resource_path, resource_path, resource_path),
            ).fetchone()
        if row is None:
            return None
        display_title = row["title"]
        notebook = {**row["notebook_json"], "path": row["resource_path"], "title": display_title}
        return {
            "resource_path": row["resource_path"],
            "title": display_title,
            "source_path": row["source_path"],
            "notebook": notebook,
            "created_at": _timestamp(row["created_at"]),
            "updated_at": _timestamp(row["updated_at"]),
        }

    def list_workspaces(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                select path as resource_path, title, notebook_json, source_path, created_at, updated_at
                from codelab.notebooks
                where deleted_at is null and path not like 'workspace/experiments/%%'
                order by updated_at desc, id desc
                """
            ).fetchall()
        return [
            {
                "resource_path": row["resource_path"],
                "title": row["title"],
                "source_path": row["source_path"],
                "notebook": {**row["notebook_json"], "path": row["resource_path"], "title": row["title"]},
                "created_at": _timestamp(row["created_at"]),
                "updated_at": _timestamp(row["updated_at"]),
            }
            for row in rows
        ]

    def list_workspace_metadata(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """select path as resource_path, title, source_path, updated_at
                from codelab.notebooks where deleted_at is null and path not like 'workspace/experiments/%%' order by path"""
            ).fetchall()
        return [dict(row) | {"updated_at": _timestamp(row["updated_at"])} for row in rows]

    def list_notes(self) -> list[dict[str, Any]]:
        with self.connection() as connection:
            rows = connection.execute(
                """
                select path, title, content, source_path, created_at, updated_at
                from learning.notes
                where deleted_at is null
                order by path
                """
            ).fetchall()
        return [dict(row) | {"created_at": _timestamp(row["created_at"]), "updated_at": _timestamp(row["updated_at"])} for row in rows]

    def note(self, path: str) -> dict[str, Any] | None:
        with self.connection() as connection:
            row = connection.execute(
                """
                select path, title, content, source_path, created_at, updated_at
                from learning.notes where path = %s and deleted_at is null
                """,
                (path,),
            ).fetchone()
        return dict(row) | {"created_at": _timestamp(row["created_at"]), "updated_at": _timestamp(row["updated_at"])} if row else None

    def save_workspace(
        self,
        *,
        resource_path: str,
        title: str,
        notebook: dict[str, Any],
        idempotency_key: str,
        create_only: bool = False,
        source_path: str | None = None,
        expected_version: Any = None,
        intent: str | None = None,
    ) -> dict[str, Any]:
        operation = intent or "lab.workspace"
        try:
            from psycopg.types.json import Json
        except ImportError as error:
            raise RuntimeError("Codelab API requires psycopg JSON support") from error

        with self.connection() as connection:
            connection.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"notebook-source:{resource_path}",))
            cached = self._cached_response(connection, idempotency_key, operation)
            if cached is not None:
                return cached
            moved = connection.execute(
                "select path from codelab.notebooks where source_path = %s and path <> %s and deleted_at is null",
                (resource_path, resource_path),
            ).fetchone()
            if moved is not None:
                raise ValueError("Notebook was renamed in another page. Your local cells and results are retained; download or save a copy before reopening.")
            if create_only or expected_version == "unpersisted":
                row = connection.execute(
                    """insert into codelab.notebooks(path, title, notebook_json, source_path, updated_at, deleted_at)
                    values (%s, %s, %s, %s, clock_timestamp(), null)
                    on conflict (path) do nothing
                    returning path as resource_path, title, notebook_json, created_at, updated_at""",
                    (resource_path, title, Json(notebook), source_path),
                ).fetchone()
            elif expected_version is not None:
                row = connection.execute(
                    """update codelab.notebooks set title = %s, notebook_json = %s,
                    updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
                    where path = %s and updated_at = %s and deleted_at is null
                    returning path as resource_path, title, notebook_json, created_at, updated_at""",
                    (title, Json(notebook), resource_path, expected_version),
                ).fetchone()
            else:
                raise ValueError("Reload this Notebook to obtain its saved revision before saving.")
            if row is None:
                raise ValueError("Notebook changed, was renamed, or the filename already exists. Your local cells and results are retained; download or save a copy before reopening.")
            response = {
                "ok": True,
                "resource_path": row["resource_path"],
                "title": _workspace_display_title(row["resource_path"], row["title"]),
                "notebook": row["notebook_json"],
                "created_at": _timestamp(row["created_at"]),
                "updated_at": _timestamp(row["updated_at"]),
            }
            self._store_response(connection, idempotency_key, operation, response)
        return response

    def rename_workspace(self, old_path: str, new_path: str, idempotency_key: str, title: str | None = None, source_notebook: dict[str, Any] | None = None, expected_version: Any = None) -> dict[str, Any]:
        operation = "lab.workspace.rename"
        with self.connection() as connection:
            connection.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"notebook-source:{old_path}",))
            cached = self._cached_response(connection, idempotency_key, operation)
            if cached is not None:
                return cached
            if expected_version == "unpersisted" and source_notebook is not None:
                moved = connection.execute(
                    "select path from codelab.notebooks where source_path = %s and path <> %s and deleted_at is null",
                    (old_path, old_path),
                ).fetchone()
                if moved is not None:
                    raise ValueError("Notebook was renamed; refresh the directory before renaming again.")
                from psycopg.types.json import Json
                inserted = connection.execute(
                    """insert into codelab.notebooks(path, title, notebook_json, source_path)
                    values (%s, %s, %s, %s) on conflict (path) do nothing returning updated_at""",
                    (old_path, source_notebook["title"], Json(source_notebook), old_path),
                ).fetchone()
                if inserted is None:
                    raise ValueError("Notebook changed in another page; refresh the directory before renaming.")
                expected_version = inserted["updated_at"]
            if expected_version is None or expected_version == "unpersisted":
                raise ValueError("Notebook revision is unavailable; refresh the directory before renaming.")
            row = connection.execute(
                """
                update codelab.notebooks
                set path = %s,
                    source_path = coalesce(source_path, path),
                    title = coalesce(%s, title),
                    notebook_json = jsonb_set(
                        jsonb_set(notebook_json, '{path}', to_jsonb(%s::text), true),
                        '{title}', to_jsonb(coalesce(%s, notebook_json->>'title')), true
                    ),
                    updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
                where path = %s and updated_at = %s and deleted_at is null
                returning path as resource_path, title, notebook_json, created_at, updated_at
                """,
                (new_path, title, new_path, title, old_path, expected_version),
            ).fetchone()
            if row is None:
                raise ValueError("Notebook changed or was renamed in another page; refresh the directory before renaming.")
            display_title = _workspace_display_title(row["resource_path"], row["title"])
            response = {
                "ok": True,
                "resource_path": row["resource_path"],
                "title": display_title,
                "notebook": {**row["notebook_json"], "path": row["resource_path"], "title": display_title},
                "created_at": _timestamp(row["created_at"]),
                "updated_at": _timestamp(row["updated_at"]),
            }
            self._store_response(connection, idempotency_key, operation, response)
        return response

    def save_draft(self, problem_index: int, source: str, idempotency_key: str, language: str = "python") -> dict[str, Any]:
        intent = operation("coding.draft", {"problem_index":problem_index,"source":source,"language":language})
        with self.connection() as connection:
            connection.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))",(idempotency_key,))
            cached = self._cached_response(connection, idempotency_key, intent)
            if cached is not None:
                return cached
            row = connection.execute(
                """
                insert into codelab.coding_drafts(problem_index, source, updated_at,language)
                values (%s, %s, now(),%s)
                on conflict (problem_index,language) do update
                set source = excluded.source, updated_at = excluded.updated_at
                returning problem_index, source, updated_at
                """,
                (problem_index, source,language),
            ).fetchone()
            response = {"ok": True, "updated_at": _timestamp(row["updated_at"])}
            self._store_response(connection, idempotency_key, intent, response)
        return response

    def record_submission(
        self,
        *,
        problem_index: int | None,
        problem_slug: str,
        status: str,
        source: str,
        language: str = "python",
        passed: int,
        total: int,
        first_failure: Any,
        result: dict[str, Any],
        idempotency_key: str,
    ) -> dict[str, Any]:
        intent = operation("coding.submission", {"problem_index":problem_index,"problem_slug":problem_slug,"source":source,"language":language})
        try:
            from psycopg.types.json import Json
        except ImportError as error:
            raise RuntimeError("Codelab API requires psycopg JSON support") from error

        with self.connection() as connection:
            connection.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))",(idempotency_key,))
            cached = self._cached_response(connection, idempotency_key, intent)
            if cached is not None:
                return cached
            submission = connection.execute(
                """
                insert into codelab.coding_submissions(
                    problem_index, problem_slug, status, source, idempotency_key,language
                ) values (%s, %s, %s, %s, %s,%s)
                on conflict (idempotency_key) do update
                set idempotency_key = excluded.idempotency_key
                returning id, created_at
                """,
                (problem_index, problem_slug, status, source, idempotency_key,language),
            ).fetchone()
            connection.execute(
                """
                insert into codelab.coding_submission_results(
                    submission_id, verdict, passed, total, first_failure, result
                ) values (%s, %s, %s, %s, %s, %s)
                on conflict (submission_id) do nothing
                """,
                (
                    submission["id"], status, passed, total,
                    Json(first_failure) if first_failure is not None else None,
                    Json(result),
                ),
            )
            connection.execute(
                """
                insert into codelab.coding_progress(
                    problem_slug, status, attempts, accepted, updated_at
                ) values (%s, %s, 1, %s, now())
                on conflict (problem_slug) do update set
                    status = excluded.status,
                    attempts = codelab.coding_progress.attempts + 1,
                    accepted = codelab.coding_progress.accepted + excluded.accepted,
                    updated_at = excluded.updated_at
                """,
                (problem_slug, status, int(status == "accepted")),
            )
            response = {
                "ok": True, "language": language,
                "submission_id": submission["id"],
                "created_at": _timestamp(submission["created_at"]),
                "verdict": status,
                "passed": passed,
                "total": total,
                "first_failure": first_failure,
                "result": result,
            }
            self._store_response(connection, idempotency_key, intent, response)
        return response

    def submission_response(self, idempotency_key: str, payload: dict | None = None) -> dict[str, Any] | None:
        """Return a completed submission response before invoking the judge again."""
        with self.connection() as connection:
            return self._execution_response(connection, idempotency_key, "coding.submission",payload)

    def submission(self, submission_id: int) -> dict[str, Any] | None:
        """Return a bounded immutable submission snapshot for read-only learning adapters."""
        with self.connection() as connection:
            row = connection.execute(
                """
                select s.id, s.problem_index, s.problem_slug, s.status, s.source, s.created_at, coalesce(to_jsonb(s)->>'language','python') as language,
                       r.verdict, r.passed, r.total, r.first_failure, r.result
                from codelab.coding_submissions s
                join codelab.coding_submission_results r on r.submission_id = s.id
                where s.id = %s
                """,
                (submission_id,),
            ).fetchone()
        return dict(row) if row else None

    def submissions(
        self,
        problem_slug: str,
        *,
        before_id: int | None = None,
        limit: int = 20,
    ) -> dict[str, Any]:
        """Return bounded submission summaries without exposing stored source code."""
        if before_id is None:
            cursor_clause = ""
            parameters: tuple[Any, ...] = (problem_slug, limit + 1)
        else:
            cursor_clause = " and s.id < %s"
            parameters = (problem_slug, before_id, limit + 1)
        with self.connection() as connection:
            rows = connection.execute(
                f"""
                select s.id, s.problem_index, s.problem_slug, s.status, s.created_at, coalesce(to_jsonb(s)->>'language','python') as language,
                       r.verdict, r.passed, r.total, r.first_failure
                from codelab.coding_submissions s
                join codelab.coding_submission_results r on r.submission_id = s.id
                where s.problem_slug = %s{cursor_clause}
                order by s.id desc
                limit %s
                """,
                parameters,
            ).fetchall()
        has_more = len(rows) > limit
        visible = rows[:limit]
        items = [
            {**dict(row), "created_at": _timestamp(row["created_at"])}
            for row in visible
        ]
        return {
            "items": items,
            "next_before_id": items[-1]["id"] if has_more and items else None,
        }

    def record_run(
        self,
        *,
        problem_index: int,
        problem_slug: str,
        source: str,
        stdin: str,
        language: str = "python",
        result: dict[str, Any],
        idempotency_key: str,
    ) -> dict[str, Any]:
        intent = operation("coding.run", {"problem_index":problem_index,"problem_slug":problem_slug,"source":source,"stdin":stdin,"language":language})
        try:
            from psycopg.types.json import Json
        except ImportError as error:
            raise RuntimeError("Codelab API requires psycopg JSON support") from error

        with self.connection() as connection:
            connection.execute("select pg_advisory_xact_lock(hashtextextended(%s,0))",(idempotency_key,))
            cached = self._cached_response(connection, idempotency_key, intent)
            if cached is not None:
                return cached
            row = connection.execute(
                """
                insert into codelab.coding_runs(
                    problem_index, problem_slug, source, stdin, succeeded, result, idempotency_key,language
                ) values (%s, %s, %s, %s, %s, %s, %s,%s)
                returning id, created_at
                """,
                (
                    problem_index,
                    problem_slug,
                    source,
                    stdin,
                    bool(result["ok"]),
                    Json(result),
                    idempotency_key,language,
                ),
            ).fetchone()
            response = {
                "ok": True, "language": language,
                "run_id": row["id"],
                "created_at": _timestamp(row["created_at"]),
                "result": result,
            }
            self._store_response(connection, idempotency_key, intent, response)
        return response

    def run_response(self, idempotency_key: str, payload: dict | None = None) -> dict[str, Any] | None:
        """Return a completed run before invoking the judge again."""
        with self.connection() as connection:
            return self._execution_response(connection, idempotency_key, "coding.run",payload)

    @staticmethod
    def _execution_response(connection: Any, key: str, kind: str, payload: dict | None) -> dict[str, Any] | None:
        if payload is None:
            return CodelabDatabase._cached_response(connection, key, kind)
        receipt = connection.execute(
            "select operation, response from codelab.idempotency_keys where idempotency_key=%s", (key,)
        ).fetchone()
        if receipt is None:
            return None
        expected = operation(kind, payload)
        if receipt["operation"] == kind:
            table = "coding_runs" if kind == "coding.run" else "coding_submissions"
            row = connection.execute(
                f"select r.*, coalesce(to_jsonb(r)->>'language','python') as language "
                f"from codelab.{table} r where idempotency_key=%s", (key,)
            ).fetchone()
            if row is None or any(row.get(k) != v for k, v in payload.items()):
                raise ValueError("Legacy request intent does not match")
        elif receipt["operation"] != expected:
            raise ValueError("Idempotency key source or language does not match")
        response = receipt["response"]
        return response if isinstance(response, dict) else json.loads(response)

    @staticmethod
    def _cached_response(connection: Any, key: str, operation: str) -> dict[str, Any] | None:
        row = connection.execute(
            "select operation, response from codelab.idempotency_keys where idempotency_key = %s",
            (key,),
        ).fetchone()
        if row is None:
            return None
        if row["operation"] != operation:
            raise ValueError("idempotency key was already used for another operation")
        response = row["response"]
        return response if isinstance(response, dict) else json.loads(response)

    @staticmethod
    def _store_response(connection: Any, key: str, operation: str, response: dict[str, Any]) -> None:
        try:
            from psycopg.types.json import Json
        except ImportError as error:
            raise RuntimeError("Codelab API requires psycopg JSON support") from error
        connection.execute(
            """
            insert into codelab.idempotency_keys(idempotency_key, operation, response)
            values (%s, %s, %s)
            """,
            (key, operation, Json(response)),
        )


def _timestamp(value: Any) -> str:
    return value.isoformat() if hasattr(value, "isoformat") else str(value)
