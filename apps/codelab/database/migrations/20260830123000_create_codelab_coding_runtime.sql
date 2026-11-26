create table codelab.coding_progress (
    problem_slug text primary key,
    status text not null default 'todo'
        constraint coding_progress_status_check
        check (status in ('todo', 'attempted', 'failed', 'accepted')),
    attempts integer not null default 0
        constraint coding_progress_attempts_check
        check (attempts >= 0),
    accepted integer not null default 0
        constraint coding_progress_accepted_check
        check (accepted >= 0 and accepted <= attempts),
    note text not null default '',
    updated_at timestamptz not null default now()
);

create table codelab.coding_drafts (
    problem_index integer primary key
        constraint coding_drafts_problem_index_check
        check (problem_index > 0),
    source text not null,
    updated_at timestamptz not null default now()
);

create table codelab.coding_submissions (
    id bigint generated always as identity primary key,
    problem_index integer
        constraint coding_submissions_problem_index_check
        check (problem_index is null or problem_index > 0),
    problem_slug text not null,
    status text not null
        constraint coding_submissions_status_check
        check (status in ('accepted', 'failed')),
    source text not null,
    idempotency_key text,
    legacy_submission_id integer,
    created_at timestamptz not null default now(),
    unique (idempotency_key),
    unique (legacy_submission_id)
);

create table codelab.coding_submission_results (
    submission_id bigint primary key references codelab.coding_submissions(id) on delete cascade,
    verdict text not null
        constraint coding_submission_results_verdict_check
        check (verdict in ('accepted', 'failed')),
    passed integer not null default 0
        constraint coding_submission_results_passed_check
        check (passed >= 0),
    total integer not null default 0
        constraint coding_submission_results_total_check
        check (total >= 0 and passed <= total),
    first_failure jsonb,
    result jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index coding_submissions_problem_created_idx
    on codelab.coding_submissions(problem_slug, created_at desc);
