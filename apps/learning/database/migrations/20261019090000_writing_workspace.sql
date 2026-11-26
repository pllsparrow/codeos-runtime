-- Independent authoring state. Existing published Notes remain unchanged.
create table learning.writing_collections (
    id text primary key,
    kind text not null check (kind in ('knowledge', 'courses')),
    slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
    draft jsonb,
    published jsonb,
    version integer not null default 1 check (version > 0),
    updated_at timestamptz not null default clock_timestamp(),
    unique (kind, slug),
    check (draft is not null or published is not null)
);
create table learning.writing_documents (
    note_id bigint primary key references learning.notes(id),
    kind text not null check (kind in ('notes','knowledge','courses','reference')),
    collection_id text references learning.writing_collections(id)
);
create table learning.writing_drafts (
    id uuid primary key,
    note_id bigint unique references learning.notes(id),
    kind text not null check (kind in ('notes','knowledge','courses')),
    collection_id text references learning.writing_collections(id),
    title text not null check (btrim(title) <> ''),
    content text not null default '',
    folder text not null default '',
    base_note_version timestamptz,
    version integer not null default 1 check (version > 0),
    updated_at timestamptz not null default clock_timestamp(),
    check ((note_id is null) = (base_note_version is null))
);
grant select, insert, update, delete on learning.writing_collections,
    learning.writing_documents, learning.writing_drafts to codelab_app;
