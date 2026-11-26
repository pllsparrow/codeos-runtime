FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend

WORKDIR /app
COPY apps/mentor/backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/mentor/backend/ ./backend/

RUN addgroup --system mentor \
    && adduser --system --ingroup mentor mentor \
    && chown -R mentor:mentor /app

USER mentor
EXPOSE 8103
CMD ["python", "-m", "uvicorn", "mentor_api.server:app", "--host", "0.0.0.0", "--port", "8103"]
