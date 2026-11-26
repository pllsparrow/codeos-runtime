#!/usr/bin/env python3
"""Generate credentials for a fresh loopback learning installation."""

import getpass
import os
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app.platform_core.passwords import hash_password

KEYS = (
    "LEARNING_DATABASE_PASSWORD",
    "LEARNING_CODELAB_PASSWORD",
    "LEARNING_MENTOR_PASSWORD",
    "LEARNING_JUDGE_TOKEN",
    "LEARNING_REVIEW_TOKEN",
)


def main():
    path = Path(__file__).with_name("install.env")
    if path.exists():
        raise SystemExit(f"{path.name} already exists. Existing credentials were kept.")
    email = input("Owner email: ").strip()
    if not email or any(char.isspace() or char in "'\"#${}=" for char in email) or "@" not in email:
        raise SystemExit("Provide a valid owner email address.")
    password = getpass.getpass("Owner password (12+ characters): ")
    confirmation = getpass.getpass("Repeat password: ")
    if len(password) < 12 or password != confirmation:
        raise SystemExit("Use a matching password of at least 12 characters.")

    values = {
        "CODEOS_OWNER_EMAIL": email,
        "CODEOS_OWNER_PASSWORD_HASH": hash_password(password),
        **{key: secrets.token_hex(32) for key in KEYS},
    }
    with open(path, "x", opener=lambda filename, flags: os.open(filename, flags, 0o600)) as handle:
        handle.writelines(f"{key}='{value}'\n" for key, value in values.items())
    print("Created install.env. Run deploy/learning-release/learning up.")


if __name__ == "__main__":
    main()
