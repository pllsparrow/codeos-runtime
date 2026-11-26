"""Learning-owned course references and immutable checkpoints; Practice is read through HTTP."""
from __future__ import annotations

import hashlib
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import urlopen

from .notes import NotesError, NotesService, record


class PracticeReader:
    def read(self, path):
        origin = os.environ.get('LEARNING_PRACTICE_API_ORIGIN', 'http://127.0.0.1:8001/api/codelab').rstrip('/')
        try:
            with urlopen(origin + path, timeout=5) as response:
                return json.load(response)
        except HTTPError as error:
            raise NotesError(404 if error.code == 404 else 503, 'Practice resource missing' if error.code == 404 else 'Practice evidence unavailable') from error
        except (URLError, TimeoutError, ValueError):
            raise NotesError(503, 'Practice evidence unavailable') from None


class LearningPaths:
    def __init__(self, database, practice=None):
        self.db = database
        self.notes = NotesService(database)
        self.practice = practice or PracticeReader()

    def catalog(self):
        with self.db.connection() as connection:
            paths = [dict(row) for row in connection.execute("""select p.* from learning.learning_paths p where not exists (
                select 1 from learning.writing_collections c where c.published->>'path_id'=p.id and c.published->>'archived'='true') order by p.id""").fetchall()]
            for path in paths:
                path['lessons'] = [dict(row) for row in connection.execute("select l.id,l.title,l.objective,coalesce(to_jsonb(l)->>'stage','') as stage,(select count(*) from learning.lesson_checkpoints c where c.lesson_id=l.id) as checkpoint_count from learning.path_lessons l where path_id=%s order by position", (path['id'],)).fetchall()]
            return paths

    def lesson(self, identity):
        with self.db.connection() as connection:
            row = connection.execute("select l.*, p.revision, p.title as path_title, coalesce(to_jsonb(p)->>'subject','algorithms') as subject from learning.path_lessons l join learning.learning_paths p on p.id=l.path_id where l.id=%s", (identity,)).fetchone()
            if not row:
                raise NotesError(404, 'Learning lesson not found')
            resources = connection.execute('select * from learning.lesson_resources where lesson_id=%s order by kind', (identity,)).fetchall()
            checkpoints = connection.execute('select * from learning.lesson_checkpoints where lesson_id=%s order by id desc limit 20', (identity,)).fetchall()
        return {**record(row), 'resources': [record(r) for r in resources], 'checkpoints': [record(r) for r in checkpoints], 'return_href': f'/learning/paths/{row["path_id"]}/lessons/{identity}'}

    def view(self, identity):
        lesson = self.lesson(identity)
        evidence = {}
        try:
            note = self.notes.get(lesson['reading_note_id']) if lesson['reading_note_id'] else None
            evidence['reading'] = {'status': 'available' if note and not note['deleted_at'] else 'missing', 'reference': lesson['reading_note_id'], 'revision': note['updated_at'] if note else None}
        except NotesError as error:
            evidence['reading'] = {'status': 'unavailable' if error.status == 503 else 'missing'}
        for resource in lesson['resources']:
            kind = resource['kind']
            try:
                evidence[kind] = self.validate(kind, resource['reference'])
                if kind == 'notebook' and evidence[kind]['revision'] != resource['revision']:
                    evidence[kind]['status'] = 'changed'
            except NotesError as error:
                evidence[kind] = {'status': 'missing' if error.status == 404 else 'unavailable', 'message': str(error)}
        return {**lesson, 'evidence': evidence}

    def validate(self, kind, reference):
        if kind == 'notebook':
            if not re.fullmatch(r'workspace/[^\x00-\x1f/\\]+\.ipynb', reference) or '..' in reference:
                raise NotesError(422, 'Choose a saved workspace Notebook path')
            result = self.practice.read('/lab/workspaces/' + quote(reference, safe='/'))
            if not result or result.get('resource_path') != reference:
                raise NotesError(404, 'Notebook missing or renamed; repair the link')
            notebook = result.get('notebook') or result.get('notebook_json') or {}
            return {'status': 'available', 'reference': reference, 'revision': result['updated_at'], 'has_execution': any(cell.get('execution') for cell in notebook.get('cells', [])), 'stale_execution': any(cell.get('execution') and cell['execution'].get('source') != cell.get('source') for cell in notebook.get('cells', []))}
        index, separator, slug = reference.partition(':')
        if not separator or not index.isdigit() or not slug:
            raise NotesError(422, 'OJ reference must include index and slug')
        result = self.practice.read('/coding/problems/' + index)
        if result.get('slug') != slug:
            raise NotesError(404, 'OJ catalog identity changed')
        return {'status': 'available', 'reference': reference, 'revision': 'catalog-v1'}

    def bind(self, identity, reference, expected, key):
        def action(connection):
            self.lesson(identity)
            verified = self.validate('notebook', reference)
            connection.execute('select pg_advisory_xact_lock(hashtext(%s))', ('learning.notebook:' + reference,))
            old = connection.execute("select * from learning.lesson_resources where lesson_id=%s and kind='notebook'", (identity,)).fetchone()
            if (not old or old['reference'] != reference) and not re.fullmatch(r'workspace/(?:course--)?' + re.escape(identity) + r'-[a-z0-9-]+\.ipynb', reference):
                raise NotesError(422, 'Create a separate experiment for this lesson; a free Notebook cannot be bound as course work')
            other = connection.execute("select lesson_id from learning.lesson_resources where kind='notebook' and reference=%s and lesson_id<>%s", (reference, identity)).fetchone()
            if other:
                raise NotesError(422, 'This experiment belongs to another lesson')
            if (record(old)['updated_at'] if old else None) != expected:
                raise NotesError(409, 'Notebook association changed; refresh before replacing it')
            row = connection.execute("insert into learning.lesson_resources(lesson_id,kind,reference,revision) values (%s,'notebook',%s,%s) on conflict(lesson_id,kind) do update set reference=excluded.reference, revision=excluded.revision, updated_at=clock_timestamp() returning *", (identity, reference, verified['revision'])).fetchone()
            return record(row)
        return self.notes._write(key, {'action': 'lesson.bind', 'id': identity, 'reference': reference, 'expected': expected}, action)

    def bind_reading(self, identity, note_id, expected, key):
        def action(connection):
            lesson = self.lesson(identity)
            if lesson['updated_at'] != expected:
                raise NotesError(409, 'Reading association changed; refresh before replacing it')
            note = self.notes.get(note_id)
            if note['deleted_at']:
                raise NotesError(409, 'Restore this Note before linking it')
            row = connection.execute('update learning.path_lessons set reading_note_id=%s, updated_at=clock_timestamp() where id=%s returning *', (note_id, identity)).fetchone()
            return record(row)
        return self.notes._write(key, {'action': 'lesson.reading', 'id': identity, 'note_id': note_id, 'expected': expected}, action)

    def checkpoint(self, identity, explanation, submission_id, expected_id, key, expected_revision=None, expected_reading_revision=None, expected_notebook_revision=None):
        def action(connection):
            if not explanation.strip():
                raise NotesError(422, 'Write your own explanation before confirming')
            lesson = self.lesson(identity)
            if not lesson['reading_note_id'] or self.notes.get(lesson['reading_note_id'])['deleted_at']:
                raise NotesError(409, 'Reading Note missing or trashed; restore it before confirming')
            if expected_revision is not None and expected_revision != lesson['revision']:
                raise NotesError(409, 'Curriculum changed; review the lesson before confirming')
            reading = self.notes.get(lesson['reading_note_id'])
            if expected_reading_revision is not None and expected_reading_revision != reading['updated_at']:
                raise NotesError(409, 'Reading changed; review it before confirming')
            latest = lesson['checkpoints'][0]['id'] if lesson['checkpoints'] else None
            if latest != expected_id:
                raise NotesError(409, 'A newer checkpoint exists; refresh. Your reflection is retained.')
            if submission_id and not any(resource['kind'] == 'oj' for resource in lesson['resources']):
                raise NotesError(422, 'No OJ problem is associated with this lesson')
            evidence = {'understanding': 'owner-confirmed', 'reading_reference': reading['id'], 'reading_revision': reading['updated_at'], 'notebook': None, 'submission': None}
            for resource in lesson['resources']:
                checked = self.validate(resource['kind'], resource['reference'])
                if resource['kind'] == 'notebook':
                    if checked['revision'] != (expected_notebook_revision or resource['revision']):
                        raise NotesError(409, 'Notebook changed; review and refresh its association before confirming')
                    evidence['notebook'] = checked
                elif submission_id:
                    submission = self.practice.read('/coding/submissions/' + str(submission_id))
                    if f"{submission['problem_index']}:{submission['problem_slug']}" != resource['reference']:
                        raise NotesError(422, 'Submission belongs to another problem')
                    evidence['submission'] = {k: submission[k] for k in ['id', 'verdict', 'passed', 'total', 'created_at']}
                    evidence['submission']['language'] = submission.get('language','python')
                    evidence['submission']['language_profile'] = submission.get('result',{}).get('language_profile')
                    evidence['submission']['source_sha256'] = hashlib.sha256(submission['source'].encode()).hexdigest()
            row = connection.execute('insert into learning.lesson_checkpoints(lesson_id,curriculum_revision,evidence,explanation) values (%s,%s,%s,%s) returning *', (identity, lesson['revision'], json.dumps(evidence), explanation)).fetchone()
            return record(row)
        payload = {'action': 'lesson.checkpoint', 'id': identity, 'explanation': explanation, 'submission_id': submission_id, 'expected': expected_id, 'expected_revision': expected_revision, 'expected_reading_revision': expected_reading_revision}
        # Preserve legacy retry hashes when the older client omitted the new optional guard.
        if expected_notebook_revision is not None:
            payload['expected_notebook_revision'] = expected_notebook_revision
        return self.notes._write(key, payload, action)
