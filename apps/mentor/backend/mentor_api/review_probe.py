"""Run a synthetic review probe; default operation is offline and credential-free."""
from __future__ import annotations

import argparse
import asyncio
import json
from dataclasses import asdict

from .config import model_key, model_name, model_url
from .review_generation import generate_review
from .review_provider import ReviewHTTPProvider


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Explicitly permit at most two synthetic provider calls")
    parser.add_argument("--mode", choices=("prompt_json", "strict_schema"), default="strict_schema")
    args = parser.parse_args(argv)
    plan = {"mode": args.mode, "max_calls": 2, "max_output_tokens_per_call": 2048,
            "deadline_seconds": 60, "input": "fixed synthetic FIFO example", "live": args.live}
    if not args.live:
        print(json.dumps(plan))
        return 0
    url, key = model_url(), model_key()
    if not url or not key:
        print(json.dumps({"status": "unavailable", "error_code": "provider_not_configured"}))
        return 2
    try:
        adapter = ReviewHTTPProvider(url, key, model_name(), [{"role": "user", "content":
            "Synthetic conversation: learner asks what FIFO means; teacher explains that A enters "
            "before B and leaves before B. No evidence IDs are supplied; use no observations."}], args.mode)
    except ValueError:
        print(json.dumps({"status": "unavailable", "error_code": "invalid_configuration"}))
        return 2
    result = asyncio.run(generate_review(adapter, set()))
    print(json.dumps({"status": result.status, "error_code": result.error_code,
                      "attempt_count": len(result.attempts), "duration_ms": result.duration_ms,
                      "input_tokens": result.token_total("input_tokens"),
                      "output_tokens": result.token_total("output_tokens"),
                      "attempts": [asdict(attempt) for attempt in result.attempts]}))
    return 0 if result.status == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
