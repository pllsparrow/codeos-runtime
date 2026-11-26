"""Mount the existing owner authentication in the learning-only distribution."""

from fastapi import Depends, FastAPI, Request, Response

from app.platform_core.api.auth import require_owner_session, router
from app.platform_core.http import PlatformAPIError, RequestIDMiddleware, error_response

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(RequestIDMiddleware)
app.include_router(router, prefix="/api")


@app.exception_handler(PlatformAPIError)
async def platform_error(request: Request, error: PlatformAPIError):
    return error_response(request, error)


@app.get("/owner-check", dependencies=[Depends(require_owner_session)])
def owner_check() -> Response:
    return Response(status_code=204)
