create schema if not exists codelab;

create table codelab.learning_tracks (
    id bigint generated always as identity primary key,
    title text not null,
    slug text not null unique,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint learning_tracks_title_not_blank_check check (btrim(title) <> ''),
    constraint learning_tracks_slug_not_blank_check check (btrim(slug) <> '')
);

create table codelab.learning_chapters (
    id bigint generated always as identity primary key,
    track_id bigint not null references codelab.learning_tracks(id) on delete cascade,
    title text not null,
    slug text not null,
    hub_path text not null unique,
    sort_order integer not null default 0,
    state text not null default 'active'
        constraint learning_chapters_state_check
        check (state in ('active', 'needs_setup', 'archived')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (track_id, slug),
    constraint learning_chapters_title_not_blank_check check (btrim(title) <> ''),
    constraint learning_chapters_slug_not_blank_check check (btrim(slug) <> '')
);

create table codelab.learning_resources (
    id bigint generated always as identity primary key,
    title text not null,
    resource_kind text not null
        constraint learning_resources_kind_check
        check (resource_kind in ('markdown', 'notebook', 'python', 'go', 'practice', 'review')),
    resource_path text not null unique,
    content_hash text,
    metadata jsonb not null default '{}'::jsonb,
    catalog_state text not null default 'current'
        constraint learning_resources_state_check
        check (catalog_state in ('current', 'needs_review', 'missing', 'archived')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint learning_resources_title_not_blank_check check (btrim(title) <> ''),
    constraint learning_resources_path_not_blank_check check (btrim(resource_path) <> '')
);

create table codelab.learning_resource_relations (
    chapter_id bigint not null references codelab.learning_chapters(id) on delete cascade,
    resource_id bigint not null references codelab.learning_resources(id) on delete cascade,
    role text not null
        constraint learning_chapter_resources_role_check
        check (role in ('hub', 'concept', 'experiment', 'formal_solution', 'practice', 'review')),
    sort_order integer not null default 0,
    primary key (chapter_id, resource_id),
    unique (chapter_id, role, sort_order)
);

create table codelab.learning_chapter_progress (
    chapter_id bigint primary key references codelab.learning_chapters(id) on delete cascade,
    state text not null default 'not_started'
        constraint chapter_progress_state_check
        check (state in ('not_started', 'in_progress', 'review', 'completed')),
    current_resource_id bigint references codelab.learning_resources(id) on delete set null,
    note text,
    last_reviewed_at timestamptz,
    updated_at timestamptz not null default now()
);

create index learning_chapters_track_idx
    on codelab.learning_chapters(track_id, sort_order, id);

create index learning_resource_relations_resource_idx
    on codelab.learning_resource_relations(resource_id);
