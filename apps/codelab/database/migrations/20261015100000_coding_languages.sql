-- Preserve every existing Python draft and immutable execution record.
alter table codelab.coding_drafts add column language text not null default 'python' check (language in ('python','go'));
alter table codelab.coding_drafts drop constraint coding_drafts_pkey;
alter table codelab.coding_drafts add primary key (problem_index,language);
alter table codelab.coding_submissions add column language text not null default 'python' check (language in ('python','go'));
alter table codelab.coding_runs add column language text not null default 'python' check (language in ('python','go'));
