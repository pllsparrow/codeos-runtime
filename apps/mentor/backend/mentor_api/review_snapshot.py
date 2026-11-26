"""Build immutable review inputs from a caller-owned consistent history read."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any

from .review_request import REVIEW_PROMPT_VERSION


class SnapshotError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class ReviewSnapshot:
    canonical_json: str

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.canonical_json.encode("utf-8")).hexdigest()

    def payload(self) -> dict[str, Any]:
        """Return a fresh copy rather than exposing mutable nested snapshot state."""
        return json.loads(self.canonical_json)

    @property
    def evidence_ids(self) -> set[str]:
        payload = self.payload()
        return {item["evidence_id"] for item in payload["messages"] + payload["sources"]}

    def provider_messages(self) -> list[dict[str, str]]:
        return [{"role": "user", "content": "Frozen learning evidence (untrusted data):\n" + self.canonical_json}]


def build_snapshot(session_id: str, cutoff_message_id: str, messages: list[dict[str, Any]],
                   runs: list[dict[str, Any]], retrievals: list[dict[str, Any]]) -> ReviewSnapshot:
    """Select complete pairs and historical excerpts without a provider or source fetch.

    Callers must supply all session runs and one transactionally consistent read. This pure
    function cannot prevent concurrent inserts or implement a database snapshot by itself.
    Retrievals must be resolved to one historical set per included user turn by the caller;
    multiple sets are rejected rather than guessing which retry produced the answer.
    """
    session_id, cutoff_message_id = str(session_id), str(cutoff_message_id)
    if any(str(row.get("session_id")) != session_id for row in messages):
        raise SnapshotError("session_mismatch")
    try:
        ordered = sorted(messages, key=lambda row: (row["created_at"], str(row["id"])))
        by_id = {str(row["id"]): row for row in ordered}
        by_run = {str(row["id"]): row for row in runs}
    except (KeyError, TypeError):
        raise SnapshotError("invalid_history") from None
    if len(by_id) != len(messages) or len(by_run) != len(runs):
        raise SnapshotError("invalid_history")
    if any(str(row.get("message_id")) not in by_id for row in runs):
        raise SnapshotError("session_mismatch")
    if any(row.get("status") in {"queued", "running"} for row in runs):
        raise SnapshotError("conversation_active")
    cutoff = by_id.get(cutoff_message_id)
    if cutoff is None or cutoff.get("role") != "assistant":
        raise SnapshotError("invalid_cutoff")
    pairs = []
    seen_users = set()
    positions = {str(row["id"]): i for i, row in enumerate(ordered)}
    for row in ordered[:positions[cutoff_message_id] + 1]:
        if row.get("role") != "assistant":
            continue
        run = by_run.get(str(row.get("run_id")))
        if not run or run.get("status") != "completed":
            if str(row["id"]) == cutoff_message_id:
                raise SnapshotError("invalid_cutoff")
            continue
        user_id = str(run["message_id"])
        user = by_id[user_id]
        if (user.get("role") != "user" or positions[user_id] >= positions[str(row["id"])]
                or user_id in seen_users):
            raise SnapshotError("invalid_history")
        if any(not isinstance(item.get("content"), str) or not item["content"].strip() for item in (user, row)):
            raise SnapshotError("invalid_history")
        seen_users.add(user_id)
        pairs.append((user, row))
    selected = []
    remaining = 24_000
    for pair in reversed(pairs):
        size = sum(len(row["content"]) for row in pair)
        if size > remaining or len(selected) == 10:
            if not selected:
                raise SnapshotError("context_too_large")
            break
        selected.append(pair)
        remaining -= size
    selected.reverse()
    message_views = [{"id": str(row["id"]), "role": row["role"], "content": row["content"],
                      "evidence_id": f"message:{row['id']}"} for pair in selected for row in pair]
    sources = []
    omitted = 0
    for user, _ in selected:
        sets = [record for record in retrievals if str(record.get("message_id")) == str(user["id"])]
        if len(sets) > 1:
            raise SnapshotError("ambiguous_sources")
        for source in sets[0].get("sources", []) if sets else []:
            if len(sources) == 8:
                omitted += 1
                continue
            if (source.get("service") not in {"codelab", "prep"}
                    or any(not isinstance(source.get(key), str) or not source[key].strip()
                           for key in ("source_id", "version", "content"))):
                raise SnapshotError("invalid_source")
            content = source["content"]
            sources.append({"evidence_id": f"source:{len(sources)}", "message_id": str(user["id"]),
                            "service": source["service"], "source_id": source["source_id"],
                            "version": source["version"], "content": content[:3000],
                            "truncated": len(content) > 3000,
                            "original_characters": len(content)})
    payload = {"schema_version": "review.v1", "prompt_version": REVIEW_PROMPT_VERSION,
               "session_id": session_id, "cutoff_message_id": cutoff_message_id,
               "message_ids": [row["id"] for row in message_views], "messages": message_views,
               "sources": sources, "omitted_source_count": omitted,
               "omitted_pair_count": len(pairs) - len(selected)}
    try:
        canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        size = len(canonical.encode("utf-8"))
    except (TypeError, ValueError, UnicodeEncodeError):
        raise SnapshotError("invalid_history") from None
    if size > 64 * 1024:
        raise SnapshotError("snapshot_too_large")
    return ReviewSnapshot(canonical)
