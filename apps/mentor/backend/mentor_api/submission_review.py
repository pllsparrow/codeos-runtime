"""Generate a bounded, evidence-linked review of one immutable Python submission."""
from __future__ import annotations

import asyncio
import json
import secrets
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Path, Request, Response
from pydantic import BaseModel, ConfigDict

from .review_generation import generate_review
from .review_service import ReviewUnavailable
from .review_snapshot import ReviewSnapshot, SnapshotError
from .review_store import ReviewConflict
from .sources import SourceNotFound
from .reviews import ReviewDocument


class ReviewDisconnected(asyncio.CancelledError):
    """Distinguish an observed client disconnect from server task cancellation."""


def build_submission_snapshot(submission_id: int, submission: dict, problem: dict) -> ReviewSnapshot:
    if submission.get('id') != submission_id or submission.get('problem_slug') != problem.get('slug') or submission.get('problem_index') != problem.get('index'):
        raise SnapshotError('submission_problem_mismatch')
    if submission.get('language', 'python') != 'python':
        raise SnapshotError('python_submission_required')
    source = submission.get('source')
    if not isinstance(source, str) or not source.strip():
        raise SnapshotError('submission_source_missing')
    evidence = {
        'schema_version': 'submission-review-input.v1',
        'submission_id': submission_id,
        'messages': [],
        'sources': [
            {'evidence_id': 'submission', 'content': {key: submission.get(key) for key in
                ('id', 'problem_index', 'problem_slug', 'language', 'source', 'verdict', 'passed', 'total', 'first_failure', 'result')}},
            {'evidence_id': 'problem', 'content': {key: problem.get(key) for key in
                ('index', 'slug', 'title', 'summary', 'format', 'examples')}},
        ],
    }
    canonical = json.dumps(evidence, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False, default=str)
    if len(canonical.encode('utf-8')) > 64 * 1024:
        raise SnapshotError('snapshot_too_large')
    return ReviewSnapshot(canonical)


def public_view(row):
    snapshot = row['snapshot']
    content = snapshot['sources'][0]['content']
    return {key: row[key] for key in ('id', 'submission_id', 'status', 'result', 'error_code', 'created_at', 'finished_at')} | {
        'submission': {key: content.get(key) for key in ('id', 'problem_slug', 'language', 'source', 'verdict', 'passed', 'total')},
        'attempt_count': len(row.get('attempts', [])),
    }


class SubmissionReviewCreate(BaseModel):
    model_config = ConfigDict(extra='forbid')
    client_review_id: UUID


class SavedSubmissionView(BaseModel):
    id: int
    problem_slug: str
    language: str
    source: str
    verdict: str
    passed: int
    total: int


class SubmissionReviewView(BaseModel):
    id: UUID
    submission_id: int
    status: Literal['running', 'completed', 'failed', 'cancelled']
    result: ReviewDocument | None
    error_code: str | None
    created_at: datetime
    finished_at: datetime | None
    submission: SavedSubmissionView
    attempt_count: int


class SubmissionReviewPage(BaseModel):
    items: list[SubmissionReviewView]


class SubmissionReviewService:
    def __init__(self, store, adapter, provider_factory, model: str):
        self.store, self.adapter = store, adapter
        self.provider_factory, self.model = provider_factory, model
        self.slots = asyncio.Semaphore(2)

    async def generate(self, submission_id: int, client_id: UUID, disconnected):
        existing = await asyncio.to_thread(self.store.existing, submission_id, client_id)
        if existing is not None:
            return existing, 202 if existing['status'] == 'running' else 200
        builder = self.provider_factory()
        if self.adapter is None:
            raise ReviewUnavailable('Codelab source is not configured')
        try:
            await asyncio.wait_for(self.slots.acquire(), timeout=0.1)
        except TimeoutError:
            raise ReviewUnavailable('Review capacity is busy; try again shortly') from None
        row, created, task = None, False, None
        try:
            # Fetch via the owning API, never read Practice tables from Mentor.
            submission = (await self.adapter.fetch({'service': 'codelab', 'source_id': f'submission/{submission_id}'}))['content']
            problem = (await self.adapter.fetch({'service': 'codelab', 'source_id': f"problem/{submission['problem_index']}"}))['content']
            snapshot = build_submission_snapshot(submission_id, submission, problem)
            acceptance = asyncio.create_task(asyncio.to_thread(self.store.accept, submission_id, client_id, snapshot, self.model))
            try:
                row, created = await asyncio.shield(acceptance)
            except asyncio.CancelledError:
                row, created = await acceptance
                raise
            if not created:
                return row, 202 if row['status'] == 'running' else 200
            remaining = (row['deadline'] - datetime.now(timezone.utc)).total_seconds()
            if remaining <= 0:
                raise ReviewUnavailable('Review deadline expired')
            if await disconnected():
                raise ReviewDisconnected
            task = asyncio.create_task(generate_review(builder(snapshot), snapshot.evidence_ids, deadline_seconds=min(60, remaining)))
            while not task.done():
                await asyncio.wait({task}, timeout=0.2)
                if await disconnected():
                    raise ReviewDisconnected
            generation = await task
            await asyncio.to_thread(self.store.finish, row['id'], generation)
            return await asyncio.to_thread(self.store.get, submission_id, row['id']), 201
        except BaseException:
            if task is not None and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
            if row is not None and created:
                await asyncio.to_thread(self.store.cancel, row['id'])
            raise
        finally:
            self.slots.release()


def create_submission_review_router(service, internal_token):
    def authorize(authorization: str | None = Header(default=None)):
        scheme, _, token = (authorization or '').partition(' ')
        if not internal_token:
            raise HTTPException(503, 'Review access is not configured')
        if scheme.lower() != 'bearer' or not secrets.compare_digest(token.encode(), internal_token.encode()):
            raise HTTPException(401, 'Review authorization required')

    router = APIRouter(prefix='/api/mentor/submissions', dependencies=[Depends(authorize)])

    @router.post('/{submission_id}/reviews', response_model=SubmissionReviewView)
    async def create(payload: SubmissionReviewCreate, request: Request, response: Response, submission_id: int = Path(gt=0)):
        try:
            row, status = await service.generate(submission_id, payload.client_review_id, request.is_disconnected)
            response.status_code = status
            return public_view(row)
        except ReviewDisconnected:
            return Response(status_code=499)
        except SourceNotFound:
            raise HTTPException(404, 'Submission or problem not found') from None
        except SnapshotError as error:
            raise HTTPException(413 if error.code == 'snapshot_too_large' else 409, error.code) from None
        except ReviewConflict:
            raise HTTPException(409, 'Review request ID belongs to another submission') from None
        except (RuntimeError, ValueError, KeyError):
            raise HTTPException(503, 'Review service or source is unavailable; try again later') from None

    @router.get('/{submission_id}/reviews', response_model=SubmissionReviewPage)
    async def history(submission_id: int = Path(gt=0)):
        rows = await asyncio.to_thread(service.store.list, submission_id)
        return {'items': [public_view(row) for row in rows]}

    @router.get('/{submission_id}/reviews/{review_id}', response_model=SubmissionReviewView)
    async def read(review_id: UUID, submission_id: int = Path(gt=0)):
        row = await asyncio.to_thread(service.store.get, submission_id, review_id)
        if row is None:
            raise HTTPException(404, 'Review not found for this submission')
        return public_view(row)

    return router
