FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY apps/codelab/lab/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY apps/codelab/lab/start.py ./start.py
COPY apps/codelab/lab/execution_budget.py apps/codelab/lab/kernel_policy.py ./

RUN addgroup --gid 10001 --system codelab \
    && adduser --uid 10001 --system --ingroup codelab --home /home/codelab codelab \
    && mkdir -p /workspace \
    && chown -R codelab:codelab /app /workspace /home/codelab

USER codelab
EXPOSE 8888
CMD ["python", "start.py", "--host", "0.0.0.0", "--workspace", "/workspace"]
