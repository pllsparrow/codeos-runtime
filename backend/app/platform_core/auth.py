"""Owner authentication primitives for the CodeOS platform boundary."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable

from .passwords import hash_password, verify_password


@dataclass(frozen=True)
class Session:
    """An opaque server-side owner session."""

    token: str
    csrf_token: str
    email: str
    expires_at: float


class SessionStore:
    """Thread-safe in-memory sessions for the single-process local runtime."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    @contextmanager
    def _transaction(self, *, write: bool = False):
        with self._lock:
            yield

    @staticmethod
    def _key(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    def create(self, email: str, ttl_seconds: int) -> Session:
        now = self._clock()
        session = Session(
            token=secrets.token_urlsafe(32),
            csrf_token=secrets.token_urlsafe(24),
            email=email,
            expires_at=now + ttl_seconds,
        )
        with self._transaction(write=True):
            self._purge_expired(now)
            self._sessions[self._key(session.token)] = replace(session, token="")
        return session

    def get(self, token: str | None) -> Session | None:
        if not token:
            return None
        now = self._clock()
        with self._transaction():
            session = self._sessions.get(self._key(token))
            return replace(session, token=token) if session and session.expires_at > now else None

    def revoke(self, token: str | None) -> None:
        if token:
            with self._transaction(write=True):
                self._sessions.pop(self._key(token), None)

    def _purge_expired(self, now: float) -> None:
        expired = [token for token, session in self._sessions.items() if session.expires_at <= now]
        for token in expired:
            self._sessions.pop(token, None)


class PersistentSessionStore(SessionStore):
    """Private, atomic platform session state shared across local worker lifetimes."""

    def __init__(self, directory: Path, credential_namespace: str,
                 clock: Callable[[], float] = time.time) -> None:
        super().__init__(clock)
        self._directory = directory
        self._namespace = credential_namespace
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)

    @contextmanager
    def _transaction(self, *, write: bool = False):
        # A separate lock inode stays stable when the data file is atomically replaced.
        import fcntl

        with self._lock:
            fd = os.open(self._directory / "sessions.lock", os.O_CREAT | os.O_RDWR, 0o600)
            with os.fdopen(fd, "a+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                path = self._directory / "sessions.json"
                try:
                    payload = json.loads(path.read_text())
                except FileNotFoundError:
                    payload = {}
                self._sessions = {
                    key: Session(token="", **value)
                    for key, value in payload.get("sessions", {}).items()
                } if payload.get("namespace") == self._namespace else {}
                yield
                if write:
                    payload = {"namespace": self._namespace, "sessions": {
                        key: {"email": value.email, "csrf_token": value.csrf_token,
                              "expires_at": value.expires_at}
                        for key, value in self._sessions.items()
                    }}
                    temporary_fd, temporary = tempfile.mkstemp(dir=self._directory)
                    try:
                        with os.fdopen(temporary_fd, "w") as output:
                            json.dump(payload, output)
                            output.flush()
                            os.fsync(output.fileno())
                        os.replace(temporary, path)
                        directory_fd = os.open(self._directory, os.O_RDONLY)
                        try:
                            os.fsync(directory_fd)
                        finally:
                            os.close(directory_fd)
                    finally:
                        if os.path.exists(temporary):
                            os.unlink(temporary)


def _configured_session_store() -> SessionStore:
    from app.core.config import settings

    if settings.codeos_session_state_dir is None:
        return SessionStore()
    namespace = hashlib.sha256(json.dumps([
        (settings.codeos_owner_email or "").strip().casefold(),
        settings.codeos_owner_password_hash,
    ]).encode()).hexdigest()
    return PersistentSessionStore(settings.codeos_session_state_dir, namespace)


session_store = _configured_session_store()
