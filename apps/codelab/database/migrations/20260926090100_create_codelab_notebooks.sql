create schema if not exists codelab;

create table codelab.notebooks (
    id bigserial primary key,
    path text not null unique,
    title text not null,
    notebook_json jsonb not null,
    source_path text,
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint codelab_notebooks_path_not_blank check (btrim(path) <> ''),
    constraint codelab_notebooks_title_not_blank check (btrim(title) <> '')
);

create index codelab_notebooks_updated_idx on codelab.notebooks(updated_at desc) where deleted_at is null;
create index codelab_notebooks_source_idx on codelab.notebooks(source_path) where source_path is not null;

-- Preserve existing Web-created workspace notebooks while moving the runtime to the
-- canonical Notebook table. The old table remains available for rollback/audit only.
insert into codelab.notebooks(path, title, notebook_json, created_at, updated_at)
select resource_path, title, notebook_json, created_at, updated_at
from codelab.lab_workspaces
on conflict (path) do nothing;
