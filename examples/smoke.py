"""Exercise the loopback Runner with original synthetic Python and Go fixtures."""

import json
import os
import uuid
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener


def main():
    token = os.environ.get("CODELAB_JUDGE_TOKEN")
    if not token:
        raise SystemExit("Export CODELAB_JUDGE_TOKEN before running this example.")

    port = int(os.environ.get("CODEOS_RUNTIME_PORT", "18033"))
    origin = f"http://127.0.0.1:{port}/internal/judge"
    client = build_opener(ProxyHandler({}))

    def request(path, payload=None, authenticated=True):
        headers = {"Authorization": f"Bearer {token}"} if authenticated else {}
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            headers["Idempotency-Key"] = uuid.uuid4().hex
            body = json.dumps(payload).encode()
        with client.open(Request(origin + path, data=body, headers=headers), timeout=55) as reply:
            return json.load(reply)

    if request("/ready", authenticated=False)["status"] != "ready":
        raise SystemExit("Runner is not ready.")

    python_run = {"source": "print(6 * 7)", "stdin": "", "language_profile": "python-3.12"}
    try:
        request("/runs", python_run, authenticated=False)
    except HTTPError as error:
        if error.code != 401:
            raise
    else:
        raise SystemExit("The unauthenticated request unexpectedly succeeded.")
    print("Unauthenticated execution rejected (HTTP 401)")

    result = request("/runs", python_run)["result"]
    if not result["ok"] or result["stdout"] != "42\n":
        raise SystemExit("Python execution returned an unexpected result.")
    print("Python Run returned 42")

    submission = {
        "problem_index": 1,
        "problem_slug": "codeos-runtime-example",
        "language_profile": "go-1.26",
        "source": 'package main\nimport "fmt"\nfunc main(){var n int;fmt.Scan(&n);fmt.Println(n*2)}',
        "cases": [{"stdin": "21\n", "stdout": "42\n"}, {"stdin": "-2\n", "stdout": "-4\n"}],
    }
    result = request("/submissions", submission)
    if result["verdict"] != "accepted" or result["passed"] != 2:
        raise SystemExit("Go submission did not pass both cases.")
    print("Go Submit accepted 2/2 cases")

    submission["cases"][1]["stdout"] = "-5\n"
    result = request("/submissions", submission)
    if result["verdict"] != "failed" or result["passed"] != 1:
        raise SystemExit("Go submission did not report the expected failed case.")
    print("Go Submit reported the expected failed case")


if __name__ == "__main__":
    main()
