FROM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/codeos-codelab-runner ./cmd/runner

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CODEOS_RUNNER_WORKER_SOCKET=/run/codeos-runner/worker.sock \
    CODEOS_RUNNER_PYTHON=/usr/local/bin/python3.12

RUN mkdir -p /run/codeos-runner \
    && chmod 0777 /run/codeos-runner

RUN groupadd --system --gid 10000 control \
    && groupadd --system --gid 10002 worker \
    && useradd --system --uid 10001 --gid 10000 --no-create-home control \
    && useradd --system --uid 10002 --gid 10002 --no-create-home worker \
    && chmod 1777 /tmp

COPY --from=builder /usr/local/go /usr/local/go

COPY --from=builder /out/codeos-codelab-runner /usr/local/bin/codeos-codelab-runner

USER control

EXPOSE 8003
ENTRYPOINT ["/usr/local/bin/codeos-codelab-runner"]
