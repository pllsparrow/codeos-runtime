"""Deterministic keyless retrieval over already-authorized Library snapshots."""
from __future__ import annotations

import hashlib
import re
from typing import Any


def tokens(text: str) -> set[str]:
    normalized = text.casefold()
    words = set(re.findall(r"[a-z0-9_]+", normalized))
    for span in re.findall(r"[\u4e00-\u9fff]+", normalized):
        words.update(span[i:i + 2] for i in range(max(1, len(span) - 1)))
    return words


def rank_library(query: str, sources: list[dict[str, Any]], *, limit: int = 8) -> list[dict[str, Any]]:
    """Rank bounded text chunks; exclude non-Library and unknown evidence scopes.

    This is a lexical baseline, not embeddings or a semantic relevance guarantee.
    Only previously ingested snapshots are inputs; it performs no source fetches.
    """
    if not 1 <= limit <= 8 or len(query) > 32_000 or len(sources) > 1000:
        raise ValueError("Retrieval input exceeds bounds")
    terms = tokens(query)
    if not terms:
        return []
    ranked = []
    for source in sources:
        identity = source.get("source_id", "")
        content = source.get("content")
        version = source.get("version")
        if (source.get("service") != "codelab" or not isinstance(identity, str)
                or not identity.endswith((".md", ".ipynb")) or identity.startswith("/")
                or any(part in {"", ".", ".."} for part in identity.split("/"))
                or any(char in identity for char in "%?#\\")
                or not isinstance(content, str) or not isinstance(version, str) or not version):
            continue
        # Large sources require ingestion-time chunking, not silent prefix-only indexing.
        if len(content) > 96_000:
            continue
        for offset in range(0, len(content), 2400):
            excerpt = content[offset:offset + 3000]
            score = len(terms & tokens(excerpt))
            if not score:
                continue
            digest = hashlib.sha256(f"codelab\0{identity}\0{version}\0{offset}".encode()).hexdigest()
            record = {"service": "codelab", "source_id": identity, "version": version,
                      "title": source.get("title", identity), "content": excerpt,
                      "chunk_id": digest, "start_offset": offset, "end_offset": offset + len(excerpt),
                      "retrieval_method": "lexical.v1", "score": score}
            ranked.append(record)
    ranked.sort(key=lambda row: (-row["score"], row["source_id"], row["version"], row["start_offset"]))
    selected, seen = [], set()
    for row in ranked:
        if row["source_id"] in seen:
            continue
        selected.append(row)
        seen.add(row["source_id"])
        if len(selected) == limit:
            break
    return selected


def reciprocal_rank_fusion(rankings: list[list[str]], *, limit: int = 8) -> list[str]:
    """Fuse supplied authorized rankings; callers own candidate eligibility checks."""
    if not 1 <= limit <= 8 or len(rankings) > 4 or any(len(r) > 1000 for r in rankings):
        raise ValueError("Ranking input exceeds bounds")
    scores: dict[str, float] = {}
    for ranking in rankings:
        seen = set()
        for rank, identity in enumerate(ranking, 1):
            if not isinstance(identity, str) or not identity:
                raise ValueError("Invalid ranked identity")
            if identity not in seen:
                scores[identity] = scores.get(identity, 0) + 1 / (60 + rank)
                seen.add(identity)
    return sorted(scores, key=lambda identity: (-scores[identity], identity))[:limit]
