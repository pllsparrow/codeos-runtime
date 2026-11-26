-- Explicit reviewed company records; published bodies and Note identities remain unchanged.
alter table learning.writing_documents drop constraint writing_documents_kind_check;
alter table learning.writing_documents add constraint writing_documents_kind_check check (kind in ('notes','knowledge','courses','reference','reviews'));
alter table learning.writing_drafts drop constraint writing_drafts_kind_check;
alter table learning.writing_drafts add constraint writing_drafts_kind_check check (kind in ('notes','knowledge','courses','reviews'));
alter table learning.writing_drafts add column review_company text not null default '';
alter table learning.writing_drafts add column review_provenance text not null default 'unknown' check (review_provenance in ('owner','external','mixed','unknown'));
create table learning.writing_reviews (
    note_id bigint primary key references learning.notes(id),
    company text not null check (btrim(company) <> ''),
    provenance text not null check (provenance in ('owner','external','mixed','unknown'))
);
grant select,insert,update,delete on learning.writing_reviews to codelab_app;
insert into learning.writing_reviews(note_id,company,provenance)
select seed.id,seed.company,seed.provenance from (values
(166,'恒达智控','owner'),(232,'未注明公司','unknown'),(225,'信也科技','unknown'),(224,'360','unknown'),
(156,'小红书','unknown'),(157,'滴滴','unknown'),(158,'多益网络','unknown'),(159,'多益网络','unknown'),
(160,'乐元素','unknown'),(161,'拼多多','unknown'),(163,'滴滴','unknown'),
(103,'CVTE（视源）','unknown'),(106,'恒生电子','unknown'),(107,'米哈游','unknown'),
(108,'拼多多','external'),(109,'去哪儿','external'),(110,'去哪儿','external'),(111,'去哪儿','external'),
(128,'蚂蚁集团','unknown'),(130,'CVTE（视源）','unknown'),(131,'CVTE（视源）','external'),
(132,'滴滴','unknown'),(134,'联想','external'),(136,'拼多多','unknown'),(137,'启云方','unknown'),
(138,'小红书','unknown'),(139,'用友','unknown')
) as seed(id,company,provenance) join learning.notes n on n.id=seed.id;
update learning.writing_documents d set kind='reviews',collection_id=null
from learning.writing_reviews r where r.note_id=d.note_id;
-- Carry any current review drafts into the same explicit role without replacing working text.
update learning.writing_drafts d set kind='reviews',collection_id=null,review_company=r.company,review_provenance=r.provenance,version=version+1,updated_at=clock_timestamp()
from learning.writing_reviews r where r.note_id=d.note_id;
