"""Authenticated by the existing Codelab origin gate; no database access in the browser."""
from uuid import UUID
from fastapi import APIRouter, Header, HTTPException, Query
from psycopg import Error as DatabaseError
from .experiments import ExperimentInterrupted, ExperimentRun, ExperimentSave, ExperimentService
from .judge import JudgeUnavailable, JudgeContractError

router = APIRouter(prefix='/api/codelab/lab/experiments')


def service():
    from .server import _database, _judge
    return ExperimentService(_database(), _judge())


def key(value):
    from .server import _idempotency_key
    return _idempotency_key(value)


def translate(action):
    try:
        return action()
    except LookupError as error:
        raise HTTPException(404, str(error)) from error
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    except ExperimentInterrupted as error:
        raise HTTPException(410, str(error)) from error
    except JudgeContractError as error:
        raise HTTPException(502, str(error)) from error
    except (RuntimeError, DatabaseError, JudgeUnavailable) as error:
        raise HTTPException(503, 'Lab storage or execution is unavailable; your local work is retained') from error


@router.get('')
def catalog(q: str = Query(default="", max_length=200), page: int = Query(default=0, ge=0), limit: int = Query(default=25, ge=1, le=100)):
    from .server import _content_root
    return translate(lambda: service().catalog(_content_root(), q, page, limit))


@router.get('/{identity}')
def read_experiment(identity: UUID):
    def read():
        result = service().read(str(identity))
        if result is None: raise LookupError('Experiment not found')
        return result
    return translate(read)


@router.put('/{identity}')
def save_experiment(identity: UUID, payload: ExperimentSave, idempotency_key: str | None = Header(None, alias='Idempotency-Key')):
    request_key = key(idempotency_key)
    return translate(lambda: service().save(str(identity), payload, request_key))


@router.post('/{identity}/runs')
def run_experiment(identity: UUID, payload: ExperimentRun, idempotency_key: str | None = Header(None, alias='Idempotency-Key')):
    request_key = key(idempotency_key)
    return translate(lambda: service().run(str(identity), payload.expected_version, request_key))
