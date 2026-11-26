#!/usr/bin/env python3
"""ACM judge: run a solution as an independent process and compare stdout.

All problems use the text protocol. Each test case carries a stdin payload and
an expected stdout payload. The judge normalises whitespace (collapsing runs of
whitespace into single spaces) so trailing newlines do not cause false
failures, then compares the result text for exact equality.
"""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.judge.validators import output_matches


def main() -> None:
    payload = json.load(sys.stdin)
    code = payload["code"]
    cases = payload["cases"]
    validator = payload.get("validator")
    only_case = payload.get("case")
    run_all = payload.get("run_all", False)
    debug = payload.get("debug", False)
    results = []
    for index, case in enumerate(cases, start=1):
        if only_case is not None and index != only_case:
            continue
        expected = case["stdout"]
        passed = False
        actual = "[no output]"
        stderr = ""
        returncode = None
        try:
            process = subprocess.run(
                [sys.executable, "-c", code],
                input=case["stdin"],
                text=True,
                capture_output=True,
                timeout=3,
            )
            actual = process.stdout
            stderr = process.stderr
            returncode = process.returncode
            if process.returncode != 0:
                actual = f"[process exited {process.returncode}]\n{process.stderr}"
            else:
                passed = output_matches(validator, case["stdin"], actual, expected)
        except subprocess.TimeoutExpired:
            actual = "[time limit exceeded]"
        results.append(
            {
                "case": index,
                "passed": passed,
                "input": {"stdin": case["stdin"]},
                "expected": expected,
                "actual": actual,
                "stderr": stderr if debug else "",
                "returncode": returncode,
            }
        )
        if not passed and not run_all:
            break
    print(
        json.dumps(
            {
                "ok": bool(results) and all(item["passed"] for item in results),
                "slug": payload.get("slug"),
                "mode": "acm",
                "selected_case": only_case,
                "results": results,
                "total_cases": len(cases),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
