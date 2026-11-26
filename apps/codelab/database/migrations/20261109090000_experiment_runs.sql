create table codelab.experiment_runs (
    request_key text primary key,
    operation text not null,
    experiment_path text not null,
    source_version timestamptz not null,
    snapshot jsonb not null,
    owner_token uuid not null,
    status text not null check (status in ('running', 'completed', 'failed')),
    response jsonb,
    error_code text,
    started_at timestamptz not null default clock_timestamp(),
    deadline timestamptz not null default clock_timestamp() + interval '90 seconds',
    finished_at timestamptz,
    check ((status = 'completed') = (response is not null)),
    check ((status = 'running') = (finished_at is null))
);

create index experiment_runs_pending_idx on codelab.experiment_runs(deadline)
    where status = 'running';

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'codelab_app') then
        grant select, insert, update on codelab.experiment_runs to codelab_app;
    end if;
end $$;
