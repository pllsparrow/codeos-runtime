"""Independent Lab experiments, stored separately from Python/course notebooks."""
from __future__ import annotations

import ast
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
from time import monotonic, sleep
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .database import operation
from .judge import JudgeContractError, JudgeUnavailable
from .experiment_runs import ExperimentInterrupted, ExperimentRunStore

PREFIX = 'workspace/experiments/'
ExperimentType = Literal['go', 'sql', 'shell']


class ExperimentInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    type: ExperimentType
    title: str = Field(min_length=1, max_length=300)
    source: str = Field(max_length=128_000)
    stdin: str = Field(default='', max_length=32_000)
    setup: str = Field(default='', max_length=128_000)
    explanation: str = Field(default='', max_length=32_000)

    @field_validator('source', 'setup', 'stdin', 'explanation')
    @classmethod
    def bounded_utf8(cls, value, info):
        limit = 64_000 if info.field_name in ('source', 'setup') else 32_000
        if len(value.encode('utf-8')) > limit:
            raise ValueError('Experiment field exceeds its UTF-8 byte limit')
        return value

    @field_validator('title')
    @classmethod
    def title_required(cls, value):
        if not value.strip():
            raise ValueError('Enter an experiment title')
        return value.strip()

    @model_validator(mode='after')
    def size_and_type(self):
        if len(self.model_dump_json().encode()) > 400_000:
            raise ValueError('Experiment is too large')
        if self.type != 'sql' and self.setup:
            raise ValueError('Setup SQL belongs to SQL experiments only')
        return self


class ExperimentSave(ExperimentInput):
    expected_version: datetime | Literal['new']

    @field_validator('expected_version')
    @classmethod
    def timezone_required(cls, value):
        if isinstance(value, datetime) and value.tzinfo is None:
            raise ValueError('expected_version must include a timezone')
        return value


class ExperimentRun(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_version: datetime

    @field_validator('expected_version')
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError('expected_version must include a timezone')
        return value


def experiment_path(identity: str) -> str:
    return f'{PREFIX}{UUID(identity)}.ipynb'


def public_record(row):
    body = row['notebook']
    if body.get('kind') != 'experiment':
        raise ValueError('This record is not a Lab experiment')
    return {**body, 'id': Path(row['resource_path']).stem, 'updated_at': row['updated_at']}


def sql_fixture(content_root: Path) -> str:
    """Read the reviewed course fixture as data; never execute curriculum Python in the API."""
    lessons = json.loads((content_root / '02_engineering/sql_learning/curriculum.json').read_text())
    tree = ast.parse(lessons[0]['experiment_setup'])
    for statement in tree.body:
        if (isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call)
                and isinstance(statement.value.func, ast.Attribute)
                and statement.value.func.attr == 'executescript'):
            return ast.literal_eval(statement.value.args[0])
    raise RuntimeError('SQL course fixture is unavailable')


def sql_program(source: str, setup: str) -> str:
    payload = base64.b64encode(json.dumps({'source': source, 'setup': setup}, ensure_ascii=False).encode()).decode()
    return '''import base64,json,sqlite3
p=json.loads(base64.b64decode("''' + payload + '''"))
c=sqlite3.connect(':memory:')
c.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 32000)
c.setlimit(sqlite3.SQLITE_LIMIT_SQL_LENGTH, 256000)
c.setlimit(sqlite3.SQLITE_LIMIT_COLUMN, 100)
def authorize(action,a,b,db,trigger):
    if action in (sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH,sqlite3.SQLITE_PRAGMA): return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_FUNCTION and (b or '').lower() == 'load_extension': return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK
c.set_authorizer(authorize)
def statements(text):
    current=''
    for char in text:
        current+=char
        if char == ';' and sqlite3.complete_statement(current):
            yield current
            current=''
    if current.strip(): yield current
try:
    for statement in statements(p['setup']): c.execute(statement)
    tables=[]
    for statement in statements(p['source']):
        cursor=c.execute(statement)
        if cursor.description:
            rows=cursor.fetchmany(201)
            tables.append({'columns':[d[0] for d in cursor.description],'rows':rows[:200],'truncated':len(rows)>200})
            if len(tables)>10: raise ValueError('At most 10 result tables per run')
    print(json.dumps({'tables':tables},ensure_ascii=False,default=lambda value: value.hex() if isinstance(value,bytes) else str(value)))
finally:
    c.close()
'''


class ExperimentService:
    def __init__(self, database, judge):
        self.database, self.judge = database, judge

    def catalog(self, content_root, q, page, limit):
        match = '%' + q.strip() + '%'
        where = "path like 'workspace/experiments/%%' and deleted_at is null and (title ilike %s or notebook_json->>'type' ilike %s)"
        with self.database.connection() as connection:
            total = connection.execute('select count(*) as total from codelab.notebooks where ' + where, (match, match)).fetchone()['total']
            actual_page = min(page, max(0, (total - 1) // limit))
            rows = connection.execute("select path as resource_path,jsonb_build_object('kind','experiment','title',title,'type',notebook_json->>'type') as notebook,updated_at from codelab.notebooks where " + where + " order by updated_at desc,path limit %s offset %s", (match, match, limit, actual_page * limit)).fetchall()
        items = [{k: v for k, v in public_record({**row, 'updated_at': row['updated_at'].isoformat()}).items() if k in ('id', 'title', 'type', 'updated_at')} for row in rows]
        return {'items': items, 'total': total, 'page': actual_page, 'page_count': max(1, (total + limit - 1) // limit), 'sql_setup': sql_fixture(content_root)}

    def read(self, identity):
        row = self.database.workspace(experiment_path(identity))
        return public_record(row) if row else None

    def save(self, identity, payload: ExperimentSave, key):
        path = experiment_path(identity)
        data = payload.model_dump(mode='json', exclude={'expected_version'})
        intent = operation('lab.experiment', {'id': identity, **payload.model_dump(mode='json')})
        # Match a completed retry before checking the now-advanced version.
        with self.database.connection() as connection:
            cached = self.database._cached_response(connection, key, intent)
        if cached is not None:
            return public_record(cached)
        existing = self.database.workspace(path)
        if existing and existing['notebook'].get('type') != payload.type:
            raise ValueError('Experiment type cannot change; create another experiment')
        result = self.database.save_workspace(
            resource_path=path, title=payload.title,
            notebook={'kind': 'experiment', 'version': 1, **data, 'result': existing['notebook'].get('result') if existing else None},
            idempotency_key=key, create_only=payload.expected_version == 'new',
            expected_version=None if payload.expected_version == 'new' else payload.expected_version,
            intent=intent,
        )
        return public_record(result)

    def run(self, identity, expected_version: datetime, key):
        version = expected_version.astimezone(timezone.utc).isoformat(timespec='microseconds')
        intent = operation('lab.experiment.run', {'id': identity, 'expected_version': version})
        store = ExperimentRunStore(self.database)
        wait_until = monotonic() + 65
        while True:
            run, owned = store.claim(experiment_path(identity), expected_version, key, intent)
            if run['status'] == 'completed':
                return run['response']
            if run['status'] == 'failed':
                raise ExperimentInterrupted('Previous execution was interrupted. Run again to create a new request.')
            if owned:
                break
            if monotonic() >= wait_until:
                raise JudgeUnavailable('Experiment is still running; retry the same request')
            sleep(.1)
        snapshot = run['snapshot']
        kind, source = snapshot['type'], snapshot['source']
        if kind == 'sql': source = sql_program(source, snapshot['setup'])
        elif kind == 'shell':
            source = 'import os\nos.execv("/bin/bash",["bash","--noprofile","--norc","-c",' + repr(source) + '])'
        try:
            # Waiting for execution owns no database connection or transaction.
            result = self.judge.run(source=source, stdin=snapshot['stdin'], request_id=key, language='go' if kind == 'go' else 'python')
            if kind == 'sql' and result['ok']:
                try:
                    result['tables'] = json.loads(result['stdout'])['tables']
                    result['stdout'] = ''
                except (ValueError, KeyError, TypeError) as error:
                    raise JudgeContractError('SQL output exceeded the result limit or was invalid') from error
            snapshot_result = {'snapshot': snapshot, 'output': result, 'finished_at': datetime.now().astimezone().isoformat()}
            response = {'id': identity, 'result': snapshot_result}
            return store.complete(run, response)
        except BaseException:
            store.fail(run)
            raise
