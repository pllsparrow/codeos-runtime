#!/usr/bin/env python3
"""Apply the three product schema histories to one PostgreSQL database.

The source migration files keep their product-local identifiers for compatibility. This runner
rewrites only schema-qualified identifiers at execution time and records the original file
checksum in a schema-specific history table. Use it only in an explicit, backed-up database
maintenance workflow; it never runs implicitly at API startup or ordinary Compose startup.
"""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

import psycopg
from psycopg.rows import dict_row


ROOT = Path(__file__).resolve().parents[1]
LEGACY_RECRUITING_SCHEMA = "save" + "job"
MIGRATION_GROUPS = (
    ("career", "career_schema_migrations", ROOT / "database/migrations", LEGACY_RECRUITING_SCHEMA, "rename_recruiting_schema_to_codeos"),
    # Jobmail keeps its migration source with its capability while sharing Career storage.
    ("career", "jobmail_schema_migrations", ROOT / "apps/jobmail/database/migrations", "mail", None),
    ("practice", "practice_schema_migrations", ROOT / "apps/codelab/database/migrations", "codelab", None),
    ("learning", "prep_schema_migrations", ROOT / "apps/prep/database/migrations", "prep", None),
    ("learning", "mentor_schema_migrations", ROOT / "apps/mentor/database/migrations", "mentor", None),
    ("learning", "notes_schema_migrations", ROOT / "apps/learning/database/migrations", None, None),
)
LEGACY_SCHEMAS = (LEGACY_RECRUITING_SCHEMA, "codeos", "codelab", "prep", "mentor")


def _rewrite(sql: str, source: str, target: str) -> str:
    if source is None:
        return sql
    rewritten = re.sub(
        rf"(?i)create\s+schema\s+if\s+not\s+exists\s+{source}\b",
        f"create schema if not exists {target}",
        sql,
    )
    rewritten = re.sub(
        rf"(?i)create\s+schema\s+{source}\b",
        f"create schema if not exists {target}",
        rewritten,
    )
    rewritten = rewritten.replace(f"{source}.", f"{target}.")
    if source == LEGACY_RECRUITING_SCHEMA:
        rewritten = rewritten.replace("codeos.", "career.")
    if source == "prep":
        rewritten = rewritten.replace(f"{target}.schema_migrations", f"{target}.prep_schema_migrations")
    return rewritten


def _drop_empty_legacy_schemas(connection: psycopg.Connection) -> None:
    """Remove only empty source namespaces left by the compatibility replay."""
    for schema in LEGACY_SCHEMAS:
        row = connection.execute(
            """
            select count(*) as relation_count
            from pg_class
            where relnamespace = (select oid from pg_namespace where nspname = %s)
            """,
            (schema,),
        ).fetchone()
        if row and row["relation_count"] == 0:
            connection.execute(f"drop schema if exists {schema}")


def _history_sql(schema: str, history_table: str) -> str:
    return f"""
        create schema if not exists {schema};
        create table if not exists {schema}.{history_table} (
            version text primary key,
            filename text not null unique,
            checksum text not null,
            applied_at timestamptz not null default now()
        )
    """


def apply_group(connection: psycopg.Connection, schema: str, history_table: str,
                directory: Path, source: str, skipped_identifier: str | None) -> None:
    connection.execute(_history_sql(schema, history_table))
    existing = {
        row["filename"]: row["checksum"]
        for row in connection.execute(
            f"select filename, checksum from {schema}.{history_table}"
        ).fetchall()
    }
    for path in sorted(directory.glob("*.sql")):
        # The recruiting rename migration is for the standalone codeos schema. The unified
        # database creates career directly, so replaying that rename would be incorrect.
        if skipped_identifier and skipped_identifier in path.name:
            continue
        checksum = hashlib.sha256(path.read_bytes()).hexdigest()
        previous = existing.get(path.name)
        if previous is not None:
            if previous != checksum:
                raise RuntimeError(f"Applied migration was modified: {path.name}")
            continue
        connection.execute(_rewrite(path.read_text(encoding="utf-8"), source, schema))
        connection.execute(
            f"insert into {schema}.{history_table}(version, filename, checksum) values (%s, %s, %s)",
            (path.stem, path.name, checksum),
        )


def main() -> None:
    database_url = os.environ.get("UNIFIED_DATABASE_URL", "").strip()
    if not database_url:
        raise SystemExit("UNIFIED_DATABASE_URL is required")
    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        for schema, history_table, directory, source, skipped_identifier in MIGRATION_GROUPS:
            apply_group(connection, schema, history_table, directory, source, skipped_identifier)
        _drop_empty_legacy_schemas(connection)
    print("Unified database migrations are up to date: career, learning, practice")


if __name__ == "__main__":
    main()
