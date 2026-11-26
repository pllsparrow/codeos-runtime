"""Transport contracts for the Learning path workspace."""
from fastapi import APIRouter, Header, HTTPException, Query
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from psycopg import Error as DatabaseError
from .learning_study import LearningStudy
from .notes import NotesError

class Binding(BaseModel):
    model_config = ConfigDict(extra='forbid')
    reference: str = Field(min_length=1, max_length=500)
    expected_version: str | None = None

class ReadingBinding(BaseModel):
    model_config = ConfigDict(extra='forbid')
    note_id: int = Field(gt=0)
    expected_version: str = Field(min_length=1,max_length=80)

class Checkpoint(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: int = Field(gt=0)
    expected_reading_revision: str = Field(min_length=1,max_length=80)
    expected_notebook_revision: str | None = Field(default=None, min_length=1, max_length=80)
    explanation: str = Field(min_length=1, max_length=20000)
    submission_id: int | None = Field(default=None, gt=0)
    expected_id: int | None = Field(default=None, gt=0)


class StudyPosition(BaseModel):
    model_config = ConfigDict(extra='forbid')
    stage: Literal['read', 'experiment', 'solve', 'reflect']
    reading_revision: str | None = Field(default=None, min_length=1, max_length=80)

class PersonalNoteLink(BaseModel):
    model_config = ConfigDict(extra='forbid')
    note_id: int = Field(gt=0)
    remove: bool = False
    expected_version: str | None = Field(default=None, min_length=1, max_length=80)


def learning_paths_router(database):
    router = APIRouter(prefix='/api/codelab/learning/paths', tags=['Learning Paths'])
    def call(action):
        try:
            return action(LearningStudy(database()))
        except NotesError as error:
            raise HTTPException(error.status, str(error)) from error
        except (RuntimeError, DatabaseError):
            raise HTTPException(503, 'Learning Paths storage is unavailable or awaiting its approved migration') from None
    @router.get('')
    def catalog(): return call(lambda service: service.catalog())
    @router.get('/experiment-context')
    def experiment_context(reference: str = Query(min_length=1, max_length=500)):
        return call(lambda service: service.experiment_context(reference))
    @router.get('/study')
    def study(): return call(lambda service: service.summary())
    @router.get('/note-context/{note_id}')
    def note_context(note_id: int): return call(lambda service: service.note_context(note_id))
    @router.get('/lessons/{identity}/notes')
    def notes(identity: str): return call(lambda service: service.links(identity))
    @router.post('/lessons/{identity}/notes')
    def link_note(identity: str, payload: PersonalNoteLink, key: str = Header(alias='Idempotency-Key')):
        return call(lambda service: service.link(identity, payload.note_id, payload.remove, payload.expected_version, key))
    @router.get('/lessons/{identity}/position')
    def get_position(identity: str): return call(lambda service: service.get_position(identity))
    @router.post('/lessons/{identity}/position')
    def position(identity: str, payload: StudyPosition, key: str = Header(alias='Idempotency-Key')):
        return call(lambda service: service.position(identity, payload.stage, payload.reading_revision, key))
    @router.get('/lessons/{identity}')
    def lesson(identity: str): return call(lambda service: service.view(identity))
    @router.post('/lessons/{identity}/notebook')
    def bind(identity: str, payload: Binding, key: str = Header(alias='Idempotency-Key')):
        return call(lambda service: service.bind(identity, payload.reference, payload.expected_version, key))
    @router.post('/lessons/{identity}/reading')
    def bind_reading(identity: str, payload: ReadingBinding, key: str = Header(alias='Idempotency-Key')):
        return call(lambda service: service.bind_reading(identity, payload.note_id, payload.expected_version, key))
    @router.post('/lessons/{identity}/checkpoints')
    def checkpoint(identity: str, payload: Checkpoint, key: str = Header(alias='Idempotency-Key')):
        return call(lambda service: service.checkpoint(identity, payload.explanation, payload.submission_id, payload.expected_id, key, payload.expected_revision, payload.expected_reading_revision, payload.expected_notebook_revision))
    return router
