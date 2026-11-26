alter table mentor.mentor_refresh_jobs add column source_refs jsonb not null default '[]'::jsonb;
alter table mentor.mentor_refresh_jobs add column attempt_count integer not null default 0 check (attempt_count >= 0);

create table mentor.mentor_sources (
    service text not null check (service in ('codelab', 'prep')),
    source_id text not null,
    version text not null,
    checksum text not null,
    title text not null default '',
    content jsonb not null,
    synced_at timestamptz not null default now(),
    primary key (service, source_id, version, checksum)
);
