#!/usr/bin/env python3
"""Application services for the local Codelab Coding app."""

from __future__ import annotations

import base64
import json
import os
import selectors
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from app.judge.validators import output_matches

MAX_SOURCE_BYTES = 256_000
MAX_INPUT_BYTES = 256_000
MAX_OUTPUT_BYTES = 65_536
RUN_TIMEOUT_SECONDS = 5
SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024
SANDBOX_PROCESS_LIMIT = 16
SANDBOX_OPEN_FILE_LIMIT = 32
SANDBOX_RUNNER_UID = 10002
SANDBOX_RUNNER_GID = 10002
DEBUG_SESSION_TTL_SECONDS = 300
PYTHON_EXECUTABLE = os.environ.get("ALGORITHM_TRAINER_PYTHON", sys.executable)


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def now_text() -> str:
    return datetime.now().isoformat(timespec="seconds")


def diagnostic_hint(error_type: str | None, message: str) -> str | None:
    if error_type == "SyntaxError":
        return "Check brackets, colons, and indentation near the reported line."
    if error_type == "IndexError":
        return "Confirm that the index is smaller than the list length before access."
    if error_type == "NameError":
        return "Check the spelling and scope of the variable or function name."
    if error_type == "ValueError" and "unpack" in message:
        return "Check that split() returns the same number of values as the assignment expects."
    if error_type == "RecursionError":
        return "Check the base case and confirm that every call reduces the problem."
    return None


class Repository:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.data = self.root / "app" / "catalog"
        self.runtime = self.root / "app" / "runtime"
        self.problems = json.loads((self.data / "problems.json").read_text(encoding="utf-8"))
        self.specs = json.loads((self.data / "acm_tests.json").read_text(encoding="utf-8"))
        examples_path = self.data / "examples.json"
        self.examples = json.loads(examples_path.read_text(encoding="utf-8")) if examples_path.exists() else {}
        self.collections = {}
        for manifest_path in (self.root / "questions").glob("*/collection.json"):
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.collections[manifest["id"]] = manifest
        self.by_index = {problem["index"]: problem for problem in self.problems}

    def problem(self, index: int) -> dict[str, Any]:
        problem = self.by_index.get(index)
        if problem is None:
            raise ApiError(404, "Problem not found")
        return problem

    def solution_path(self, problem: dict[str, Any]) -> Path:
        path = (self.root / problem["path"]).resolve()
        questions = (self.root / "questions").resolve()
        if questions not in path.parents or path.suffix != ".py":
            raise ApiError(400, "Invalid solution path")
        return path

    def save_solution(self, problem: dict[str, Any], source: str) -> Path:
        path = self.solution_path(problem)
        descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                file.write(source)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary_path, path)
        finally:
            temporary_path.unlink(missing_ok=True)
        return path


class Store:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.initialize()

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS drafts (
                    problem_index INTEGER PRIMARY KEY,
                    source TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS progress (
                    slug TEXT PRIMARY KEY,
                    status TEXT NOT NULL DEFAULT 'todo',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    accepted INTEGER NOT NULL DEFAULT 0,
                    note TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS submissions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    slug TEXT NOT NULL,
                    status TEXT NOT NULL,
                    code TEXT NOT NULL,
                    result_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(submissions)")}
            additions = {
                "problem_index": "INTEGER",
                "passed": "INTEGER",
                "total": "INTEGER",
                "first_failure_json": "TEXT",
            }
            for name, kind in additions.items():
                if name not in columns:
                    connection.execute(f"ALTER TABLE submissions ADD COLUMN {name} {kind}")
            connection.execute("CREATE INDEX IF NOT EXISTS idx_submissions_problem_created ON submissions(problem_index, created_at)")
            connection.execute("PRAGMA optimize")

    def progress(self) -> dict[str, dict[str, Any]]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM progress").fetchall()
        return {row["slug"]: dict(row) for row in rows}

    def draft(self, index: int) -> dict[str, Any] | None:
        with self.connect() as connection:
            row = connection.execute("SELECT source, updated_at FROM drafts WHERE problem_index = ?", (index,)).fetchone()
        return dict(row) if row else None

    def save_draft(self, index: int, source: str) -> str:
        updated_at = now_text()
        with self._lock, self.connect() as connection:
            connection.execute(
                """
                INSERT INTO drafts(problem_index, source, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(problem_index) DO UPDATE SET source=excluded.source, updated_at=excluded.updated_at
                """,
                (index, source, updated_at),
            )
        return updated_at

    def record_submission(self, problem: dict[str, Any], source: str, result: dict[str, Any]) -> None:
        status = "accepted" if result["ok"] else "failed"
        timestamp = now_text()
        first_failure = result.get("first_failure")
        with self._lock, self.connect() as connection:
            connection.execute(
                """
                INSERT INTO submissions(
                    slug, status, code, result_json, created_at,
                    problem_index, passed, total, first_failure_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    problem["slug"], status, source, json.dumps(result, ensure_ascii=False), timestamp,
                    problem["index"], result["passed"], result["total"],
                    json.dumps(first_failure, ensure_ascii=False) if first_failure else None,
                ),
            )
            connection.execute(
                """
                INSERT INTO progress(slug, status, attempts, accepted, updated_at)
                VALUES (?, ?, 1, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET
                    status=excluded.status,
                    attempts=progress.attempts + 1,
                    accepted=progress.accepted + excluded.accepted,
                    updated_at=excluded.updated_at
                """,
                (problem["slug"], status, int(result["ok"]), timestamp),
            )

    def record_cli_submission(self, slug: str, source: str, result: dict[str, Any]) -> None:
        results = result.get("results", [])
        total = result.get("total_cases", len(results))
        passed = sum(1 for item in results if item.get("passed"))
        first_failure = next((item for item in results if not item.get("passed")), None)
        normalized = {
            **result,
            "passed": total if result.get("ok") else passed,
            "total": total,
            "first_failure": first_failure,
        }
        self.record_submission({"slug": slug, "index": None}, source, normalized)


class RemoteStore:
    """Use the public Codelab API for durable Coding state."""

    def __init__(self, base_url: str, client: Any | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        if client is None:
            import httpx

            ca_file = os.environ.get("CODELAB_CA_FILE")
            client = httpx.Client(
                base_url=self.base_url,
                timeout=30.0,
                trust_env=False,
                verify=ca_file or True,
            )
        self.client = client

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}))
        try:
            import httpx

            response = self.client.request(method, path, headers=headers, **kwargs)
        except httpx.HTTPError as error:
            raise ApiError(503, "Codelab API is unavailable; durable progress was not saved") from error
        if response.is_error:
            try:
                detail = response.json().get("detail", "Codelab API request failed")
            except ValueError:
                detail = "Codelab API request failed"
            raise ApiError(response.status_code, str(detail))
        return response.json()

    def progress(self) -> dict[str, dict[str, Any]]:
        return self._request("GET", "/api/codelab/coding/progress")

    def draft(self, index: int) -> dict[str, Any] | None:
        return self._request("GET", f"/api/codelab/coding/drafts/{index}")

    def save_draft(self, index: int, source: str) -> str:
        result = self._request(
            "PUT",
            f"/api/codelab/coding/drafts/{index}",
            headers={"Idempotency-Key": uuid.uuid4().hex},
            json={"source": source},
        )
        return str(result["updated_at"])

    def submit(self, problem: dict[str, Any], source: str) -> dict[str, Any]:
        """Send source only and return the Mac API's server-owned verdict."""
        response = self._request(
            "POST",
            "/api/codelab/coding/submissions",
            headers={"Idempotency-Key": uuid.uuid4().hex},
            json={
                "problem_index": problem.get("index"),
                "problem_slug": problem["slug"],
                "source": source,
            },
        )
        result = response.get("result")
        if not isinstance(result, dict):
            raise ApiError(502, "Codelab API returned an invalid judge result")
        return result

    def run(self, problem: dict[str, Any], source: str, stdin: str) -> dict[str, Any]:
        """Execute a custom input through the Mac API and private Judge."""
        response = self._request(
            "POST",
            "/api/codelab/coding/runs",
            headers={"Idempotency-Key": uuid.uuid4().hex},
            json={
                "problem_index": problem["index"],
                "problem_slug": problem["slug"],
                "source": source,
                "stdin": stdin,
            },
        )
        result = response.get("result")
        if not isinstance(result, dict):
            raise ApiError(502, "Codelab API returned an invalid run result")
        return result

    def record_submission(self, problem: dict[str, Any], source: str, result: dict[str, Any]) -> None:
        raise RuntimeError("Remote submissions must be judged by the Codelab API")

    def record_cli_submission(self, slug: str, source: str, result: dict[str, Any]) -> None:
        raise RuntimeError("Remote CLI submissions require a catalog problem identity")


class UnsavedStore:
    """Keep offline browsing stateless when the Mac API is not configured."""

    def progress(self) -> dict[str, dict[str, Any]]:
        return {}

    def draft(self, index: int) -> None:
        return None

    def save_draft(self, index: int, source: str) -> str:
        raise ApiError(503, "Mac Codelab API is unavailable; draft and progress were not saved")

    def record_submission(self, problem: dict[str, Any], source: str, result: dict[str, Any]) -> None:
        raise ApiError(503, "Mac Codelab API is unavailable; submission progress was not saved")

    def record_cli_submission(self, slug: str, source: str, result: dict[str, Any]) -> None:
        return None


def configured_store(default_path: Path) -> Store | RemoteStore | UnsavedStore:
    """Use the Mac API or an explicitly non-durable offline view."""
    base_url = os.environ.get("CODELAB_API_URL")
    if not base_url:
        return UnsavedStore()
    return RemoteStore(base_url)


def validate_text(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str):
        raise ApiError(400, f"{field} must be a string")
    if len(value.encode("utf-8")) > limit:
        raise ApiError(413, f"{field} is too large")
    return value


def parse_runtime_error(stderr: str) -> dict[str, Any] | None:
    if not stderr:
        return None
    lines = stderr.rstrip().splitlines()
    last = lines[-1] if lines else "Runtime error"
    error_type, separator, message = last.partition(":")
    line = None
    for item in reversed(lines):
        if 'File "<solution>", line ' in item:
            try:
                line = int(item.split('line ', 1)[1].split(',', 1)[0])
            except ValueError:
                pass
            break
    return {
        "type": error_type if separator else "RuntimeError",
        "message": message.strip() if separator else last,
        "line": line,
        "traceback": stderr[-MAX_OUTPUT_BYTES:],
        "hint": diagnostic_hint(error_type if separator else None, message),
    }


def sandbox_process_options(workdir: str) -> dict[str, Any]:
    """Make a supervisor-owned workspace readable but not writable by the runner."""
    os.chmod(workdir, 0o555)
    return {
        "user": SANDBOX_RUNNER_UID,
        "group": SANDBOX_RUNNER_GID,
        "extra_groups": [],
    }


def execute(
    source: str,
    stdin: str,
    timeout: int = RUN_TIMEOUT_SECONDS,
    python_executable: str = PYTHON_EXECUTABLE,
    *,
    sandbox: bool = False,
) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="codelab-run-") as workdir, tempfile.TemporaryFile(
        mode="w+t", encoding="utf-8"
    ) as stdout_file, tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as stderr_file:
        sandbox_identity: dict[str, Any] = {}
        if sandbox:
            sandbox_identity = sandbox_process_options(workdir)
        process = subprocess.Popen(
            [python_executable, "-c", compile_wrapper(source, sandbox=sandbox)],
            stdin=subprocess.PIPE,
            text=True,
            stdout=stdout_file,
            stderr=stderr_file,
            cwd=workdir,
            env=execution_environment(),
            start_new_session=True,
            **sandbox_identity,
        )
        try:
            process.communicate(stdin, timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            stdout_file.seek(0)
            return {"ok": False, "stdout": stdout_file.read(MAX_OUTPUT_BYTES), "stderr": "", "timed_out": True, "error": {"type": "TimeoutError", "message": f"Execution exceeded {timeout} seconds", "line": None, "hint": "Check that every loop or recursive call makes progress toward termination."}}
        stdout_file.seek(0, os.SEEK_END)
        stderr_file.seek(0, os.SEEK_END)
        output_limited = stdout_file.tell() > MAX_OUTPUT_BYTES or stderr_file.tell() > MAX_OUTPUT_BYTES
        stdout_file.seek(0)
        stderr_file.seek(0)
        stdout = stdout_file.read(MAX_OUTPUT_BYTES)
        stderr = stderr_file.read(MAX_OUTPUT_BYTES)
    if output_limited:
        return {
            "ok": False,
            "stdout": stdout,
            "stderr": stderr,
            "returncode": process.returncode,
            "timed_out": False,
            "error": {
                "type": "OutputLimitError",
                "message": f"Execution output exceeded {MAX_OUTPUT_BYTES} bytes",
                "line": None,
                "hint": "Remove unbounded logging or printing inside loops.",
            },
        }
    return {
        "ok": process.returncode == 0,
        "stdout": stdout,
        "stderr": stderr,
        "returncode": process.returncode,
        "timed_out": False,
        "error": parse_runtime_error(stderr) if process.returncode else None,
    }


def execution_environment() -> dict[str, str]:
    """Return the minimal non-secret environment exposed to submitted code."""
    return {
        "PATH": os.defpath,
        "LANG": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUNBUFFERED": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def judge_cases(
    source: str,
    cases: list[dict[str, str]],
    validator: str | None,
    *,
    python_executable: str = PYTHON_EXECUTABLE,
    sandbox: bool = False,
) -> dict[str, Any]:
    """Evaluate bounded cases without writing files or persistence state."""
    passed = 0
    first_failure = None
    for case_number, case in enumerate(cases, start=1):
        execution = execute(
            source,
            case["stdin"],
            python_executable=python_executable,
            sandbox=sandbox,
        )
        accepted = execution["ok"] and output_matches(
            validator, case["stdin"], execution["stdout"], case["stdout"]
        )
        if accepted:
            passed += 1
        else:
            first_failure = {
                "case": case_number,
                "stdin": case["stdin"],
                "expected": case["stdout"],
                "actual": execution["stdout"],
                "error": execution.get("error"),
            }
            break
    return {
        "ok": first_failure is None,
        "passed": passed,
        "total": len(cases),
        "first_failure": first_failure,
    }


def judge_source(
    repository: Repository,
    problem: dict[str, Any],
    source: str,
    *,
    python_executable: str = PYTHON_EXECUTABLE,
    sandbox: bool = False,
) -> dict[str, Any]:
    """Resolve a repository problem and evaluate its bounded cases."""
    from app.judge.providers import materialize_cases

    spec = repository.specs[problem["slug"]]
    return judge_cases(
        source,
        materialize_cases(spec),
        spec.get("validator"),
        python_executable=python_executable,
        sandbox=sandbox,
    )


def compile_wrapper(source: str, *, sandbox: bool = False) -> str:
    encoded = base64.b64encode(source.encode("utf-8")).decode("ascii")
    limits = [
        "import base64, resource",
        f"resource.setrlimit(resource.RLIMIT_FSIZE, ({MAX_OUTPUT_BYTES + 1}, {MAX_OUTPUT_BYTES + 1}))",
    ]
    if sandbox:
        limits.extend(
            [
                "import ctypes, ctypes.util, errno",
                f"resource.setrlimit(resource.RLIMIT_CPU, ({RUN_TIMEOUT_SECONDS}, {RUN_TIMEOUT_SECONDS + 1}))",
                f"resource.setrlimit(resource.RLIMIT_AS, ({SANDBOX_MEMORY_BYTES}, {SANDBOX_MEMORY_BYTES}))",
                f"resource.setrlimit(resource.RLIMIT_NPROC, ({SANDBOX_PROCESS_LIMIT}, {SANDBOX_PROCESS_LIMIT}))",
                f"resource.setrlimit(resource.RLIMIT_NOFILE, ({SANDBOX_OPEN_FILE_LIMIT}, {SANDBOX_OPEN_FILE_LIMIT}))",
                "seccomp = ctypes.CDLL(ctypes.util.find_library('seccomp'), use_errno=True)",
                "seccomp.seccomp_init.argtypes = [ctypes.c_uint32]",
                "seccomp.seccomp_init.restype = ctypes.c_void_p",
                "seccomp.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]",
                "seccomp.seccomp_syscall_resolve_name.restype = ctypes.c_int",
                "seccomp.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]",
                "seccomp.seccomp_load.argtypes = [ctypes.c_void_p]",
                "seccomp.seccomp_release.argtypes = [ctypes.c_void_p]",
                "filter_context = seccomp.seccomp_init(0x7FFF0000)",
                "assert filter_context, 'seccomp initialization failed'",
                "for syscall in ('socket', 'socketpair', 'connect', 'bind', 'listen', 'accept', 'accept4', 'sendto', 'sendmsg', 'recvfrom', 'recvmsg', 'clone', 'clone3', 'fork', 'vfork', 'execve', 'execveat', 'kill', 'tkill', 'tgkill', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'mount', 'umount2', 'unshare', 'setns', 'keyctl'): (lambda number: number >= 0 and seccomp.seccomp_rule_add(filter_context, 0x00050000 | errno.EPERM, number, 0))(seccomp.seccomp_syscall_resolve_name(syscall.encode()))",
                "assert seccomp.seccomp_load(filter_context) == 0, 'seccomp load failed'",
                "seccomp.seccomp_release(filter_context)",
            ]
        )
    limits.append(
        f"exec(compile(base64.b64decode({encoded!r}), '<solution>', 'exec'), {{'__name__': '__main__'}})"
    )
    return "\n".join(limits)


@dataclass
class DebugSession:
    process: subprocess.Popen[str]
    touched_at: float


class DebugManager:
    def __init__(self, runner: Path, python_executable: str = PYTHON_EXECUTABLE) -> None:
        self.runner = runner
        self.python_executable = python_executable
        self.sessions: dict[str, DebugSession] = {}
        self.lock = threading.Lock()

    def _read_event(self, process: subprocess.Popen[str], timeout: int = RUN_TIMEOUT_SECONDS) -> dict[str, Any]:
        selector = selectors.DefaultSelector()
        assert process.stdout is not None
        selector.register(process.stdout, selectors.EVENT_READ)
        if not selector.select(timeout):
            process.kill()
            raise ApiError(408, "Debug session timed out")
        line = process.stdout.readline()
        if not line:
            stderr = process.stderr.read() if process.stderr else ""
            raise ApiError(500, stderr or "Debug process exited unexpectedly")
        return json.loads(line)

    def start(self, source: str, stdin: str, breakpoints: list[int]) -> tuple[str, dict[str, Any]]:
        self.expire()
        session_id = uuid.uuid4().hex
        process = subprocess.Popen(
            [
                self.python_executable,
                str(self.runner),
                base64.b64encode(source.encode()).decode(),
                base64.b64encode(stdin.encode()).decode(),
                ",".join(map(str, breakpoints)),
            ],
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            env=execution_environment(),
        )
        event = self._read_event(process)
        if event["state"] == "paused":
            with self.lock:
                self.sessions[session_id] = DebugSession(process, time.monotonic())
        else:
            process.wait(timeout=1)
        return session_id, event

    def command(self, session_id: str, command: str, breakpoints: list[int] | None = None) -> dict[str, Any]:
        self.expire()
        with self.lock:
            session = self.sessions.get(session_id)
        if session is None:
            raise ApiError(404, "Debug session not found or expired")
        assert session.process.stdin is not None
        session.process.stdin.write(json.dumps({"command": command, "breakpoints": breakpoints or []}) + "\n")
        session.process.stdin.flush()
        event = self._read_event(session.process)
        session.touched_at = time.monotonic()
        if event["state"] != "paused":
            self.stop(session_id, terminate=False)
        return event

    def stop(self, session_id: str, terminate: bool = True) -> None:
        with self.lock:
            session = self.sessions.pop(session_id, None)
        if not session:
            return
        if terminate and session.process.poll() is None:
            session.process.terminate()
        try:
            session.process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            session.process.kill()
            session.process.wait(timeout=1)
        for stream in (session.process.stdin, session.process.stdout, session.process.stderr):
            if stream:
                stream.close()

    def expire(self) -> None:
        cutoff = time.monotonic() - DEBUG_SESSION_TTL_SECONDS
        with self.lock:
            expired = [key for key, value in self.sessions.items() if value.touched_at < cutoff]
        for session_id in expired:
            self.stop(session_id)


class AppService:
    def __init__(self, root: Path, db_path: Path | None = None, python_executable: str = PYTHON_EXECUTABLE) -> None:
        self.repository = Repository(root)
        self.store = Store(db_path) if db_path is not None else configured_store(self.repository.runtime / "progress.sqlite3")
        self.python_executable = python_executable
        self.debugger = DebugManager(self.repository.root / "app" / "backend" / "debug_runner.py", python_executable)

    def list_problems(self) -> list[dict[str, Any]]:
        progress = self.store.progress()
        return [
            {
                key: problem[key]
                for key in ("index", "slug", "title", "difficulty", "category", "collection")
            }
            | {
                "collection_name": self.repository.collections.get(problem["collection"], {}).get("name", problem["collection"]),
                "progress": progress.get(problem["slug"], {}).get("status", "todo"),
            }
            for problem in self.repository.problems
        ]

    def get_problem(self, index: int) -> dict[str, Any]:
        problem = self.repository.problem(index)
        source = self.repository.solution_path(problem).read_text(encoding="utf-8")
        draft = self.store.draft(index)
        spec = self.repository.specs[problem["slug"]]
        return {
            **problem,
            "collection_name": self.repository.collections.get(problem["collection"], {}).get("name", problem["collection"]),
            "source": source,
            "draft_source": draft["source"] if draft else None,
            "draft_updated_at": draft["updated_at"] if draft else None,
            "format": spec["format"],
            "examples": self.repository.examples.get(problem["slug"], []),
            "progress": self.store.progress().get(problem["slug"], {"status": "todo", "attempts": 0, "accepted": 0}),
        }

    def save_draft(self, index: int, source: Any) -> dict[str, Any]:
        self.repository.problem(index)
        checked = validate_text(source, "source", MAX_SOURCE_BYTES)
        return {"ok": True, "updated_at": self.store.save_draft(index, checked)}

    def run(self, payload: dict[str, Any]) -> dict[str, Any]:
        problem = self.repository.problem(int(payload.get("index", 0)))
        source = validate_text(payload.get("source"), "source", MAX_SOURCE_BYTES)
        stdin = validate_text(payload.get("stdin", ""), "stdin", MAX_INPUT_BYTES)
        if isinstance(self.store, RemoteStore):
            return self.store.run(problem, source, stdin)
        if isinstance(self.store, UnsavedStore):
            raise ApiError(503, "Mac Codelab API is unavailable; Run requires the private Judge")
        return execute(source, stdin, python_executable=self.python_executable)

    def submit(self, payload: dict[str, Any]) -> dict[str, Any]:
        problem = self.repository.problem(int(payload.get("index", 0)))
        source = validate_text(payload.get("source"), "source", MAX_SOURCE_BYTES)
        saved_path = self.repository.save_solution(problem, source)
        if isinstance(self.store, UnsavedStore):
            raise ApiError(503, "Source was saved to Git, but Mac progress is unavailable and unsaved")
        self.store.save_draft(problem["index"], source)
        if isinstance(self.store, RemoteStore):
            result = self.store.submit(problem, source)
        else:
            result = judge_source(
                self.repository,
                problem,
                source,
                python_executable=self.python_executable,
            )
            self.store.record_submission(problem, source, result)
        return {
            **result,
            "saved": True,
            "saved_path": str(saved_path.relative_to(self.repository.root)),
        }

    def ensure_local_debug(self) -> None:
        if not isinstance(self.store, Store):
            raise ApiError(501, "Interactive Debug is available only in isolated local test mode")
