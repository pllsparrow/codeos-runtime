-- Additive Notes workspace metadata. Existing learning.notes rows are unchanged.
create table learning.note_folders (
    path text primary key,
    updated_at timestamptz not null default clock_timestamp(),
    constraint note_folder_not_blank check (btrim(path) <> '')
);

create table learning.note_requests (
    key text primary key,
    request_hash text not null,
    response jsonb not null,
    created_at timestamptz not null default now()
);

grant select, insert, update on learning.note_folders, learning.note_requests to codelab_app;
