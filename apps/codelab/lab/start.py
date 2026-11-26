from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Start the local Codelab Notebook runtime")
    parser.add_argument("--port", type=int, default=8888)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path(__file__).resolve().parent / "workspace",
    )
    parser.add_argument("--origin", default="http://127.0.0.1:8002")
    parser.add_argument("--origin-pattern", default="")
    parser.add_argument("--base-url", default="/jupyter/")
    parser.add_argument("--idle-timeout", type=int, default=600)
    parser.add_argument("--execution-timeout", type=int, choices=range(1, 61), default=60)
    parser.add_argument("--kernel-name", default="codelab-python")
    return parser.parse_args(argv)


def register_kernel(kernel_name: str) -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "ipykernel",
            "install",
            "--user",
            "--name",
            kernel_name,
            "--display-name",
            f"Codelab Python ({kernel_name})",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown error"
        raise RuntimeError(f"Unable to register the Codelab kernel: {detail}")


def main() -> None:
    args = parse_args()
    workspace = args.workspace.expanduser().resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    register_kernel(args.kernel_name)

    from jupyter_server.serverapp import ServerApp

    ServerApp.launch_instance(argv=server_arguments(args, workspace))


def server_arguments(args: argparse.Namespace, workspace: Path) -> list[str]:
    return [
        f"--ServerApp.ip={args.host}",
        f"--ServerApp.port={args.port}",
        "--ServerApp.open_browser=False",
        "--ServerApp.terminals_enabled=False",
        "--ServerApp.kernel_manager_class=kernel_policy.ExecutionKernelManager",
        f"--ExecutionKernelManager.execution_timeout={args.execution_timeout}",
        f"--MappingKernelManager.cull_idle_timeout={args.idle_timeout}",
        "--MappingKernelManager.cull_interval=30",
        "--MappingKernelManager.cull_connected=True",
        "--MappingKernelManager.cull_busy=False",
        f"--ServerApp.allow_remote_access={'True' if args.host != '127.0.0.1' else 'False'}",
        f"--ServerApp.allow_origin={args.origin if not args.origin_pattern else ''}",
        f"--ServerApp.allow_origin_pat={args.origin_pattern or re.escape(args.origin)}",
        f"--ServerApp.base_url={args.base_url}",
        "--ServerApp.disable_check_xsrf=True",
        "--IdentityProvider.token=",
        f"--ServerApp.root_dir={workspace}",
    ]


if __name__ == "__main__":
    main()
