"""PostgreSQL review persistence; never hold a transaction across model calls."""
from __future__ import annotations

from uuid import UUID

from psycopg.types.json import Jsonb

from .review_generation import ReviewGeneration
from .review_snapshot import ReviewSnapshot, build_snapshot
from .reviews import validate_review
from .store import PostgresStore


class ReviewConflict(ValueError):
    pass


class _BoundDatabase:
    """Reuse one transaction for snapshot construction and review acceptance."""
    def __init__(self, connection):
        self.connection = connection

    def transaction(self):
        from contextlib import nullcontext
        return nullcontext(self.connection)


class ReviewStore:
    def __init__(self, database: PostgresStore):
        self.database = database

    def snapshot(self, session_id: UUID, cutoff_id: UUID) -> ReviewSnapshot:
        """Use a repeatable read of messages, runs and saved retrievals, never source APIs."""
        with self.database.transaction() as db:
            if not isinstance(self.database, _BoundDatabase):
                db.execute("set transaction isolation level repeatable read, read only")
            session = db.execute("select id from mentor.mentor_sessions where id=%s", (session_id,)).fetchone()
            if session is None:
                raise KeyError("session_not_found")
            messages = db.execute("select * from mentor.mentor_messages where session_id=%s", (session_id,)).fetchall()
            runs = db.execute("select r.* from mentor.mentor_model_runs r join mentor.mentor_messages m "
                              "on m.id=r.message_id where m.session_id=%s", (session_id,)).fetchall()
            retrievals = db.execute("select r.* from mentor.mentor_retrievals r join mentor.mentor_messages m "
                                    "on m.id=r.message_id where m.session_id=%s order by r.created_at,r.id",
                                    (session_id,)).fetchall()
            return build_snapshot(str(session_id), str(cutoff_id), messages, runs, retrievals)

    def existing(self, session_id: UUID, client_id: UUID, cutoff_id: UUID) -> dict | None:
        self.recover()
        with self.database.transaction() as db:
            row = db.execute("select * from mentor.mentor_reviews where session_id=%s and client_review_id=%s",
                             (session_id, client_id)).fetchone()
            if row is not None and row["cutoff_message_id"] != cutoff_id:
                raise ReviewConflict("review_key_reused_with_different_cutoff")
            return row

    def accept(self, session_id: UUID, client_id: UUID, cutoff_id: UUID, model: str, mode: str) -> tuple[dict, bool]:
        with self.database.transaction() as db:
            db.execute("set local lock_timeout='3s'")
            db.execute("set local statement_timeout='5s'")
            if db.execute("select id from mentor.mentor_sessions where id=%s for update", (session_id,)).fetchone() is None:
                raise KeyError("session_not_found")
            bound = ReviewStore(_BoundDatabase(db))
            row = bound.existing(session_id, client_id, cutoff_id)
            if row is not None:
                return row, False
            snapshot = bound.snapshot(session_id, cutoff_id)
            return bound.create(snapshot, client_id, model, mode)

    def create(self, snapshot: ReviewSnapshot, client_id: UUID, model: str, mode: str) -> tuple[dict, bool]:
        payload = snapshot.payload()
        if mode not in {"prompt_json", "strict_schema"} or not model.strip():
            raise ValueError("invalid_review_configuration")
        with self.database.transaction() as db:
            row = db.execute(
                "insert into mentor.mentor_reviews(session_id,cutoff_message_id,client_review_id,snapshot,"
                "snapshot_hash,schema_version,prompt_version,model,mode) values (%s,%s,%s,%s,%s,%s,%s,%s,%s) "
                "on conflict (session_id,client_review_id) do nothing returning *",
                (UUID(payload["session_id"]), UUID(payload["cutoff_message_id"]), client_id, Jsonb(payload),
                 snapshot.sha256, payload["schema_version"], payload["prompt_version"], model, mode)).fetchone()
            if row is not None:
                return row, True
            row = db.execute("select * from mentor.mentor_reviews where session_id=%s and client_review_id=%s",
                             (UUID(payload["session_id"]), client_id)).fetchone()
            if str(row["cutoff_message_id"]) != payload["cutoff_message_id"]:
                raise ReviewConflict("review_key_reused_with_different_cutoff")
            return row, False

    def get(self, review_id: UUID) -> dict:
        self.recover()
        with self.database.transaction() as db:
            db.execute("set transaction isolation level repeatable read, read only")
            row = db.execute("select * from mentor.mentor_reviews where id=%s", (review_id,)).fetchone()
            if row is None:
                raise KeyError("review_not_found")
            row["attempts"] = db.execute("select attempt_no,duration_ms,error_code,model,mode,input_tokens,output_tokens "
                                         "from mentor.mentor_review_attempts where review_id=%s order by attempt_no",
                                         (review_id,)).fetchall()
            return row

    def finish(self, review_id: UUID, generation: ReviewGeneration) -> dict:
        with self.database.transaction() as db:
            row = db.execute("select *, deadline <= now() as expired from mentor.mentor_reviews where id=%s for update",
                             (review_id,)).fetchone()
            if row is None:
                raise KeyError("review_not_found")
            if row["status"] != "running":
                return row
            if row["expired"]:
                return db.execute("update mentor.mentor_reviews set status='failed',error_code='deadline_exceeded',"
                                  "finished_at=now() where id=%s returning *", (review_id,)).fetchone()
            if generation.status not in {"completed", "failed"} or not 1 <= len(generation.attempts) <= 2:
                raise ValueError("invalid_generation")
            document = None
            if generation.status == "completed":
                if generation.document is None:
                    raise ValueError("missing_review_document")
                allowed = {item["evidence_id"] for item in row["snapshot"]["messages"] + row["snapshot"]["sources"]}
                document = validate_review(generation.document.model_dump_json(), allowed).model_dump()
            for number, attempt in enumerate(generation.attempts, 1):
                if attempt.number != number:
                    raise ValueError("invalid_attempt_order")
                db.execute("insert into mentor.mentor_review_attempts(review_id,attempt_no,duration_ms,error_code,"
                           "model,mode,input_tokens,output_tokens) values (%s,%s,%s,%s,%s,%s,%s,%s)",
                           (review_id, number, attempt.duration_ms, attempt.error_code, attempt.metadata.model,
                            attempt.metadata.mode, attempt.metadata.input_tokens, attempt.metadata.output_tokens))
            return db.execute("update mentor.mentor_reviews set status=%s,result=%s,error_code=%s,finished_at=now() "
                              "where id=%s returning *", (generation.status, Jsonb(document) if document else None,
                              None if document else generation.error_code, review_id)).fetchone()

    def list(self, session_id: UUID, before: UUID | None = None) -> dict:
        """Use a session-scoped keyset cursor, never an offset over changing history."""
        self.recover()
        with self.database.transaction() as db:
            db.execute("set transaction isolation level repeatable read, read only")
            if db.execute("select id from mentor.mentor_sessions where id=%s", (session_id,)).fetchone() is None:
                raise KeyError("session_not_found")
            params: tuple = (session_id,)
            boundary = ""
            if before is not None:
                cursor = db.execute("select created_at,id from mentor.mentor_reviews where id=%s and session_id=%s",
                                    (before, session_id)).fetchone()
                if cursor is None:
                    raise KeyError("review_cursor_not_found")
                boundary = " and (r.created_at,r.id) < (%s,%s)"
                params += (cursor["created_at"], cursor["id"])
            rows = db.execute("select r.*, (select count(*) from mentor.mentor_review_attempts a "
                              "where a.review_id=r.id) as attempt_count from mentor.mentor_reviews r "
                              "where r.session_id=%s" + boundary + " order by r.created_at desc,r.id desc limit 21",
                              params).fetchall()
            return {"items": rows[:20], "next_cursor": rows[19]["id"] if len(rows) > 20 else None}

    def cancel(self, review_id: UUID) -> dict:
        with self.database.transaction() as db:
            db.execute("update mentor.mentor_reviews set status='cancelled',error_code='cancelled',finished_at=now() "
                       "where id=%s and status='running'", (review_id,))
        return self.get(review_id)

    def recover(self) -> int:
        with self.database.transaction() as db:
            return db.execute("update mentor.mentor_reviews set status='failed',error_code='interrupted',finished_at=now() "
                              "where status='running' and deadline + interval '10 seconds' < now()").rowcount
