create table mentor.mentor_refresh_jobs (
    id uuid primary key default gen_random_uuid(),
    idempotency_key text not null unique,
    status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
    error text,
    created_at timestamptz not null default now(),
    started_at timestamptz,
    finished_at timestamptz
);
