-- Submission reviews belong to Learning; Practice remains the submission authority.
create table mentor.mentor_submission_reviews (
    id uuid primary key default gen_random_uuid(),
    submission_id bigint not null check (submission_id > 0),
    client_review_id uuid not null unique,
    snapshot jsonb not null,
    snapshot_hash text not null check (length(snapshot_hash) = 64),
    model text not null,
    status text not null default 'running' check (status in ('running','completed','failed','cancelled')),
    result jsonb,
    attempts jsonb not null default '[]'::jsonb,
    error_code text,
    created_at timestamptz not null default now(),
    deadline timestamptz not null default now() + interval '60 seconds',
    finished_at timestamptz,
    check ((status = 'completed') = (result is not null)),
    check ((status = 'running') = (finished_at is null)),
    check (status <> 'completed' or error_code is null)
);
create index mentor_submission_reviews_history_idx
    on mentor.mentor_submission_reviews(submission_id, created_at desc, id desc);

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'mentor_app') then
        grant select, insert, update on mentor.mentor_submission_reviews to mentor_app;
    end if;
end $$;
