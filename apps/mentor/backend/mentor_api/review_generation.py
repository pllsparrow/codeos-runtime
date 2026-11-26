from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from time import perf_counter

from .reviews import ReviewDocument, ReviewValidationError, validate_review


class ReviewProviderFailure(RuntimeError):
    """A terminal provider failure; transport retries are deliberately excluded."""

    metadata: AttemptMetadata | None = None


@dataclass(frozen=True)
class AttemptMetadata:
    model: str | None = None
    mode: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class ReviewCompletion:
    text: str
    metadata: AttemptMetadata = field(default_factory=AttemptMetadata)


ReviewProvider = Callable[[str | None], Awaitable[str | ReviewCompletion]]
REPAIRABLE = {"invalid_json", "invalid_schema", "unknown_evidence", "duplicate_evidence"}


@dataclass
class ReviewAttempt:
    number: int
    duration_ms: float
    error_code: str | None
    metadata: AttemptMetadata = field(default_factory=AttemptMetadata)


@dataclass
class ReviewGeneration:
    status: str
    document: ReviewDocument | None = None
    error_code: str | None = None
    attempts: list[ReviewAttempt] = field(default_factory=list)
    duration_ms: float = 0

    def token_total(self, field_name: str) -> int | None:
        """A total is known only if every attempt supplied the requested count."""
        if field_name not in {"input_tokens", "output_tokens"}:
            raise ValueError("Unsupported token count")
        counts = [getattr(attempt.metadata, field_name) for attempt in self.attempts]
        return sum(counts) if counts and all(count is not None for count in counts) else None


async def generate_review(
    provider: ReviewProvider,
    allowed_evidence_ids: set[str],
    *,
    deadline_seconds: float = 60,
) -> ReviewGeneration:
    """Run one initial attempt and at most one repair within a shared deadline.

    The provider closure owns the immutable original context. Its only additional
    input is the previous safe validation code, never raw output or traceback.
    """
    if not 0 < deadline_seconds <= 60:
        raise ValueError("Review deadline must be positive and at most 60 seconds")
    started = perf_counter()
    result = ReviewGeneration(status="failed")
    repair_code = None
    attempt_started = started
    metadata = AttemptMetadata()
    try:
        async with asyncio.timeout(deadline_seconds):
            for number in (1, 2):
                attempt_started = perf_counter()
                metadata = AttemptMetadata()
                try:
                    raw = await provider(repair_code)
                    if isinstance(raw, ReviewCompletion):
                        metadata = raw.metadata
                        raw = raw.text
                    document = validate_review(raw, allowed_evidence_ids)
                except ReviewValidationError as error:
                    result.attempts.append(ReviewAttempt(number, (perf_counter() - attempt_started) * 1000, error.code, metadata))
                    result.error_code = error.code
                    if number == 1 and error.code in REPAIRABLE:
                        repair_code = error.code
                        continue
                    break
                else:
                    result.attempts.append(ReviewAttempt(number, (perf_counter() - attempt_started) * 1000, None, metadata))
                    result.status = "completed"
                    result.document = document
                    result.error_code = None
                    break
    except (TimeoutError, ReviewProviderFailure) as error:
        safe_codes = {"schema_unsupported", "provider_not_configured", "provider_http_error",
                      "provider_network_error", "provider_refusal", "incomplete_response",
                      "invalid_envelope", "invalid_usage", "output_limit"}
        provider_code = getattr(error, "code", None)
        code = ("deadline_exceeded" if isinstance(error, TimeoutError) else
                provider_code if provider_code in safe_codes else "provider_failure")
        metadata = getattr(error, "metadata", None) or getattr(provider, "attempt_metadata", metadata)
        result.attempts.append(ReviewAttempt(len(result.attempts) + 1, (perf_counter() - attempt_started) * 1000, code, metadata))
        result.error_code = code
    finally:
        result.duration_ms = (perf_counter() - started) * 1000
    # CancelledError propagates so the request owner can close resources and persist cancellation.
    return result
