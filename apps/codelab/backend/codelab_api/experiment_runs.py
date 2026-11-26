"""Short transactions for durable experiment ownership and versioned completion."""
from uuid import uuid4

from psycopg.types.json import Json

from .judge import JudgeUnavailable


class ExperimentInterrupted(RuntimeError):
    """An expired owner cannot be safely regenerated under the same request key."""


class ExperimentRunStore:
    def __init__(self, database):
        self.database = database

    def claim(self, path, version, key, intent):
        with self.database.connection() as db:
            db.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (key,))
            cached = self.database._cached_response(db, key, intent)
            if cached is not None:
                return {'status': 'completed', 'response': cached}, False
            db.execute("update codelab.experiment_runs set status='failed',error_code='interrupted',finished_at=clock_timestamp() "
                       "where request_key=%s and status='running' and deadline<=clock_timestamp()", (key,))
            run = db.execute('select * from codelab.experiment_runs where request_key=%s for update', (key,)).fetchone()
            if run is not None:
                if run['operation'] != intent:
                    raise ValueError('Idempotency key was already used for another experiment version')
                if run['status'] != 'failed' or run['error_code'] == 'interrupted':
                    return run, False
            row = db.execute('select notebook_json,updated_at from codelab.notebooks '
                             'where path=%s and deleted_at is null', (path,)).fetchone()
            if row is None:
                raise LookupError('Experiment not found')
            if row['updated_at'] != version:
                raise ValueError('This experiment changed in another page. Your local code is retained; reopen the saved experiment before running.')
            snapshot = {field: row['notebook_json'][field] for field in ('type', 'source', 'stdin', 'setup')}
            claimed = db.execute(
                "insert into codelab.experiment_runs(request_key,operation,experiment_path,source_version,snapshot,owner_token,status) "
                "values (%s,%s,%s,%s,%s,%s,'running') on conflict(request_key) do update set "
                "owner_token=excluded.owner_token,status='running',response=null,error_code=null,"
                "started_at=clock_timestamp(),deadline=clock_timestamp()+interval '90 seconds',finished_at=null "
                "returning *", (key, intent, path, version, Json(snapshot), uuid4())).fetchone()
            return claimed, True

    def complete(self, run, response):
        key = run['request_key']
        with self.database.connection() as db:
            db.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (key,))
            current = db.execute('select *,deadline>clock_timestamp() as valid from codelab.experiment_runs '
                                 'where request_key=%s for update', (key,)).fetchone()
            if (current is None or current['status'] != 'running' or not current['valid']
                    or current['owner_token'] != run['owner_token']):
                raise JudgeUnavailable('Experiment execution no longer owns this result')
            db.execute("update codelab.notebooks set notebook_json=jsonb_set(notebook_json,'{result}',%s::jsonb) "
                       "where path=%s and updated_at=%s and deleted_at is null",
                       (Json(response['result']), run['experiment_path'], run['source_version']))
            self.database._store_response(db, key, run['operation'], response)
            db.execute("update codelab.experiment_runs set status='completed',response=%s,"
                       "finished_at=clock_timestamp() where request_key=%s", (Json(response), key))
        return response

    def fail(self, run):
        with self.database.connection() as db:
            db.execute("update codelab.experiment_runs set status='failed',"
                       "error_code=case when deadline<=clock_timestamp() then 'interrupted' else 'execution_failed' end,"
                       "finished_at=clock_timestamp() where request_key=%s and owner_token=%s and status='running'",
                       (run['request_key'], run['owner_token']))
