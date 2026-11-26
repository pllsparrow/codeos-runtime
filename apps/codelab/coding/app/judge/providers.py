"""Resolve compact generated test specifications into concrete cases."""

from __future__ import annotations

from typing import Any

from app.judge import heap_bucket_cases, prefix_sum_cases, recursion_cases


def materialize_cases(spec: dict[str, Any]) -> list[dict[str, str]]:
    """Return JSON-compatible cases for stored or generated specifications."""
    if "cases" in spec:
        return spec["cases"]

    provider = spec.get("provider")
    exercise_id = spec.get("exercise_id")
    if provider == "recursion":
        cases = recursion_cases.build_cases(exercise_id)
    elif provider == "heap_buckets":
        cases = heap_bucket_cases.build_cases(exercise_id)
    elif provider == "prefix_sum":
        cases = prefix_sum_cases.build_cases(exercise_id)
    else:
        raise ValueError(f"Unknown case provider: {provider}")
    return [{"stdin": case.stdin, "stdout": case.expected} for case in cases]
