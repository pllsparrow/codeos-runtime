"""Owner login, logout, and session inspection endpoints."""

import hmac
import ipaddress

from fastapi import APIRouter, Request, Response, status

from app.core.config import settings
from app.platform_core.auth import Session, session_store, verify_password
from app.platform_core.http import PlatformAPIError
from app.platform_core.schemas.auth import AuthenticatedUser, LoginRequest, SessionResponse


router = APIRouter(prefix="/auth", tags=["auth"])


def _cookie_options() -> dict[str, object]:
    return {
        "httponly": True,
        "secure": settings.codeos_cookie_secure,
        "samesite": "lax",
        "path": "/",
    }


def _session_from_cookie(codeos_session: str | None) -> Session | None:
    return session_store.get(codeos_session)


def _is_local_auto_login_request(request: Request) -> bool:
    """Allow local auto-login from loopback and the local Docker bridge only."""
    client_host = request.client.host if request.client else None
    if not client_host:
        return False
    try:
        address = ipaddress.ip_address(client_host)
    except ValueError:
        return client_host == "localhost"
    docker_peer = address in ipaddress.ip_network("172.16.0.0/12") or str(address) == "192.168.65.1"
    if docker_peer and request.headers.get("X-Real-IP"):
        # Nginx overwrites this header; do not mistake its bridge peer for the caller.
        try:
            forwarded = ipaddress.ip_address(request.headers["X-Real-IP"])
        except ValueError:
            return False
        return forwarded.is_loopback or str(forwarded) == "192.168.65.1"
    return address.is_loopback or docker_peer


def require_owner_session(request: Request) -> Session:
    session = _session_from_cookie(request.cookies.get(settings.codeos_session_cookie_name))
    if session is None:
        raise PlatformAPIError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="authentication_required",
            message="Authentication is required.",
        )
    return session


def require_owner_csrf(request: Request) -> Session:
    """Require a live owner session and a matching double-submit CSRF token."""

    session = require_owner_session(request)
    csrf_cookie = request.cookies.get(settings.codeos_csrf_cookie_name)
    csrf_header = request.headers.get("X-CSRF-Token")
    if (
        not csrf_cookie
        or not csrf_header
        or not hmac_compare(csrf_cookie, csrf_header)
        or not hmac_compare(session.csrf_token, csrf_header)
    ):
        raise PlatformAPIError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="csrf_validation_failed",
            message="The request could not be verified.",
            retryable=True,
        )
    return session


def _unauthenticated() -> SessionResponse:
    return SessionResponse(authenticated=False, user=None)


@router.post("/login", response_model=SessionResponse)
def login(data: LoginRequest, response: Response) -> SessionResponse:
    configured_email = (settings.codeos_owner_email or "").strip().casefold()
    supplied_email = data.email.strip().casefold()
    if not configured_email or supplied_email != configured_email or not verify_password(
        data.password, settings.codeos_owner_password_hash
    ):
        raise PlatformAPIError(
            status_code=status.HTTP_401_UNAUTHORIZED,
            code="invalid_credentials",
            message="Invalid email or password.",
            retryable=True,
        )

    session = session_store.create(configured_email, settings.codeos_session_ttl_seconds)
    response.set_cookie(
        settings.codeos_session_cookie_name,
        session.token,
        **_cookie_options(),
        max_age=settings.codeos_session_ttl_seconds,
    )
    response.set_cookie(
        settings.codeos_csrf_cookie_name,
        session.csrf_token,
        httponly=False,
        secure=settings.codeos_cookie_secure,
        samesite="lax",
        path="/",
        max_age=settings.codeos_session_ttl_seconds,
    )
    return SessionResponse(authenticated=True, user=AuthenticatedUser(email=configured_email))


@router.post("/local-auto-login", response_model=SessionResponse)
def local_auto_login(request: Request, response: Response) -> SessionResponse:
    """Create a local owner session only when explicitly enabled and called from loopback."""
    # Docker forwards host-local requests through its bridge gateway.
    if not settings.codeos_local_auto_login or not _is_local_auto_login_request(request):
        raise PlatformAPIError(status_code=status.HTTP_404_NOT_FOUND, code="not_found", message="Not found.")
    configured_email = (settings.codeos_owner_email or "").strip().casefold()
    if not configured_email or not settings.codeos_owner_password_hash:
        raise PlatformAPIError(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, code="owner_auth_not_configured", message="Owner authentication is not configured.", retryable=True)
    session = session_store.create(configured_email, settings.codeos_session_ttl_seconds)
    response.set_cookie(settings.codeos_session_cookie_name, session.token, **_cookie_options(), max_age=settings.codeos_session_ttl_seconds)
    response.set_cookie(settings.codeos_csrf_cookie_name, session.csrf_token, httponly=False, secure=settings.codeos_cookie_secure, samesite="lax", path="/", max_age=settings.codeos_session_ttl_seconds)
    return SessionResponse(authenticated=True, user=AuthenticatedUser(email=configured_email))


@router.post("/logout", response_model=SessionResponse)
def logout(
    request: Request,
    response: Response,
) -> SessionResponse:
    codeos_session = request.cookies.get(settings.codeos_session_cookie_name)
    session = _session_from_cookie(codeos_session)
    if session is not None:
        csrf_cookie = request.cookies.get(settings.codeos_csrf_cookie_name)
        csrf_header = request.headers.get("X-CSRF-Token")
        if not csrf_cookie or not csrf_header or not hmac_compare(csrf_cookie, csrf_header) or not hmac_compare(session.csrf_token, csrf_header):
            raise PlatformAPIError(
                status_code=status.HTTP_403_FORBIDDEN,
                code="csrf_validation_failed",
                message="The request could not be verified.",
                retryable=True,
            )
        session_store.revoke(codeos_session)
    response.delete_cookie(settings.codeos_session_cookie_name, path="/")
    response.delete_cookie(settings.codeos_csrf_cookie_name, path="/")
    return _unauthenticated()


@router.get("/session", response_model=SessionResponse)
def inspect_session(request: Request, response: Response) -> SessionResponse:
    codeos_session = request.cookies.get(settings.codeos_session_cookie_name)
    session = _session_from_cookie(codeos_session)
    if session is None and settings.codeos_local_auto_login and _is_local_auto_login_request(request):
        configured_email = (settings.codeos_owner_email or "").strip().casefold()
        if configured_email and settings.codeos_owner_password_hash:
            session = session_store.create(configured_email, settings.codeos_session_ttl_seconds)
            response.set_cookie(settings.codeos_session_cookie_name, session.token, **_cookie_options(), max_age=settings.codeos_session_ttl_seconds)
            response.set_cookie(settings.codeos_csrf_cookie_name, session.csrf_token, httponly=False, secure=settings.codeos_cookie_secure, samesite="lax", path="/", max_age=settings.codeos_session_ttl_seconds)
    if session is None:
        return _unauthenticated()
    return SessionResponse(authenticated=True, user=AuthenticatedUser(email=session.email))


def hmac_compare(left: str, right: str) -> bool:
    """Compare cookie and header values without timing-dependent equality."""

    return hmac.compare_digest(left, right)
