from __future__ import annotations

import copy
import json
import os
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator, Protocol
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from .config import database_schema, database_url


INTERRUPTED_RUN_ERROR = "Mentor restarted before the response completed; retry to generate a new answer."
INTERRUPTED_REFRESH_ERROR = "Source refresh interrupted by restart; request a new refresh."


class _SchemaConnection:
    """Qualify legacy Mentor SQL against the configured learning schema."""

    def __init__(self, connection: Any, schema: str) -> None:
        self._connection = connection
        self._schema = schema

    def execute(self, query: str, params: Any = None) -> Any:
        return self._connection.execute(query.replace("mentor.", f"{self._schema}."), params or ())

    def __getattr__(self, name: str) -> Any:
        return getattr(self._connection, name)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class MentorStore(Protocol):
    def recover_interrupted_runs(self) -> int: ...
    def recover_interrupted_refreshes(self) -> int: ...
    def publish_refresh(self, job_id: UUID, sources: list[dict[str, Any]]) -> dict[str, Any]: ...
    def list_sessions(self) -> list[dict[str, Any]]: ...
    def list_messages(self, session_id: UUID) -> list[dict[str, Any]]: ...
    def claim_run(self, run_id: UUID) -> bool: ...
    def complete_run(self, run_id: UUID, content: str) -> dict[str, Any]: ...
    def create_session(self, context_mode: str) -> dict[str, Any]: ...
    def get_session(self, session_id: UUID) -> dict[str, Any] | None: ...
    def create_message(self, session_id: UUID, content: str, client_message_id: str | None, source_refs: list[dict[str, Any]] | None = None) -> dict[str, Any]: ...
    def get_message(self, message_id: UUID) -> dict[str, Any] | None: ...
    def create_run(self, message_id: UUID, attempt_no: int, model: str) -> dict[str, Any]: ...
    def get_run(self, run_id: UUID) -> dict[str, Any] | None: ...
    def latest_run_for_message(self, message_id: UUID) -> dict[str, Any] | None: ...
    def update_run(self, run_id: UUID, **values: Any) -> dict[str, Any]: ...
    def create_retrieval(self, message_id: UUID, sources: list[dict[str, Any]]) -> dict[str, Any]: ...
    def get_retrievals(self, message_id: UUID) -> list[dict[str, Any]]: ...
    def create_assistant_message(self, session_id: UUID, content: str, run_id: UUID) -> dict[str, Any]: ...
    def create_refresh_job(self, idempotency_key: str, source_refs: list[dict[str, Any]] | None = None) -> dict[str, Any]: ...
    def get_refresh_job(self, job_id: UUID) -> dict[str, Any] | None: ...
    def claim_refresh_job(self, job_id: UUID) -> dict[str, Any]: ...
    def finish_refresh_job(self, job_id: UUID, status: str, error: str | None = None) -> dict[str, Any]: ...
    def upsert_source(self, source: dict[str, Any]) -> dict[str, Any]: ...
    def list_sources(self) -> list[dict[str, Any]]: ...
    def latest_refresh_job(self) -> dict[str, Any] | None: ...
    def list_profile(self) -> list[dict[str, Any]]: ...
    def upsert_profile(self, topic: str, values: dict[str, Any]) -> dict[str, Any]: ...


class PostgresStore:
    """Persist Mentor-owned records in the configured learning schema."""

    def __init__(self, url: str | None = None) -> None:
        self.url = url

    @contextmanager
    def transaction(self) -> Iterator[psycopg.Connection[dict[str, Any]]]:
        connection = psycopg.connect(self.url or database_url(), row_factory=dict_row)
        try:
            yield _SchemaConnection(connection, database_schema())
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def check(self) -> None:
        with self.transaction() as connection:
            row = connection.execute("select to_regclass(%s) as table_name", (f"{database_schema()}.mentor_sessions",)).fetchone()
            if row is None or row["table_name"] is None:
                raise RuntimeError("Mentor migrations are not applied")

    def recover_interrupted_runs(self) -> int:
        """Fail model runs owned by a process that can no longer complete them."""
        with self.transaction() as connection:
            rows = connection.execute(
                "update mentor.mentor_model_runs set status = 'failed', error = %s, "
                "completed_at = now() where status = 'running' returning id",
                (INTERRUPTED_RUN_ERROR,),
            ).fetchall()
            return len(rows)

    def list_sessions(self) -> list[dict[str, Any]]:
        with self.transaction() as connection:
            return connection.execute(
                "select id, context_mode, archived, created_at from mentor.mentor_sessions "
                "where not archived order by created_at desc, id desc limit 100"
            ).fetchall()

    def recover_interrupted_refreshes(self) -> int:
        """Fail refresh work owned by a process that can no longer publish it."""
        with self.transaction() as connection:
            rows = connection.execute(
                "update mentor.mentor_refresh_jobs set status='failed', error=%s, finished_at=now() "
                "where status='running' returning id",
                (INTERRUPTED_REFRESH_ERROR,),
            ).fetchall()
            return len(rows)

    def publish_refresh(self, job_id: UUID, sources: list[dict[str, Any]]) -> dict[str, Any]:
        """Commit all fetched snapshots and the successful job state together."""
        with self.transaction() as connection:
            job = connection.execute(
                "select * from mentor.mentor_refresh_jobs where id=%s for update", (job_id,)
            ).fetchone()
            if job is None:
                raise KeyError("Unknown refresh job")
            if job["status"] != "running":
                return job
            for source in sources:
                connection.execute(
                    "insert into mentor.mentor_sources(service,source_id,version,checksum,title,content) "
                    "values (%s,%s,%s,%s,%s,%s) on conflict (service,source_id,version,checksum) "
                    "do update set title=excluded.title,content=excluded.content,synced_at=now()",
                    (source["service"], source["source_id"], source["version"], source["checksum"],
                     source.get("title", source["source_id"]), json.dumps(source["content"])),
                )
            return connection.execute(
                "update mentor.mentor_refresh_jobs set status='succeeded',error=null,finished_at=now() "
                "where id=%s returning *", (job_id,)
            ).fetchone()

    def list_messages(self, session_id: UUID) -> list[dict[str, Any]]:
        with self.transaction() as connection:
            return connection.execute(
                "select id, session_id, role, content, source_refs, run_id, created_at "
                "from mentor.mentor_messages where session_id = %s order by created_at, id",
                (session_id,),
            ).fetchall()

    def claim_run(self, run_id: UUID) -> bool:
        with self.transaction() as connection:
            return connection.execute(
                "update mentor.mentor_model_runs set status = 'running', started_at = now() "
                "where id = %s and status = 'queued' returning id", (run_id,),
            ).fetchone() is not None

    def complete_run(self, run_id: UUID, content: str) -> dict[str, Any]:
        """Commit the final answer and completed status in one transaction."""
        with self.transaction() as connection:
            connection.execute("select s.id from mentor.mentor_sessions s join mentor.mentor_messages m "
                               "on m.session_id=s.id join mentor.mentor_model_runs r on r.message_id=m.id "
                               "where r.id=%s for update of s", (run_id,))
            row = connection.execute(
                "update mentor.mentor_model_runs set status = 'completed', partial_output = %s, "
                "completed_at = now() where id = %s and status = 'running' returning *",
                (content, run_id),
            ).fetchone()
            if row is None:
                raise ValueError("Mentor model run is not active")
            connection.execute(
                "insert into mentor.mentor_messages(session_id, role, content, run_id) "
                "select session_id, 'assistant', %s, %s from mentor.mentor_messages where id = %s",
                (content, run_id, row["message_id"]),
            )
            return row

    def create_session(self, context_mode: str) -> dict[str, Any]:
        with self.transaction() as connection:
            row = connection.execute(
                "insert into mentor.mentor_sessions(context_mode) values (%s) returning id, context_mode, archived, created_at",
                (context_mode,),
            ).fetchone()
            return row

    def get_session(self, session_id: UUID) -> dict[str, Any] | None:
        with self.transaction() as connection:
            return connection.execute(
                "select id, context_mode, archived, created_at from mentor.mentor_sessions where id = %s",
                (session_id,),
            ).fetchone()

    def create_message(self, session_id: UUID, content: str, client_message_id: str | None, source_refs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        with self.transaction() as connection:
            connection.execute("select id from mentor.mentor_sessions where id=%s for update", (session_id,))
            if client_message_id:
                existing = connection.execute(
                    "select id, session_id, role, content, created_at from mentor.mentor_messages where session_id = %s and client_message_id = %s",
                    (session_id, client_message_id),
                ).fetchone()
                if existing:
                    return existing
            return connection.execute(
                """
                insert into mentor.mentor_messages(session_id, role, content, client_message_id, source_refs)
                values (%s, 'user', %s, %s, %s)
                returning id, session_id, role, content, created_at
                """,
                (session_id, content, client_message_id, json.dumps(source_refs or [])),
            ).fetchone()

    def get_message(self, message_id: UUID) -> dict[str, Any] | None:
        with self.transaction() as connection:
            return connection.execute(
                "select id, session_id, role, content, source_refs, created_at from mentor.mentor_messages where id = %s",
                (message_id,),
            ).fetchone()

    def create_run(self, message_id: UUID, attempt_no: int, model: str) -> dict[str, Any]:
        with self.transaction() as connection:
            connection.execute("select s.id from mentor.mentor_sessions s join mentor.mentor_messages m "
                               "on m.session_id=s.id where m.id=%s for update of s", (message_id,))
            # Recheck under the write lock: concurrent accepts/retries may share an attempt.
            existing = connection.execute(
                "select * from mentor.mentor_model_runs where message_id=%s and attempt_no=%s",
                (message_id, attempt_no),
            ).fetchone()
            if existing is not None:
                return existing
            return connection.execute(
                """
                insert into mentor.mentor_model_runs(message_id, attempt_no, status, model, started_at, prompt_version)
                values (%s, %s, 'queued', %s, null, 'mentor-conversation-v2')
                returning id, message_id, status, model, attempt_no, partial_output, error, created_at, completed_at
                """,
                (message_id, attempt_no, model),
            ).fetchone()

    def get_run(self, run_id: UUID) -> dict[str, Any] | None:
        with self.transaction() as connection:
            return connection.execute(
                "select id, message_id, status, model, attempt_no, partial_output, error, created_at, completed_at from mentor.mentor_model_runs where id = %s",
                (run_id,),
            ).fetchone()

    def latest_run_for_message(self, message_id: UUID) -> dict[str, Any] | None:
        with self.transaction() as connection:
            return connection.execute(
                "select id, message_id, status, model, attempt_no, partial_output, error, created_at, completed_at from mentor.mentor_model_runs where message_id = %s order by attempt_no desc limit 1",
                (message_id,),
            ).fetchone()

    def update_run(self, run_id: UUID, **values: Any) -> dict[str, Any]:
        allowed = {"status", "partial_output", "error", "started_at", "completed_at", "latency_ms", "input_tokens", "output_tokens"}
        invalid = set(values) - allowed
        if invalid:
            raise ValueError(f"Unsupported run fields: {sorted(invalid)}")
        assignments = ", ".join(f"{key} = %s" for key in values)
        with self.transaction() as connection:
            row = connection.execute(
                f"update mentor.mentor_model_runs set {assignments} where id = %s returning id, message_id, status, model, attempt_no, partial_output, error, created_at, completed_at",
                (*values.values(), run_id),
            ).fetchone()
            if row is None:
                raise KeyError(f"Unknown model run: {run_id}")
            return row

    def create_retrieval(self, message_id: UUID, sources: list[dict[str, Any]]) -> dict[str, Any]:
        with self.transaction() as connection:
            return connection.execute(
                "insert into mentor.mentor_retrievals(message_id, sources) values (%s, %s) returning id, message_id, sources, created_at",
                (message_id, json.dumps(sources)),
            ).fetchone()

    def get_retrievals(self, message_id: UUID) -> list[dict[str, Any]]:
        with self.transaction() as connection:
            return connection.execute(
                "select id, message_id, sources, created_at from mentor.mentor_retrievals where message_id = %s order by created_at",
                (message_id,),
            ).fetchall()

    def create_assistant_message(self, session_id: UUID, content: str, run_id: UUID) -> dict[str, Any]:
        with self.transaction() as connection:
            return connection.execute(
                "insert into mentor.mentor_messages(session_id, role, content, run_id) values (%s, 'assistant', %s, %s) returning id, session_id, role, content, created_at",
                (session_id, content, run_id),
            ).fetchone()

    def create_refresh_job(self, idempotency_key: str, source_refs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        with self.transaction() as connection:
            existing = connection.execute(
                "select id, idempotency_key, source_refs, status, error, created_at, started_at, finished_at from mentor.mentor_refresh_jobs where idempotency_key = %s",
                (idempotency_key,),
            ).fetchone()
            if existing:
                return existing
            return connection.execute(
                "insert into mentor.mentor_refresh_jobs(idempotency_key, source_refs, status) values (%s, %s, 'queued') returning id, idempotency_key, source_refs, status, error, created_at, started_at, finished_at",
                (idempotency_key, json.dumps(source_refs or [])),
            ).fetchone()

    def get_refresh_job(self, job_id: UUID) -> dict[str, Any] | None:
        with self.transaction() as connection:
            return connection.execute(
                "select id, idempotency_key, source_refs, status, error, created_at, started_at, finished_at from mentor.mentor_refresh_jobs where id = %s",
                (job_id,),
            ).fetchone()

    def claim_refresh_job(self, job_id: UUID) -> dict[str, Any]:
        with self.transaction() as connection:
            row = connection.execute(
                "update mentor.mentor_refresh_jobs set status = 'running', started_at = now(), attempt_count = attempt_count + 1 where id = %s and status = 'queued' returning id, idempotency_key, source_refs, status, error, created_at, started_at, finished_at",
                (job_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"Refresh job is missing or not queued: {job_id}")
            return row

    def finish_refresh_job(self, job_id: UUID, status: str, error: str | None = None) -> dict[str, Any]:
        with self.transaction() as connection:
            row = connection.execute(
                "update mentor.mentor_refresh_jobs set status = %s, error = %s, finished_at = now() where id = %s and status = 'running' returning id, idempotency_key, source_refs, status, error, created_at, started_at, finished_at",
                (status, error, job_id),
            ).fetchone()
            if row is None:
                row = connection.execute("select * from mentor.mentor_refresh_jobs where id=%s", (job_id,)).fetchone()
                if row is None:
                    raise KeyError(f"Unknown refresh job: {job_id}")
            return row

    def upsert_source(self, source: dict[str, Any]) -> dict[str, Any]:
        with self.transaction() as connection:
            return connection.execute(
                """
                insert into mentor.mentor_sources(service, source_id, version, checksum, title, content)
                values (%s, %s, %s, %s, %s, %s)
                on conflict (service, source_id, version, checksum) do update set title = excluded.title,
                    content = excluded.content, synced_at = now()
                returning service, source_id, version, checksum, title, content, synced_at
                """,
                (source["service"], source["source_id"], source["version"], source["checksum"], source.get("title", source["source_id"]), json.dumps(source.get("content"))),
            ).fetchone()

    def list_sources(self) -> list[dict[str, Any]]:
        with self.transaction() as connection:
            return connection.execute("select service, source_id, version, checksum, title, content, synced_at from mentor.mentor_sources order by service, source_id, synced_at, version").fetchall()

    def latest_refresh_job(self) -> dict[str, Any] | None:
        with self.transaction() as connection:
            return connection.execute("select id, idempotency_key, source_refs, status, error, created_at, started_at, finished_at from mentor.mentor_refresh_jobs order by created_at desc limit 1").fetchone()

    def list_profile(self) -> list[dict[str, Any]]:
        with self.transaction() as connection:
            return connection.execute("select topic, hypothesis, confidence, user_correction, updated_at from mentor.mentor_profile order by topic").fetchall()

    def upsert_profile(self, topic: str, values: dict[str, Any]) -> dict[str, Any]:
        with self.transaction() as connection:
            return connection.execute(
                """
                insert into mentor.mentor_profile(topic, hypothesis, confidence, user_correction)
                values (%s, %s, %s, %s)
                on conflict (topic) do update set hypothesis = excluded.hypothesis,
                    confidence = excluded.confidence, user_correction = excluded.user_correction,
                    updated_at = now()
                returning topic, hypothesis, confidence, user_correction, updated_at
                """,
                (topic, values["hypothesis"], values["confidence"], values.get("user_correction")),
            ).fetchone()


class MemoryStore:
    """Deterministic store used by focused tests without a database dependency."""

    def __init__(self) -> None:
        self.sessions: dict[UUID, dict[str, Any]] = {}
        self.messages: dict[UUID, dict[str, Any]] = {}
        self.runs: dict[UUID, dict[str, Any]] = {}
        self.client_ids: dict[tuple[UUID, str], UUID] = {}
        self.retrievals: dict[UUID, list[dict[str, Any]]] = {}
        self.refresh_jobs: dict[UUID, dict[str, Any]] = {}
        self.profile: dict[str, dict[str, Any]] = {}
        self.sources: list[dict[str, Any]] = []

    def recover_interrupted_runs(self) -> int:
        recovered = 0
        for row in self.runs.values():
            if row["status"] != "running":
                continue
            row.update(status="failed", error=INTERRUPTED_RUN_ERROR, completed_at=utc_now())
            recovered += 1
        return recovered

    def recover_interrupted_refreshes(self) -> int:
        active = [job for job in self.refresh_jobs.values() if job["status"] == "running"]
        for job in active:
            self.finish_refresh_job(job["id"], "failed", INTERRUPTED_REFRESH_ERROR)
        return len(active)

    def publish_refresh(self, job_id: UUID, sources: list[dict[str, Any]]) -> dict[str, Any]:
        job = self.refresh_jobs[job_id]
        if job["status"] != "running":
            return job
        previous = copy.deepcopy(self.sources)
        try:
            for source in sources:
                self.upsert_source(source)
        except Exception:
            self.sources = previous
            raise
        return self.finish_refresh_job(job_id, "succeeded")

    def create_session(self, context_mode: str) -> dict[str, Any]:
        row = {"id": uuid4(), "context_mode": context_mode, "archived": False, "created_at": utc_now()}
        self.sessions[row["id"]] = row
        return row

    def get_session(self, session_id: UUID) -> dict[str, Any] | None:
        return self.sessions.get(session_id)

    def list_sessions(self) -> list[dict[str, Any]]:
        return sorted((row for row in self.sessions.values() if not row["archived"]),
                      key=lambda row: (row["created_at"], row["id"]), reverse=True)[:100]

    def list_messages(self, session_id: UUID) -> list[dict[str, Any]]:
        return sorted((row for row in self.messages.values() if row["session_id"] == session_id),
                      key=lambda row: (row["created_at"], row["id"]))

    def claim_run(self, run_id: UUID) -> bool:
        row = self.runs.get(run_id)
        if row is None or row["status"] != "queued":
            return False
        row.update(status="running", started_at=utc_now())
        return True

    def complete_run(self, run_id: UUID, content: str) -> dict[str, Any]:
        row = self.runs[run_id]
        if row["status"] != "running":
            raise ValueError("Mentor model run is not active")
        message = self.messages[row["message_id"]]
        self.create_assistant_message(message["session_id"], content, run_id)
        return self.update_run(run_id, status="completed", partial_output=content, completed_at=utc_now())

    def create_message(self, session_id: UUID, content: str, client_message_id: str | None, source_refs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        if client_message_id and (session_id, client_message_id) in self.client_ids:
            return self.messages[self.client_ids[(session_id, client_message_id)]]
        row = {"id": uuid4(), "session_id": session_id, "role": "user", "content": content, "source_refs": source_refs or [], "created_at": utc_now()}
        self.messages[row["id"]] = row
        if client_message_id:
            self.client_ids[(session_id, client_message_id)] = row["id"]
        return row

    def create_retrieval(self, message_id: UUID, sources: list[dict[str, Any]]) -> dict[str, Any]:
        row = {"id": uuid4(), "message_id": message_id, "sources": sources, "created_at": utc_now()}
        self.retrievals.setdefault(message_id, []).append(row)
        return row

    def get_retrievals(self, message_id: UUID) -> list[dict[str, Any]]:
        return self.retrievals.get(message_id, [])

    def create_assistant_message(self, session_id: UUID, content: str, run_id: UUID) -> dict[str, Any]:
        row = {"id": uuid4(), "session_id": session_id, "role": "assistant", "content": content, "run_id": run_id, "created_at": utc_now()}
        self.messages[row["id"]] = row
        return row

    def create_refresh_job(self, idempotency_key: str, source_refs: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        existing = next((job for job in self.refresh_jobs.values() if job["idempotency_key"] == idempotency_key), None)
        if existing:
            return existing
        row = {"id": uuid4(), "idempotency_key": idempotency_key, "source_refs": source_refs or [], "status": "queued", "error": None, "created_at": utc_now(), "started_at": None, "finished_at": None}
        self.refresh_jobs[row["id"]] = row
        return row

    def get_refresh_job(self, job_id: UUID) -> dict[str, Any] | None:
        return self.refresh_jobs.get(job_id)

    def claim_refresh_job(self, job_id: UUID) -> dict[str, Any]:
        row = self.refresh_jobs.get(job_id)
        if row is None or row["status"] != "queued":
            raise KeyError(f"Refresh job is missing or not queued: {job_id}")
        row.update(status="running", started_at=utc_now())
        return row

    def finish_refresh_job(self, job_id: UUID, status: str, error: str | None = None) -> dict[str, Any]:
        row = self.refresh_jobs[job_id]
        if row["status"] != "running":
            return row
        row.update(status=status, error=error, finished_at=utc_now())
        return row

    def upsert_source(self, source: dict[str, Any]) -> dict[str, Any]:
        key = (source["service"], source["source_id"], source["version"], source["checksum"])
        existing = next((item for item in self.sources if item["key"] == key), None)
        row = {**source, "key": key, "synced_at": utc_now()}
        if existing:
            existing.update(row)
            return existing
        self.sources.append(row)
        return row

    def list_sources(self) -> list[dict[str, Any]]:
        return list(self.sources)

    def latest_refresh_job(self) -> dict[str, Any] | None:
        return max(self.refresh_jobs.values(), key=lambda job: job["created_at"], default=None)

    def list_profile(self) -> list[dict[str, Any]]:
        return [self.profile[key] for key in sorted(self.profile)]

    def upsert_profile(self, topic: str, values: dict[str, Any]) -> dict[str, Any]:
        row = {"topic": topic, **values, "updated_at": utc_now()}
        self.profile[topic] = row
        return row

    def get_message(self, message_id: UUID) -> dict[str, Any] | None:
        return self.messages.get(message_id)

    def create_run(self, message_id: UUID, attempt_no: int, model: str) -> dict[str, Any]:
        existing = next((row for row in self.runs.values()
                         if row["message_id"] == message_id and row["attempt_no"] == attempt_no), None)
        if existing is not None:
            return existing
        row = {"id": uuid4(), "message_id": message_id, "status": "queued", "model": model, "attempt_no": attempt_no, "partial_output": "", "error": None, "created_at": utc_now(), "completed_at": None}
        self.runs[row["id"]] = row
        return row

    def get_run(self, run_id: UUID) -> dict[str, Any] | None:
        return self.runs.get(run_id)

    def latest_run_for_message(self, message_id: UUID) -> dict[str, Any] | None:
        rows = [row for row in self.runs.values() if row["message_id"] == message_id]
        return max(rows, key=lambda row: row["attempt_no"], default=None)

    def update_run(self, run_id: UUID, **values: Any) -> dict[str, Any]:
        row = self.runs[run_id]
        row.update(values)
        return row
