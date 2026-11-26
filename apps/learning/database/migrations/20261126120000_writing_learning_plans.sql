alter table learning.writing_documents drop constraint writing_documents_kind_check;
alter table learning.writing_documents add constraint writing_documents_kind_check
    check (kind in ('notes', 'plans', 'knowledge', 'courses', 'reference', 'reviews'));

alter table learning.writing_drafts drop constraint writing_drafts_kind_check;
alter table learning.writing_drafts add constraint writing_drafts_kind_check
    check (kind in ('notes', 'plans', 'knowledge', 'courses', 'reviews'));
