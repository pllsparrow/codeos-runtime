create schema if not exists mentor;
create extension if not exists pgcrypto;

create table mentor.mentor_sessions (
    id uuid primary key default gen_random_uuid(),
    context_mode text not null check (context_mode in ('auto', 'none', 'selected')),
    archived boolean not null default false,
    created_at timestamptz not null default now()
);

create table mentor.mentor_messages (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references mentor.mentor_sessions(id) on delete restrict,
    role text not null check (role in ('user', 'assistant')),
    content text not null check (btrim(content) <> ''),
    client_message_id text,
    created_at timestamptz not null default now(),
    unique (session_id, client_message_id)
);

create table mentor.mentor_model_runs (
    id uuid primary key default gen_random_uuid(),
    message_id uuid not null references mentor.mentor_messages(id) on delete restrict,
    attempt_no integer not null check (attempt_no > 0),
    status text not null check (status in ('queued', 'running', 'completed', 'failed')),
    provider_profile text not null default 'codex-relay',
    relay text,
    model text not null,
    prompt_version text not null default 'mentor-v1',
    skill_version text not null default 'mentor-v1',
    partial_output text not null default '',
    error text,
    started_at timestamptz,
    completed_at timestamptz,
    latency_ms integer check (latency_ms is null or latency_ms >= 0),
    input_tokens integer check (input_tokens is null or input_tokens >= 0),
    output_tokens integer check (output_tokens is null or output_tokens >= 0),
    created_at timestamptz not null default now(),
    unique (message_id, attempt_no)
);

create index mentor_messages_session_idx on mentor.mentor_messages(session_id, created_at);
create index mentor_model_runs_message_idx on mentor.mentor_model_runs(message_id, attempt_no desc);
