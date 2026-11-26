-- Additive one-lesson Learning integration. Existing Notes/Practice facts remain unchanged.
create table learning.learning_paths (
    id text primary key, title text not null, objective text not null,
    revision integer not null default 1 check (revision > 0)
);
create table learning.path_lessons (
    id text primary key, path_id text not null references learning.learning_paths(id),
    title text not null, objective text not null, position integer not null,
    reading_note_id bigint references learning.notes(id), updated_at timestamptz not null default clock_timestamp(), unique(path_id, position)
);
create table learning.lesson_resources (
    lesson_id text not null references learning.path_lessons(id),
    kind text not null check (kind in ('notebook','oj')),
    reference text not null, revision text not null,
    updated_at timestamptz not null default clock_timestamp(), primary key(lesson_id,kind)
);
create table learning.lesson_checkpoints (
    id bigserial primary key, lesson_id text not null references learning.path_lessons(id),
    curriculum_revision integer not null, evidence jsonb not null, explanation text not null,
    created_at timestamptz not null default clock_timestamp()
);
create function learning.reject_checkpoint_mutation() returns trigger language plpgsql as $$
begin raise exception 'Learning checkpoints are append-only'; end $$;
create trigger learning_checkpoint_immutable before update or delete on learning.lesson_checkpoints
    for each row execute function learning.reject_checkpoint_mutation();
grant select on learning.learning_paths, learning.path_lessons to codelab_app;
grant update(reading_note_id, updated_at) on learning.path_lessons to codelab_app;
grant select, insert, update on learning.lesson_resources to codelab_app;
grant select, insert on learning.lesson_checkpoints to codelab_app;
grant usage, select on sequence learning.lesson_checkpoints_id_seq to codelab_app;
insert into learning.learning_paths values ('grid-search','Grid Search — DFS / BFS','Read, experiment, solve and explain a four-direction grid component.',1);
insert into learning.path_lessons(id,path_id,title,objective,position,reading_note_id)
values ('grid-components','grid-search','Grid components','Explain neighbors and visited; compare DFS/BFS; solve ACM component counting.',0,
    (select id from learning.notes where title='Grid Search — DFS and BFS Learning Path' and deleted_at is null));
insert into learning.lesson_resources values ('grid-components','oj','154:grid-component-count','catalog-v1',clock_timestamp());
