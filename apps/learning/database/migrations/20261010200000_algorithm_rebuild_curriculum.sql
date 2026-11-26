-- Add reviewed curriculum only; no learner work or historical checkpoint is rewritten.
insert into learning.learning_paths(id,title,objective,revision)
values ('algorithm-rebuild','360 Review — Prefix Counts to Graphs','Rebuild prefix counting, prefix frequency, undirected and directed graph models through reading, experiments and ACM programs.',1);
insert into learning.path_lessons(id,path_id,title,objective,position,reading_note_id)
values
('prefix-counts','algorithm-rebuild','Prefix counts and road cuts','Explain indicator counts, half-open prefixes and all road cuts; distinguish confirmed facts from a chosen training contract.',0,
(select id from learning.notes where title='360 Review — Prefix Counts and Road Cuts' and deleted_at is null)),
('prefix-frequency','algorithm-rebuild','Prefix sums and historical frequency','Explain repeated prefix sums, query-before-register and non-empty target-sum subarrays.',1,
(select id from learning.notes where title='360 Review — Prefix Sum Frequency' and deleted_at is null)),
('undirected-graphs','algorithm-rebuild','Undirected graphs and components','Build two-way adjacency, filter weights and distinguish connectivity, cycles and non-backtracking passing.',2,
(select id from learning.notes where title='360 Review — Undirected Graphs' and deleted_at is null)),
('directed-graphs','algorithm-rebuild','Directed graphs and dependencies','Explain directed adjacency, indegree, topological order and incomplete processing caused by cycles.',3,
(select id from learning.notes where title='360 Review — Directed Graphs' and deleted_at is null));
insert into learning.lesson_resources(lesson_id,kind,reference,revision)
values ('prefix-counts','oj','190:static-range-sum-queries','catalog-v1'),
('prefix-frequency','oj','192:count-subarrays-with-target-sum','catalog-v1'),
('undirected-graphs','oj','90:number-of-connected-components-in-an-undirected-graph','catalog-v1'),
('directed-graphs','oj','207:dependency-build-order','catalog-v1');
