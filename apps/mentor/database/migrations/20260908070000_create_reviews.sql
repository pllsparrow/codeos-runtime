-- Preserve reviewed inputs and results independently of ordinary chat messages.
alter table mentor.mentor_messages add constraint mentor_messages_session_id_id_key unique (session_id, id);

create table mentor.mentor_reviews (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references mentor.mentor_sessions(id) on delete restrict,
    cutoff_message_id uuid not null,
    client_review_id uuid not null,
    snapshot jsonb not null,
    snapshot_hash text not null check (length(snapshot_hash) = 64),
    schema_version text not null check (schema_version = 'review.v1'),
    prompt_version text not null,
    model text not null check (btrim(model) <> ''),
    mode text not null check (mode in ('prompt_json', 'strict_schema')),
    status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
    result jsonb,
    error_code text,
    created_at timestamptz not null default now(),
    deadline timestamptz not null default now() + interval '60 seconds',
    finished_at timestamptz,
    unique (session_id, client_review_id),
    foreign key (session_id, cutoff_message_id) references mentor.mentor_messages(session_id, id) on delete restrict,
    check ((status = 'completed') = (result is not null)),
    check ((status = 'running') = (finished_at is null)),
    check (status <> 'completed' or error_code is null)
);

create index mentor_reviews_session_page_idx on mentor.mentor_reviews(session_id, created_at desc, id desc);
create index mentor_reviews_active_deadline_idx on mentor.mentor_reviews(deadline) where status = 'running';

create table mentor.mentor_review_attempts (
    id uuid primary key default gen_random_uuid(),
    review_id uuid not null references mentor.mentor_reviews(id) on delete restrict,
    attempt_no integer not null check (attempt_no between 1 and 2),
    duration_ms double precision not null check (duration_ms >= 0 and duration_ms < 'Infinity'::float8),
    error_code text,
    model text,
    mode text,
    input_tokens bigint check (input_tokens >= 0),
    output_tokens bigint check (output_tokens >= 0),
    unique (review_id, attempt_no)
);
