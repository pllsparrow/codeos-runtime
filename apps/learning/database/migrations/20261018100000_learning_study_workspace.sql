-- Store study position and explicit associations without rewriting learning history.
create table learning.lesson_study_state (
    lesson_id text primary key references learning.path_lessons(id),
    stage text not null check (stage in ('read','experiment','solve','reflect')),
    reading_revision text,
    updated_at timestamptz not null default clock_timestamp()
);
create table learning.lesson_note_links (
    lesson_id text not null references learning.path_lessons(id),
    note_id bigint not null references learning.notes(id),
    updated_at timestamptz not null default clock_timestamp(),
    primary key(lesson_id, note_id)
);
grant select, insert, update on learning.lesson_study_state to codelab_app;
grant select, insert, delete on learning.lesson_note_links to codelab_app;
