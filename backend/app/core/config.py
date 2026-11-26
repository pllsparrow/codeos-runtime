from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


_REPOSITORY_ENV = Path(__file__).resolve().parents[3] / ".env"
_AUTH_ENV = Path(__file__).resolve().parents[3] / ".codeos-auth.env"


class Settings(BaseSettings):
    app_name: str = "CodeOS API"
    environment: str = "development"
    database_url: str | None = None
    database_schema: str = "career"
    database_sslmode: Literal[
        "disable", "allow", "prefer", "require", "verify-ca", "verify-full"
    ] = "require"
    database_connect_timeout_seconds: int = Field(default=10, ge=1, le=60)
    ai_api_url: str | None = None
    ai_api_key: str | None = None
    ai_model: str = "gpt-4o-mini"
    applications_ai_intake_enabled: bool = False
    discover_ai_screening_enabled: bool = False
    ai_reasoning_effort: str | None = None
    ai_request_timeout_seconds: int = Field(default=20, ge=1, le=120)
    ai_fallback_api_url: str | None = None
    ai_fallback_api_key: str | None = None
    ai_fallback_model: str | None = None
    ai_fallback_reasoning_effort: str | None = None
    ai_fallback_request_timeout_seconds: int = Field(default=20, ge=1, le=120)
    doubao_api_url: str | None = None
    doubao_api_key: str | None = None
    doubao_model: str = "doubao-seed-1-6-250615"
    doubao_request_timeout_seconds: int = Field(default=30, ge=1, le=120)
    job_search_github_sources: str = ""
    job_search_sources: str = ""
    job_search_feed_sources: str = ""
    codeos_owner_email: str | None = None
    codeos_owner_password_hash: str | None = None
    codeos_session_ttl_seconds: int = Field(default=43200, ge=300, le=5184000)
    codeos_session_state_dir: Path | None = None
    codeos_session_cookie_name: str = "codeos_session"
    codeos_csrf_cookie_name: str = "codeos_csrf"
    codeos_cookie_secure: bool = False
    codeos_local_auto_login: bool = False
    jobmail_internal_token: str | None = None

    model_config = SettingsConfigDict(
        env_file=(_REPOSITORY_ENV, _AUTH_ENV),
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()
