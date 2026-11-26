"""Persist submission reviews without cross-schema database access or model transactions."""
from __future__ import annotations

from dataclasses import asdict
from uuid import UUID

from psycopg.types.json import Jsonb

from .review_store import ReviewConflict
from .reviews import validate_review


class SubmissionReviewStore:
    def __init__(self, database):
        self.database = database

    def recover(self):
        with self.database.transaction() as db:
            db.execute("update mentor.mentor_submission_reviews set status='failed',error_code='interrupted',"
                       "finished_at=now() where status='running' and deadline < now()")

    def existing(self, submission_id: int, client_id: UUID):
        self.recover()
        with self.database.transaction() as db:
            row = db.execute("select * from mentor.mentor_submission_reviews where client_review_id=%s", (client_id,)).fetchone()
        if row is not None and row['submission_id'] != submission_id:
            raise ReviewConflict('review_key_reused_with_different_submission')
        return row

    def accept(self, submission_id: int, client_id: UUID, snapshot, model: str):
        with self.database.transaction() as db:
            row = db.execute(
                "insert into mentor.mentor_submission_reviews(submission_id,client_review_id,snapshot,snapshot_hash,model) "
                "values (%s,%s,%s,%s,%s) on conflict (client_review_id) do nothing returning *",
                (submission_id, client_id, Jsonb(snapshot.payload()), snapshot.sha256, model)).fetchone()
        if row is not None:
            return row, True
        return self.existing(submission_id, client_id), False

    def get(self, submission_id: int, review_id: UUID):
        self.recover()
        with self.database.transaction() as db:
            return db.execute("select * from mentor.mentor_submission_reviews where submission_id=%s and id=%s",
                              (submission_id, review_id)).fetchone()

    def list(self, submission_id: int):
        self.recover()
        with self.database.transaction() as db:
            return db.execute("select * from mentor.mentor_submission_reviews where submission_id=%s "
                              "order by created_at desc,id desc limit 20", (submission_id,)).fetchall()

    def finish(self, review_id: UUID, generation):
        with self.database.transaction() as db:
            row = db.execute("select snapshot from mentor.mentor_submission_reviews where id=%s for update", (review_id,)).fetchone()
            if row is None:
                raise KeyError('review_not_found')
            if generation.status not in {'completed', 'failed'}:
                raise ValueError('invalid_generation_status')
            result = None
            if generation.status == 'completed':
                if generation.document is None:
                    raise ValueError('missing_review_document')
                allowed = {item['evidence_id'] for item in row['snapshot']['sources']}
                result = validate_review(generation.document.model_dump_json(), allowed).model_dump()
            db.execute("update mentor.mentor_submission_reviews set status=%s,result=%s,attempts=%s,error_code=%s,finished_at=now() "
                       "where id=%s and status='running' and deadline > now()",
                       (generation.status, Jsonb(result) if result is not None else None, Jsonb([asdict(a) for a in generation.attempts]),
                        generation.error_code, review_id))

    def cancel(self, review_id: UUID):
        with self.database.transaction() as db:
            db.execute("update mentor.mentor_submission_reviews set status='cancelled',error_code='cancelled',finished_at=now() "
                       "where id=%s and status='running'", (review_id,))
