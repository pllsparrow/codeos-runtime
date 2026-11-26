FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend:/app/coding \
    CODELAB_CODING_ROOT=/app/coding

WORKDIR /app
COPY apps/codelab/backend/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/codelab/backend/ ./backend/
COPY apps/codelab/coding/app/ ./coding/app/
# Problem detail responses load the tracked starter solutions from this tree.
COPY apps/codelab/coding/questions/ ./coding/questions/

RUN addgroup --system codelab \
    && adduser --system --ingroup codelab codelab \
    && chown -R codelab:codelab /app

USER codelab
EXPOSE 8001
CMD ["python", "-m", "uvicorn", "codelab_api.server:app", "--host", "0.0.0.0", "--port", "8001"]
