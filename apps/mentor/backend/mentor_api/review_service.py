"""Request-owned review generation with bounded admission and cancellation polling."""
from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from datetime import datetime, timezone
from uuid import UUID

from .review_generation import generate_review
from .review_snapshot import ReviewSnapshot


class ReviewUnavailable(RuntimeError):
    pass


class ReviewCoordinator:
    def __init__(self, store, provider_factory, model: str, mode: str = "strict_schema", capacity: int = 2):
        if not 1 <= capacity <= 8:
            raise ValueError("Invalid review capacity")
        self.store, self.provider_factory, self.model, self.mode = store, provider_factory, model, mode
        self.slots = asyncio.Semaphore(capacity)

    async def generate(self, session_id: UUID, client_id: UUID, cutoff_id: UUID, disconnected) -> tuple[dict, int]:
        existing = await asyncio.to_thread(self.store.existing, session_id, client_id, cutoff_id)
        if existing is not None:
            return await asyncio.to_thread(self.store.get, existing["id"]), 202 if existing["status"] == "running" else 200
        # Factory validation must not send a request or read source material.
        provider_builder = self.provider_factory()
        try:
            await asyncio.wait_for(self.slots.acquire(), timeout=0.1)
        except TimeoutError:
            raise ReviewUnavailable("review_capacity_exceeded") from None
        row = None
        created = False
        task = None
        try:
            acceptance = asyncio.create_task(asyncio.to_thread(self.store.accept, session_id, client_id, cutoff_id, self.model, self.mode))
            try:
                row, created = await asyncio.shield(acceptance)
            except asyncio.CancelledError:
                row, created = await acceptance
                if created:
                    await asyncio.to_thread(self.store.cancel, row["id"])
                raise
            if not created:
                return await asyncio.to_thread(self.store.get, row["id"]), 202 if row["status"] == "running" else 200
            snapshot = ReviewSnapshot(json.dumps(row["snapshot"], sort_keys=True, ensure_ascii=False, separators=(",", ":")))
            provider = provider_builder(snapshot)
            remaining = (row["deadline"] - datetime.now(timezone.utc)).total_seconds()
            if remaining <= 0:
                raise ReviewUnavailable("review_deadline_exceeded")
            task = asyncio.create_task(generate_review(provider, snapshot.evidence_ids, deadline_seconds=min(60, remaining)))
            while not task.done():
                await asyncio.wait({task}, timeout=0.2)
                if await disconnected():
                    raise asyncio.CancelledError
                current = await asyncio.to_thread(self.store.get, row["id"])
                if current["status"] != "running":
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
                    return current, 201
            result = await task
            await asyncio.to_thread(self.store.finish, row["id"], result)
            return await asyncio.to_thread(self.store.get, row["id"]), 201
        except BaseException:
            if task is not None and not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
            if row is not None and created:
                await asyncio.to_thread(self.store.cancel, row["id"])
            raise
        finally:
            self.slots.release()
