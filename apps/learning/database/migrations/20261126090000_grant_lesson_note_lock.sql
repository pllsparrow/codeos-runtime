-- Linking and unlinking Notes lock the existing association with SELECT FOR UPDATE.
grant update (updated_at) on learning.lesson_note_links to codelab_app;
