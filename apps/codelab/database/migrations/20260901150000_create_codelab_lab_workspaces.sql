create table codelab.lab_workspaces (
    id bigint generated always as identity primary key,
    resource_path text not null unique,
    title text not null,
    notebook_json jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint lab_workspaces_path_not_blank_check check (btrim(resource_path) <> ''),
    constraint lab_workspaces_title_not_blank_check check (btrim(title) <> '')
);

create index lab_workspaces_updated_idx
    on codelab.lab_workspaces(updated_at desc);
