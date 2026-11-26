-- The same-origin Notes API currently runs with the Codelab service role; keep this grant
-- explicit until a dedicated Learning API role is introduced.
grant usage on schema learning to codelab_app;
grant select, insert, update on learning.notes to codelab_app;
grant usage, select on sequence learning.notes_id_seq to codelab_app;
