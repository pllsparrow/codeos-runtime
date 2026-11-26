alter table mentor.mentor_messages add column source_refs jsonb not null default '[]'::jsonb;
alter table mentor.mentor_messages add column run_id uuid references mentor.mentor_model_runs(id) on delete restrict;

create table mentor.mentor_retrievals (
    id uuid primary key default gen_random_uuid(),
    message_id uuid not null references mentor.mentor_messages(id) on delete restrict,
    sources jsonb not null,
    created_at timestamptz not null default now()
);

create index mentor_retrievals_message_idx on mentor.mentor_retrievals(message_id, created_at);
