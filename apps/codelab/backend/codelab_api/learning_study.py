"""Learning-owned position, explicit personal-note links and inspectable coverage."""
from .learning_paths import LearningPaths
from .notes import NotesError, record


def experiment_covered(notebook):
    cells = [cell for cell in notebook.get('cells', []) if cell.get('cell_type') == 'code' and cell.get('source', '').strip()]
    return bool(cells) and all((cell.get('execution') or {}).get('status') == 'success'
                               and (cell.get('execution') or {}).get('source') == cell['source'] for cell in cells)


class LearningStudy(LearningPaths):
    def get_position(self, identity):
        self.lesson(identity)
        with self.db.connection() as connection:
            row = connection.execute('select * from learning.lesson_study_state where lesson_id=%s', (identity,)).fetchone()
            return record(row) if row else {'lesson_id': identity, 'stage': 'read', 'reading_revision': None}

    def position(self, identity, stage, reading_revision, key):
        def action(connection):
            lesson = self.lesson(identity)
            if reading_revision is not None:
                note = self.notes.get(lesson['reading_note_id']) if lesson['reading_note_id'] else None
                if not note or note['deleted_at'] or note['updated_at'] != reading_revision:
                    raise NotesError(409, 'Reading changed; reopen it before confirming coverage')
            row = connection.execute('''insert into learning.lesson_study_state(lesson_id,stage,reading_revision)
                values (%s,%s,%s) on conflict(lesson_id) do update set stage=excluded.stage,
                reading_revision=coalesce(excluded.reading_revision,learning.lesson_study_state.reading_revision),
                updated_at=clock_timestamp() returning *''', (identity, stage, reading_revision)).fetchone()
            return record(row)
        return self.notes._write(key, {'action': 'study.position', 'id': identity, 'stage': stage, 'reading_revision': reading_revision}, action)

    def links(self, identity):
        self.lesson(identity)
        with self.db.connection() as connection:
            return [record(row) for row in connection.execute('''select a.note_id,a.updated_at,n.title,n.path,n.deleted_at
                from learning.lesson_note_links a join learning.notes n on n.id=a.note_id
                where lesson_id=%s order by a.updated_at desc,n.id''', (identity,)).fetchall()]

    def link(self, identity, note_id, remove, expected, key):
        def action(connection):
            lesson = self.lesson(identity)
            note = self.notes.get(note_id)
            if not remove and (note['deleted_at'] or note_id == lesson['reading_note_id']):
                raise NotesError(422, 'Choose an active personal Note separate from this lesson reading')
            old = connection.execute('select * from learning.lesson_note_links where lesson_id=%s and note_id=%s for update', (identity, note_id)).fetchone()
            if remove:
                if not old or record(old)['updated_at'] != expected:
                    raise NotesError(409, 'Note association changed; refresh before removing it')
                connection.execute('delete from learning.lesson_note_links where lesson_id=%s and note_id=%s', (identity, note_id))
                return {'note_id': note_id, 'removed': True}
            if old:
                return record(old)
            return record(connection.execute('insert into learning.lesson_note_links(lesson_id,note_id) values (%s,%s) returning *', (identity, note_id)).fetchone())
        return self.notes._write(key, {'action': 'study.note', 'id': identity, 'note_id': note_id, 'remove': remove, 'expected': expected}, action)

    def note_context(self, note_id):
        with self.db.connection() as connection:
            return [record(row) for row in connection.execute('''select l.id,l.title,p.title as path_title,p.id as path_id
                from learning.lesson_note_links a join learning.path_lessons l on l.id=a.lesson_id
                join learning.learning_paths p on p.id=l.path_id where a.note_id=%s order by p.id,l.position''', (note_id,)).fetchall()]

    def experiment_context(self, reference):
        with self.db.connection() as connection:
            return [record(row) for row in connection.execute("""select l.id,l.title,l.path_id from learning.lesson_resources r
                join learning.path_lessons l on l.id=r.lesson_id where r.kind='notebook' and r.reference=%s""", (reference,)).fetchall()]

    def experiment_references(self, identity=None):
        with self.db.connection() as connection:
            if identity:
                self.lesson(identity)
                return [row['reference'] for row in connection.execute("select reference from learning.lesson_resources where kind='notebook' and lesson_id=%s", (identity,)).fetchall()]
            return [row['reference'] for row in connection.execute("select reference from learning.lesson_resources where kind='notebook'").fetchall()]

    def summary(self):
        with self.db.connection() as connection:
            lessons = [dict(row) for row in connection.execute('''select l.*, coalesce(to_jsonb(p)->>'subject','algorithms') as subject, n.updated_at as reading_updated_at,n.deleted_at,
                s.reading_revision,s.stage as last_stage,s.updated_at as studied_at
                from learning.path_lessons l join learning.learning_paths p on p.id=l.path_id left join learning.notes n on n.id=l.reading_note_id
                left join learning.lesson_study_state s on s.lesson_id=l.id order by l.path_id,l.position''').fetchall()]
            resources = [dict(row) for row in connection.execute('select * from learning.lesson_resources').fetchall()]
        notebooks, problems = {}, {}
        notebook_error = problem_error = False
        if any(r['kind'] == 'notebook' for r in resources):
            try:
                notebooks = {row['resource_path']: row for row in self.practice.read('/lab/workspaces')}
            except (NotesError, TypeError, KeyError):
                notebook_error = True
        if any(r['kind'] == 'oj' for r in resources):
            try:
                problems = {str(row['index']) + ':' + row['slug']: row for row in self.practice.read('/coding/problems')}
            except (NotesError, TypeError, KeyError):
                problem_error = True
        result = {}
        for lesson in lessons:
            identity = lesson['id']
            path = result.setdefault(lesson['path_id'], {'items': [], 'lessons': {}, 'resume': None})
            linked = {r['kind']: r['reference'] for r in resources if r['lesson_id'] == identity}
            read = bool(lesson['reading_updated_at'] and not lesson['deleted_at'] and lesson['reading_revision'] == lesson['reading_updated_at'].isoformat())
            items = [{'kind': 'reading', 'key': identity, 'title': lesson['title'], 'covered': read, 'status': 'current' if read else 'unread' if lesson['reading_updated_at'] and not lesson['deleted_at'] else 'missing'}]
            if lesson['subject'] in ('algorithms', 'sql') or lesson.get('experiment_plan') or 'notebook' in linked:
                saved = notebooks.get(linked.get('notebook'))
                items.append({'kind': 'experiment', 'key': identity, 'title': lesson['title'], 'covered': experiment_covered(saved.get('notebook', {})) if saved else False, 'status': 'unavailable' if notebook_error and 'notebook' in linked else 'saved' if saved else 'missing' if 'notebook' in linked else 'not created'})
            if 'oj' in linked or lesson['subject'] == 'algorithms':
                reference = linked.get('oj', 'missing:' + identity)
                problem = problems.get(reference)
                items.append({'kind': 'problem', 'key': reference, 'title': problem.get('title', lesson['title']) if problem else lesson['title'], 'covered': bool(problem and problem.get('progress') == 'accepted'), 'status': 'unavailable' if problem_error else problem.get('progress', 'todo') if problem else 'missing'})
            path['lessons'][identity] = {'items': items, 'stage': lesson['last_stage'] or 'read'}
            for item in items:
                if not any(old['kind'] == item['kind'] and old['key'] == item['key'] for old in path['items']):
                    path['items'].append(item)
            if lesson['studied_at'] and (not path['resume'] or lesson['studied_at'].isoformat() > path['resume']['updated_at']):
                path['resume'] = {'lesson_id': identity, 'title': lesson['title'], 'stage': lesson['last_stage'], 'updated_at': lesson['studied_at'].isoformat()}
        for path in result.values():
            path['total'] = len(path['items'])
            path['covered'] = sum(bool(item['covered']) for item in path['items'])
            path['unknown'] = sum(item['status'] == 'unavailable' for item in path['items'])
            path['percent'] = round(path['covered'] * 100 / path['total']) if path['total'] and not path['unknown'] else None
        return result
