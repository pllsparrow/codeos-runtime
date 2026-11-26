-- Authoring projection for existing practice courses; no learner history or bodies change.
grant insert on learning.learning_paths, learning.path_lessons to codelab_app;
grant update(title, objective, revision, subject, overview_note_id) on learning.learning_paths to codelab_app;
grant update(title, objective, position, stage, experiment_plan, experiment_setup) on learning.path_lessons to codelab_app;
insert into learning.writing_collections(id,kind,slug,published)
select 'courses:practice-'||id,'courses','practice-'||id,
    jsonb_build_object('path_id',id,'title',title,'description',objective,
      'track',case when subject='sql' then 'backend' else 'python' end,
      'practice',case when subject='sql' then 'Jupy / SQL' else 'Jupy / OJ' end,
      'entries','[]'::jsonb)
from learning.learning_paths;
insert into learning.writing_documents(note_id,kind,collection_id)
select distinct on (note_id) note_id,'courses','courses:practice-'||path_id
from (
  select reading_note_id as note_id,path_id from learning.path_lessons where reading_note_id is not null
  union all
  select overview_note_id,id from learning.learning_paths where overview_note_id is not null
) refs
order by note_id,path_id
on conflict(note_id) do update set kind='courses',collection_id=excluded.collection_id
where learning.writing_documents.kind='reference';
