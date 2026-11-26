"""Initialize an independent learning database with the owning migration histories."""

import os
from pathlib import Path

import psycopg
from psycopg import sql
from psycopg.rows import dict_row

from tools.migrate_unified_database import MIGRATION_GROUPS, _drop_empty_legacy_schemas, apply_group

ROLES = {
    "codelab_app": "LEARNING_CODELAB_PASSWORD",
    "mentor_app": "LEARNING_MENTOR_PASSWORD",
}


def verify_installation(connection):
    if connection.info.dbname != "codeos_learning":
        raise RuntimeError("The learning initializer requires the codeos_learning database")
    connection.execute("select pg_advisory_xact_lock(195948557)")
    connection.execute(
        """create table if not exists public.codeos_learning_installation (
        singleton boolean primary key check (singleton), seed_applied boolean not null default false, created_at timestamptz not null default now())"""
    )
    if not connection.execute("select singleton from public.codeos_learning_installation").fetchone():
        existing = connection.execute(
            "select nspname from pg_namespace where nspname in ('practice', 'learning', 'career')"
        ).fetchone()
        if existing:
            raise RuntimeError("This is not an empty or initialized learning database")
        connection.execute("insert into public.codeos_learning_installation(singleton) values (true)")


def configure_database(connection):
    for role, variable in ROLES.items():
        password = os.environ[variable]
        if not password:
            raise RuntimeError(f"{variable} is required")
        if not connection.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone():
            connection.execute(
                sql.SQL("create role {} login password {}").format(sql.Identifier(role), sql.Literal(password))
            )

    for group in MIGRATION_GROUPS:
        if group[1] in {"practice_schema_migrations", "notes_schema_migrations", "mentor_schema_migrations"}:
            if not any(group[2].glob("*.sql")):
                raise RuntimeError(f"No migrations found for {group[1]}")
            apply_group(connection, *group)

    _drop_empty_legacy_schemas(connection)
    connection.execute("grant usage on schema practice to codelab_app")
    connection.execute("grant select, insert, update, delete on all tables in schema practice to codelab_app")
    connection.execute("revoke all on practice.practice_schema_migrations from codelab_app")
    connection.execute("grant usage, select on all sequences in schema practice to codelab_app")
    connection.execute("grant usage on schema learning to mentor_app")
    for entry in connection.execute(
        """select tablename from pg_tables where schemaname = 'learning'
        and tablename like 'mentor\\_%' and tablename != 'mentor_schema_migrations'"""
    ):
        connection.execute(
            sql.SQL("grant select, insert, update, delete on learning.{} to mentor_app").format(
                sql.Identifier(entry["tablename"])
            )
        )
    for entry in connection.execute(
        "select sequencename from pg_sequences where schemaname = 'learning' and sequencename like 'mentor\\_%'"
    ):
        connection.execute(
            sql.SQL("grant usage, select on sequence learning.{} to mentor_app").format(
                sql.Identifier(entry["sequencename"])
            )
        )


def seed_course(connection):
    lesson = Path(__file__).parent / "sample" / "shared-lists.md"
    note = connection.execute(
        """insert into learning.notes(path, title, content, source_path)
        values ('examples/shared-lists.md', 'Shared nested lists', %s, 'examples/shared-lists.md')
        on conflict (path) do nothing returning id""",
        (lesson.read_text(encoding="utf-8"),),
    ).fetchone()
    connection.execute(
        """insert into learning.learning_paths(id,title,objective)
        values ('python-experiments','Python Experiments','Use Python execution to investigate shared objects.')
        on conflict (id) do nothing"""
    )
    if note:
        connection.execute(
            """insert into learning.path_lessons(id,path_id,title,objective,position,reading_note_id,experiment_setup)
            values ('shared-nested-lists','python-experiments','Shared nested lists',
            'Compare a nested-list mutation with replacement.',0,%s,%s) on conflict (id) do nothing""",
            (note["id"], "original = [[1], [2]]\ncopy = original.copy()\ncopy[0].append(99)\nprint(original)"),
        )


def main():
    with psycopg.connect(os.environ["LEARNING_SETUP_DSN"], row_factory=dict_row) as connection:
        verify_installation(connection)
        configure_database(connection)
        if not connection.execute("select seed_applied from public.codeos_learning_installation").fetchone()["seed_applied"]:
            seed_course(connection)
            connection.execute("update public.codeos_learning_installation set seed_applied = true")
    print("Learning database is ready.")


if __name__ == "__main__":
    main()
