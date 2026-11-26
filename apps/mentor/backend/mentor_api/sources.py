from __future__ import annotations

from typing import Any, Protocol
import hashlib
import json
import re
from pathlib import PurePosixPath
from urllib.parse import quote, urlencode
from uuid import UUID

import httpx


class SourceNotFound(RuntimeError):
    """The owning source API has no record for this reference."""


class SourceAdapter(Protocol):
    async def fetch(self, ref: dict[str, Any]) -> dict[str, Any]: ...


class CompositeSourceAdapter:
    """Route source references to their owning public adapter."""

    def __init__(self, adapters: dict[str, SourceAdapter]) -> None:
        self.adapters = adapters

    async def fetch(self, ref: dict[str, Any]) -> dict[str, Any]:
        service = ref.get("service")
        adapter = self.adapters.get(str(service))
        if adapter is None:
            raise ValueError(f"Unsupported source service: {service}")
        return await adapter.fetch(ref)

    async def catalog(self) -> list[dict[str, str]]:
        adapter = self.adapters.get("codelab")
        if not isinstance(adapter, CodelabHttpAdapter):
            raise RuntimeError("Codelab source adapter is not configured")
        return await adapter.catalog()

    async def notes_catalog(self) -> list[dict[str, str]]:
        adapter = self.adapters.get("codelab")
        if not isinstance(adapter, CodelabHttpAdapter):
            raise RuntimeError("Learning Notes adapter is not configured")
        return await adapter.notes_catalog()

    async def learning_direction_refs(self, limit: int = 12) -> list[dict[str, str]]:
        """Discover bounded completed-learning references through owning adapters."""
        refs = [
            {"service": "codelab", "source_id": "progress"},
            {"service": "codelab", "source_id": "problems"},
        ]
        prep = self.adapters.get("prep")
        if isinstance(prep, PrepHttpAdapter):
            for attempt in await prep.list_attempts(limit=limit):
                attempt_id = attempt["id"]
                refs.extend((
                    {"service": "prep", "source_id": f"attempt/{attempt_id}"},
                    {"service": "prep", "source_id": f"reviews/{attempt_id}"},
                ))
        return refs


class CodelabHttpAdapter:
    """Fetch explicitly selected Codelab resources through its public API."""

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def notes_catalog(self) -> list[dict[str, str]]:
        """List active authoritative Web Notes without reading their bodies."""
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                response = await client.get(f"{self.base_url}/api/codelab/learning/note-workspace")
                response.raise_for_status()
                notes = response.json()["notes"]
            if not isinstance(notes, list):
                raise ValueError("Invalid Notes catalog")
            return [{"service": "codelab", "source_id": f"note/{int(note['id'])}",
                     "title": str(note["title"]), "version": str(note["updated_at"]), "kind": "note"}
                    for note in notes[:1_000] if not note.get("deleted_at")]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            raise RuntimeError("Learning Notes are unavailable") from error

    async def catalog(self) -> list[dict[str, str]]:
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                response = await client.get(f"{self.base_url}/api/codelab/overview")
                response.raise_for_status()
                payload = response.json()
            return [{"service": "codelab", "source_id": item["path"], "title": item["title"],
                     "kind": item["kind"]} for item in payload["resources"][:1_000]
                    if item.get("kind") in {"markdown", "notebook"}]
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as error:
            raise RuntimeError("Codelab Library is unavailable") from error

    async def fetch(self, ref: dict[str, Any]) -> dict[str, Any]:
        source_id = str(ref["source_id"])
        if ref.get("service") == "codelab" and source_id.startswith("notebook-run/"):
            return await self._notebook_run(source_id, ref.get("version"))
        if (ref.get("service") != "codelab" or source_id.startswith("/") or
                any(part in {"", ".", ".."} for part in source_id.split("/")) or
                any(char in source_id for char in ("%", "?", "#", "\\"))):
            raise ValueError("Invalid Codelab source reference")
        is_note = source_id.startswith("note/")
        is_experiment = source_id.startswith("experiment/")
        if is_experiment:
            try:
                identity = UUID(source_id.removeprefix("experiment/"))
            except ValueError:
                raise ValueError("Invalid Lab experiment reference") from None
            if not ref.get("version"):
                raise ValueError("Select a saved Lab result with a run version")
            endpoint = f"/api/codelab/lab/experiments/{identity}"
        elif is_note:
            identity = source_id.removeprefix("note/")
            if not identity.isascii() or not identity.isdigit() or int(identity) <= 0:
                raise ValueError("Invalid Learning Note reference")
            endpoint = f"/api/codelab/learning/note-workspace/notes/{int(identity)}"
        elif source_id == "progress":
            endpoint = "/api/codelab/coding/progress"
        elif source_id == "problems":
            endpoint = "/api/codelab/coding/problems"
        elif source_id.startswith("problem/") and source_id.removeprefix("problem/").isdigit() and int(source_id.removeprefix("problem/")) > 0:
            endpoint = f"/api/codelab/coding/problems/{source_id.removeprefix('problem/')}"
        elif source_id.startswith("submission/") and source_id.removeprefix("submission/").isdigit() and int(source_id.removeprefix("submission/")) > 0:
            endpoint = f"/api/codelab/coding/submissions/{source_id.removeprefix('submission/')}"
        else:
            if not source_id.lower().endswith((".md", ".ipynb")):
                raise ValueError("Select Notes, problem progress or a completed submission")
            endpoint = f"/api/codelab/resources/{quote(source_id, safe='/')}"
        payload = await self._read_source(endpoint)
        if is_experiment:
            return self._experiment_source(source_id, ref["version"], payload)
        if is_note:
            if not isinstance(payload, dict) or not isinstance(payload.get("content"), str) or not payload.get("updated_at"):
                raise RuntimeError("Learning Note returned an invalid response")
            if payload.get("deleted_at"):
                raise SourceNotFound("Learning Note is in Trash; select an active Note")
        content = payload.get("content") if isinstance(payload, dict) else payload
        if content is None and isinstance(payload, dict) and "notebook" in payload:
            content = "\n\n".join(str(cell.get("source", "")) for cell in payload["notebook"].get("cells", []))
        if content is None and isinstance(payload, dict):
            content = payload
        explicit_version = payload.get("updated_at") if isinstance(payload, dict) else None
        version = str(explicit_version or hashlib.sha256(
            json.dumps(content, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest())
        if ref.get("version") and ref["version"] != version:
            raise ValueError("Learning Note changed; reload Notes and send a new question" if is_note
                             else "Codelab source changed; select the current source again")
        return {
            "service": "codelab",
            "source_id": source_id,
            "version": version,
            "title": payload.get("title", "Codelab practice" if source_id in {"progress", "problems"} else source_id) if isinstance(payload, dict) else "Codelab problem catalog",
            "content": content,
        }

    async def _read_source(self, endpoint: str) -> Any:
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                response = await client.get(f"{self.base_url}{endpoint}")
                response.raise_for_status()
                payload = response.json()
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 404:
                raise SourceNotFound("Codelab source not found") from None
            raise RuntimeError("Codelab source is unavailable") from error
        except httpx.HTTPError as error:
            raise RuntimeError("Codelab source is unavailable") from error
        return payload

    async def _notebook_run(self, source_id: str, version: str | None) -> dict[str, Any]:
        _, _, selection = source_id.partition("/")
        position, _, path = selection.partition("/")
        relative = PurePosixPath(path)
        if (not position.isascii() or not position.isdigit() or len(position) > 3 or len(source_id) > 512
                or relative.is_absolute() or relative.as_posix() != path or ".." in relative.parts
                or "\\" in path or any(ord(char) < 32 for char in path)
                or relative.suffix.casefold() != ".ipynb" or path.startswith("workspace/experiments/")):
            raise ValueError("Invalid Notebook cell reference")
        if not version:
            raise ValueError("Select a saved Notebook revision")
        payload = await self._read_source(f"/api/codelab/lab/workspaces/{quote(path, safe='/')}")
        if payload is None:
            raise SourceNotFound("Saved Notebook not found. Reopen it in Lab.")
        if payload["updated_at"] != version:
            raise ValueError("Notebook changed. Reopen it in Lab and select the current saved result.")
        notebook = payload["notebook"]
        cells = notebook["cells"]
        index = int(position)
        cell = cells[index] if index < len(cells) else {}
        execution = cell.get("execution")
        if cell.get("cell_type") != "code" or not execution:
            raise SourceNotFound("This cell has no saved execution. Run it in Lab first.")
        output = "\n".join(item["text"] for item in cell.get("outputs", []))
        content = "\n\n".join((
            f"Python cell {index + 1} · {execution['status']} · {execution['finished_at']}",
            "Learner prediction recorded before this run:\n" + self._excerpt(
                execution.get("prediction") or "(No prediction recorded)", 450),
            "Executed source:\n" + self._excerpt(execution["source"], 1100),
            "Output excerpt:\n" + self._excerpt(output or execution.get("message") or "(No output)", 1150),
        ))
        owners = await self._read_source(
            f"/api/codelab/learning/paths/experiment-context?reference={quote(path, safe='')}")
        if not isinstance(owners, list):
            raise RuntimeError("Course context is unavailable")
        notebook_query = {"notebook": path}
        lesson_href = None
        if owners:
            owner = owners[0]
            if not isinstance(owner, dict) or not all(isinstance(owner.get(key), str) and
                       re.fullmatch(r"[a-z0-9-]+", owner[key]) for key in ("id", "path_id")):
                raise RuntimeError("Invalid course context")
            notebook_query["learning_context"] = owner["id"]
            lesson_href = f"/learning/paths/{owner['path_id']}/lessons/{owner['id']}?stage=experiment"
        elif path.startswith("workspace/course--"):
            raise SourceNotFound("Course experiment is no longer linked. Open it from its lesson.")
        return {"service": "codelab", "source_id": source_id, "version": version,
                "title": f"{notebook['title']} · Python cell {index + 1}", "content": content,
                "notebook_href": "/codelab/jupy?" + urlencode(notebook_query),
                "lesson_href": lesson_href}

    @staticmethod
    def _excerpt(value: str, limit: int) -> str:
        return value if len(value) <= limit else value[:limit] + "\n[Excerpt truncated]"

    @staticmethod
    def _experiment_source(source_id: str, version: str, payload: Any) -> dict[str, Any]:
        result = payload.get("result") if isinstance(payload, dict) else None
        if not isinstance(result, dict):
            raise SourceNotFound("No saved Lab result is available")
        if result.get("finished_at") != version:
            raise ValueError("Lab result changed. Open Lab and select the current result.")
        snapshot = result.get("snapshot")
        output = result.get("output")
        if not isinstance(snapshot, dict) or not isinstance(output, dict) or not isinstance(snapshot.get("source"), str):
            raise RuntimeError("Lab returned an invalid saved result")

        result_fields = {key: output[key] for key in ("ok", "timed_out", "stdout", "stderr", "error", "tables")
                         if key in output}
        content = "\n\n".join((
            f"Saved {snapshot.get('type', 'Lab')} execution at {version}",
            "Executed source:\n" + CodelabHttpAdapter._excerpt(snapshot["source"], 950),
            "Setup excerpt:\n" + CodelabHttpAdapter._excerpt(str(snapshot.get("setup") or ""), 350),
            "Output excerpt:\n" + CodelabHttpAdapter._excerpt(json.dumps(result_fields, ensure_ascii=False), 1250),
        ))
        return {"service": "codelab", "source_id": source_id, "version": version,
                "title": str(payload.get("title") or "Lab experiment"), "content": content}


class PrepHttpAdapter:
    """Fetch completed Prep attempts through the internal least-privilege endpoint."""

    def __init__(self, base_url: str, read_token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.read_token = read_token

    async def list_attempts(self, limit: int = 12) -> list[dict[str, Any]]:
        """List completed attempt summaries without exposing answer snapshots."""
        if not 1 <= limit <= 12:
            raise ValueError("Prep attempt limit must be between 1 and 12")
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                response = await client.get(
                    f"{self.base_url}/api/prep/internal/mentor/attempts",
                    headers={"X-Prep-Internal-Token": self.read_token},
                )
                response.raise_for_status()
                content = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RuntimeError("Prep attempt index is unavailable") from error
        if not isinstance(content, list):
            raise RuntimeError("Prep attempt index returned an invalid response")
        return [item for item in content[:limit] if isinstance(item, dict) and isinstance(item.get("id"), int)]

    async def fetch(self, ref: dict[str, Any]) -> dict[str, Any]:
        source_id = str(ref["source_id"])
        if ref.get("service") != "prep":
            raise ValueError("Invalid completed Prep attempt reference")
        if source_id.isdigit() and int(source_id) > 0:
            endpoint = f"/api/prep/internal/mentor/attempts/{source_id}"
        elif source_id.startswith("reviews/") and source_id.removeprefix("reviews/").isdigit() and int(source_id.removeprefix("reviews/")) > 0:
            endpoint = f"/api/prep/internal/mentor/attempts/{source_id.removeprefix('reviews/')}/reviews"
        elif source_id.startswith("attempt/") and source_id.removeprefix("attempt/").isdigit() and int(source_id.removeprefix("attempt/")) > 0:
            endpoint = f"/api/prep/internal/mentor/attempts/{source_id.removeprefix('attempt/')}"
        else:
            raise ValueError("Invalid completed Prep source reference")
        try:
            async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
                response = await client.get(
                    f"{self.base_url}{endpoint}",
                    headers={"X-Prep-Internal-Token": self.read_token},
                )
                response.raise_for_status()
                content = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise RuntimeError("Prep source is unavailable") from error
        version = hashlib.sha256(
            json.dumps(content, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        if ref.get("version") and ref["version"] != version:
            raise ValueError("Prep source changed; select the current source again")
        attempt_id = source_id.split("/", 1)[-1]
        title = f"Prep reviews for attempt #{attempt_id}" if source_id.startswith("reviews/") else f"Prep attempt #{attempt_id}"
        return {
            "service": "prep",
            "source_id": source_id,
            "version": version,
            "title": title,
            "content": content,
        }
