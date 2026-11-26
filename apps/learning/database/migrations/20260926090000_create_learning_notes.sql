create schema if not exists learning;

create table learning.notes (
    id bigserial primary key,
    path text not null unique,
    title text not null,
    content text not null default '',
    source_path text,
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint learning_notes_path_not_blank check (btrim(path) <> ''),
    constraint learning_notes_title_not_blank check (btrim(title) <> '')
);

create index learning_notes_updated_idx on learning.notes(updated_at desc) where deleted_at is null;
create index learning_notes_source_idx on learning.notes(source_path) where source_path is not null;
