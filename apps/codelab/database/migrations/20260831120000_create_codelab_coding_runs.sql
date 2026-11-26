create table codelab.coding_runs (
    id bigint generated always as identity primary key,
    problem_index integer not null
        constraint coding_runs_problem_index_check check (problem_index > 0),
    problem_slug text not null,
    source text not null,
    stdin text not null,
    succeeded boolean not null,
    result jsonb not null,
    idempotency_key text not null unique,
    created_at timestamptz not null default now()
);

create index coding_runs_problem_created_idx
    on codelab.coding_runs(problem_slug, created_at desc);
