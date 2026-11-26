from __future__ import annotations

import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError


ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
EvidenceId = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)]


class ReviewObject(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)


class ReviewObservation(ReviewObject):
    statement: ShortText
    evidence_ids: list[EvidenceId] = Field(min_length=1, max_length=4)


class ReviewExercise(ReviewObject):
    prompt: str = Field(min_length=1, max_length=800)
    expected_check: ShortText


class ReviewDocument(ReviewObject):
    schema_version: Literal["review.v1"]
    topic: str = Field(min_length=1, max_length=120)
    key_points: list[ShortText] = Field(min_length=1, max_length=5)
    observations: list[ReviewObservation] = Field(max_length=3)
    next_exercise: ReviewExercise


class ReviewValidationError(ValueError):
    """Expose a bounded error category without echoing model output."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _reject_constant(_value: str) -> None:
    raise ValueError("Nonstandard JSON constant")


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def validate_review(raw_text: str, allowed_evidence_ids: set[str]) -> ReviewDocument:
    """Validate structure first, then resolve evidence within the frozen snapshot."""
    if len(raw_text.encode("utf-8")) > 32 * 1024:
        raise ReviewValidationError("output_limit")
    try:
        payload = json.loads(raw_text, parse_constant=_reject_constant, object_pairs_hook=_unique_object)
    except (ValueError, RecursionError) as error:
        raise ReviewValidationError("invalid_json") from error
    try:
        document = ReviewDocument.model_validate(payload)
    except ValidationError as error:
        raise ReviewValidationError("invalid_schema") from error
    for observation in document.observations:
        ids = observation.evidence_ids
        if len(set(ids)) != len(ids):
            raise ReviewValidationError("duplicate_evidence")
        if not set(ids).issubset(allowed_evidence_ids):
            raise ReviewValidationError("unknown_evidence")
    return document
