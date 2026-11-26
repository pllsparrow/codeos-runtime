FROM golang:1.26-bookworm@sha256:9fdc884aacc3bec89b20ffc69f4bb369c78210e3e4f600387b5128b12c199f81 AS builder

WORKDIR /src
COPY apps/codelab/runner/go.mod apps/codelab/runner/go.sum ./
RUN go mod download
COPY apps/codelab/runner/ ./
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
    && groupadd --system --gid 10003 lab \
    && useradd --system --uid 10003 --gid 10003 --no-create-home lab \
    && chmod 1777 /tmp

COPY --from=builder /usr/local/go /usr/local/go

# Match the sandbox build profile and keep the seed outside writable workspaces.
RUN GOENV=off GOWORK=off GO111MODULE=off CGO_ENABLED=0 \
    GOCACHE=/opt/codeos-stdlib-cache /usr/local/go/bin/go build -p=1 -trimpath \
    fmt bufio strings strconv sort math container/heap encoding/json bytes \
    && chmod -R a-w /opt/codeos-stdlib-cache
ENV CODEOS_RUNNER_STDLIB_CACHE=/opt/codeos-stdlib-cache

COPY --from=builder /out/codeos-codelab-runner /usr/local/bin/codeos-codelab-runner

USER control

EXPOSE 8003
ENTRYPOINT ["/usr/local/bin/codeos-codelab-runner"]
