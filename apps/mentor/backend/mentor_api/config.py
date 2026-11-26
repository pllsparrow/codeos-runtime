from __future__ import annotations

import os
import re


_SCHEMA_NAME = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def database_url() -> str:
    value = os.environ.get("MENTOR_DATABASE_URL", "").strip()
    if not value:
        raise RuntimeError("MENTOR_DATABASE_URL is required")
    return value


def database_schema() -> str:
    value = os.environ.get("MENTOR_DATABASE_SCHEMA", "mentor").strip()
    if not _SCHEMA_NAME.fullmatch(value):
        raise RuntimeError("MENTOR_DATABASE_SCHEMA must be a lowercase PostgreSQL identifier")
    return value


def model_url() -> str | None:
    value = os.environ.get("MENTOR_MODEL_URL", "").strip() or os.environ.get("AI_API_URL", "").strip()
    return value or None


def model_key() -> str | None:
    value = os.environ.get("MENTOR_MODEL_KEY", "").strip() or os.environ.get("AI_API_KEY", "").strip()
    return value or None


def model_name() -> str:
    return (
        os.environ.get("MENTOR_MODEL", "").strip()
        or os.environ.get("AI_MODEL", "").strip()
        or "gpt-5.6-sol"
    )


def model_reasoning_effort() -> str | None:
    value = (
        os.environ.get("MENTOR_REASONING_EFFORT", "").strip()
        or os.environ.get("AI_REASONING_EFFORT", "").strip()
    )
    return value or None


def prep_url() -> str | None:
    value = os.environ.get("MENTOR_PREP_URL", "").strip()
    return value.rstrip("/") or None


def prep_read_token() -> str | None:
    value = os.environ.get("MENTOR_PREP_READ_TOKEN", "").strip()
    return value or None


def allowed_origins() -> list[str]:
    raw = os.environ.get("MENTOR_ALLOWED_ORIGINS", "http://127.0.0.1:8103")
    return [item.strip() for item in raw.split(",") if item.strip()]
