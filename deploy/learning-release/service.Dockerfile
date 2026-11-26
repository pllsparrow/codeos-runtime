FROM python:3.12-slim AS base
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

FROM base AS auth
RUN pip install --no-cache-dir 'fastapi>=0.115,<0.116' 'pydantic-settings>=2,<3' 'uvicorn>=0.30,<1' 'email-validator>=2,<3'
COPY backend/app/core/config.py app/core/
COPY backend/app/platform_core/passwords.py backend/app/platform_core/auth.py backend/app/platform_core/http.py app/platform_core/
COPY backend/app/platform_core/api/auth.py app/platform_core/api/
COPY backend/app/platform_core/schemas/auth.py app/platform_core/schemas/
COPY deploy/learning-release/auth.py .
RUN mkdir /session && chown 10001:10001 /session
USER 10001:10001
CMD ["python", "-m", "uvicorn", "auth:app", "--host", "0.0.0.0", "--port", "8000"]

FROM base AS setup
RUN pip install --no-cache-dir 'psycopg[binary]>=3.2,<4'
COPY tools/migrate_unified_database.py tools/
COPY apps/codelab/database/migrations apps/codelab/database/migrations/
COPY apps/learning/database/migrations apps/learning/database/migrations/
COPY apps/mentor/database/migrations apps/mentor/database/migrations/
COPY deploy/learning-release/setup_database.py .
COPY deploy/learning-release/sample sample/
USER 10001:10001
CMD ["python", "setup_database.py"]
