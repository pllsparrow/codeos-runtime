from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .languages import PROFILES
import httpx


MAX_JUDGE_RESPONSE_BYTES = 256_000


class JudgeUnavailable(RuntimeError):
    """Raised when the private execution service cannot complete a request."""


class JudgeContractError(RuntimeError):
    """Raised when the private execution service violates its response contract."""


@dataclass(frozen=True)
class JudgeResult:
    verdict: str
    passed: int
    total: int
    first_failure: Any
    result: dict[str, Any]


class JudgeClient:
    """Call the private execution service without exposing database credentials."""

    def __init__(self, base_url: str, token: str, client: httpx.Client | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.client = client or httpx.Client(base_url=self.base_url, timeout=60.0, trust_env=False)

    def check(self) -> None:
        """Verify that the private execution service is reachable and reports ready."""
        try:
            response = self.client.get("/internal/judge/health")
        except httpx.HTTPError as error:
            raise JudgeUnavailable("Codelab execution service is unavailable") from error
        if response.is_error:
            raise JudgeUnavailable(f"Codelab execution service returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError as error:
            raise JudgeContractError("Codelab execution service returned invalid health JSON") from error
        if payload != {"status": "ok"}:
            raise JudgeContractError("Codelab execution service returned an invalid health response")

    def languages(self) -> list[dict[str, Any]]:
        try:
            response = self.client.get(
                "/internal/judge/languages",
                headers={"Authorization": f"Bearer {self.token}"},
            )
            response.raise_for_status()
            if len(response.content) > MAX_JUDGE_RESPONSE_BYTES:
                raise ValueError("Language response is too large")
            profiles = response.json()
            if not isinstance(profiles, list) or len(profiles) != len(PROFILES):
                raise ValueError("Invalid language profiles")
            seen = set()
            for profile in profiles:
                if not isinstance(profile, dict):
                    raise ValueError("Invalid language profile")
                language = profile.get("language")
                if (language not in PROFILES or language in seen
                        or profile.get("profile") != PROFILES[language]
                        or type(profile.get("available")) is not bool):
                    raise ValueError("Invalid language profile")
                seen.add(language)
            return profiles
        except (httpx.HTTPError, ValueError, TypeError) as error:
            raise JudgeUnavailable("Execution languages unavailable") from error

    def submit(
        self,
        *,
        problem_index: int,
        problem_slug: str,
        source: str,
        request_id: str,
        cases: list[dict[str, str]],
        validator: str | None,
        language: str = "python",
    ) -> JudgeResult:
        try:
            response = self.client.post(
                "/internal/judge/submissions",
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Idempotency-Key": request_id,
                },
                json={
                    "problem_index": problem_index,
                    "problem_slug": problem_slug,
                    "source": source,
                    "language_profile": PROFILES[language],
                    "cases": cases,
                    "validator": validator,
                },
            )
        except httpx.HTTPError as error:
            raise JudgeUnavailable("Codelab execution service is unavailable") from error
        if response.is_error:
            raise JudgeUnavailable(f"Codelab execution service returned HTTP {response.status_code}")
        if len(response.content) > MAX_JUDGE_RESPONSE_BYTES:
            raise JudgeContractError("Codelab execution service response is too large")
        try:
            payload = response.json()
        except ValueError as error:
            raise JudgeContractError("Codelab execution service returned invalid JSON") from error
        return _validated_result(payload, request_id)

    def run(
        self,
        *,
        source: str,
        stdin: str,
        request_id: str,
        language: str = "python",
    ) -> dict[str, Any]:
        try:
            response = self.client.post(
                "/internal/judge/runs",
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Idempotency-Key": request_id,
                },
                json={
                    "source": source,
                    "stdin": stdin,
                    "language_profile": PROFILES[language],
                },
            )
        except httpx.HTTPError as error:
            raise JudgeUnavailable("Codelab execution service is unavailable") from error
        if response.is_error:
            raise JudgeUnavailable(f"Codelab execution service returned HTTP {response.status_code}")
        if len(response.content) > MAX_JUDGE_RESPONSE_BYTES:
            raise JudgeContractError("Codelab execution service response is too large")
        try:
            payload = response.json()
        except ValueError as error:
            raise JudgeContractError("Codelab execution service returned invalid JSON") from error
        if not isinstance(payload, dict) or payload.get("request_id") != request_id:
            raise JudgeContractError("Codelab execution service run request ID does not match")
        result = payload.get("result")
        if not isinstance(result, dict) or type(result.get("ok")) is not bool:
            raise JudgeContractError("Codelab execution service run result is invalid")
        for field in ("stdout", "stderr"):
            if not isinstance(result.get(field, ""), str):
                raise JudgeContractError(f"Codelab execution service run {field} is invalid")
        return result


def _validated_result(payload: Any, request_id: str) -> JudgeResult:
    if not isinstance(payload, dict):
        raise JudgeContractError("Codelab execution service response must be an object")
    verdict = payload.get("verdict")
    passed = payload.get("passed")
    total = payload.get("total")
    result = payload.get("result")
    if payload.get("request_id") != request_id:
        raise JudgeContractError("Codelab execution service request ID does not match")
    if verdict not in {"accepted", "failed"}:
        raise JudgeContractError("Codelab execution service verdict is invalid")
    if type(passed) is not int or type(total) is not int or not 0 <= passed <= total or total == 0:
        raise JudgeContractError("Codelab execution service case counts are invalid")
    if not isinstance(result, dict) or result.get("ok") is not (verdict == "accepted"):
        raise JudgeContractError("Codelab execution service result does not match its verdict")
    if result.get("passed") != passed or result.get("total") != total:
        raise JudgeContractError("Codelab execution service result has inconsistent case counts")
    if (verdict == "accepted") is not (passed == total):
        raise JudgeContractError("Codelab execution service verdict has inconsistent case counts")
    return JudgeResult(
        verdict=verdict,
        passed=passed,
        total=total,
        first_failure=payload.get("first_failure"),
        result=result,
    )
