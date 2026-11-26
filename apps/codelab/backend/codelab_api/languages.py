"""Canonical language intent shared by transport and durable execution receipts."""
from __future__ import annotations

import hashlib
import json
from typing import Any

PROFILES = {"python": "python-3.12", "go": "go-1.26"}


def operation(kind: str, payload: dict[str, Any]) -> str:
    normalized = {**payload, "language": payload.get("language", "python")}
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return kind + ":" + hashlib.sha256(encoded).hexdigest()
