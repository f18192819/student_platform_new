from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal

from pydantic import BaseModel, ConfigDict, Field

from .config import PROJECT_ROOT

LEARNING_STATE_ROOT = PROJECT_ROOT / '.runtime' / 'learning-state' / 'courses'
_SAFE_ID = re.compile(r'[^A-Za-z0-9._-]+')


def _now() -> str:
  return datetime.now(tz=timezone.utc).isoformat()


class LearningEvent(BaseModel):
  """Immutable evidence recorded after one submitted answer."""

  model_config = ConfigDict(extra='forbid')
  id: str = Field(default_factory=lambda: uuid.uuid4().hex)
  course_id: str
  lecture_document_id: str
  test_session_id: str
  question_id: str
  source_type: str
  source_document_id: str = ''
  knowledge_points: list[str] = Field(default_factory=list)
  difficulty: int = Field(ge=1, le=5)
  correct: bool
  score: float = Field(ge=0.0, le=1.0)
  response_time_ms: int = Field(default=0, ge=0)
  response_text: str = ''
  structured_responses: list[dict[str, Any]] = Field(default_factory=list)
  part_grading_results: list[dict[str, Any]] = Field(default_factory=list)
  assessment_spec_snapshot: dict[str, Any] = Field(default_factory=dict)
  grading_method: str
  grading_confidence: float = Field(default=1.0, ge=0.0, le=1.0)
  grading_feedback: str = ''
  revision: int = Field(default=1, ge=1)
  supersedes_event_id: str | None = None
  created_at: str = Field(default_factory=_now)


class AdaptiveTestSession(BaseModel):
  model_config = ConfigDict(extra='forbid')
  id: str = Field(default_factory=lambda: uuid.uuid4().hex)
  course_id: str
  lecture_document_id: str
  status: Literal['active', 'completed', 'cancelled'] = 'active'
  target_question_count: int = Field(ge=0, le=10)
  candidate_question_ids: list[str] = Field(default_factory=list)
  asked_question_ids: list[str] = Field(default_factory=list)
  current_question_id: str | None = None
  created_at: str = Field(default_factory=_now)
  updated_at: str = Field(default_factory=_now)
  completed_at: str | None = None


class ConceptMastery(BaseModel):
  model_config = ConfigDict(extra='forbid')
  knowledge_point: str
  mastery: float = Field(ge=0.0, le=1.0)
  confidence: float = Field(ge=0.0, le=1.0)
  evidence_count: int = Field(ge=0)
  weighted_evidence: float = Field(ge=0.0)
  correct_streak: int = Field(ge=0)


class QuestionReferenceAnswer(BaseModel):
  """Durable answer projection used when source material has no complete solution."""

  model_config = ConfigDict(extra='forbid')
  question_id: str
  source_document_id: str
  answer_text: str
  structured_answer: dict[str, Any] = Field(default_factory=dict)
  answer_source: Literal['ai_generated', 'user_corrected']
  model: str = ''
  confidence: float = Field(default=1.0, ge=0.0, le=1.0)
  needs_review: bool = False
  created_at: str = Field(default_factory=_now)
  updated_at: str = Field(default_factory=_now)


class AssessmentPreparationRecord(BaseModel):
  """Durable state for one question's background AssessmentSpec preparation."""

  model_config = ConfigDict(extra='forbid')
  course_id: str
  question_id: str
  source_document_id: str = ''
  source_fingerprint: str
  status: Literal['pending', 'processing', 'ready', 'failed', 'needs_review']
  attempt_count: int = Field(default=0, ge=0)
  last_error: str = ''
  created_at: str = Field(default_factory=_now)
  updated_at: str = Field(default_factory=_now)


def project_concept_mastery(
  events: list[LearningEvent],
  known_concepts: list[str] | None = None,
) -> list[ConceptMastery]:
  """Build a deterministic projection; LearningEvent rows remain untouched."""
  concept_events: dict[str, list[tuple[LearningEvent, float]]] = {}
  for concept in known_concepts or []:
    normalized = str(concept or '').strip()
    if normalized:
      concept_events.setdefault(normalized, [])

  for event in events:
    concepts = list(dict.fromkeys(
      str(value or '').strip() for value in event.knowledge_points if str(value or '').strip()
    ))
    if not concepts:
      continue
    coverage_weight = 1.0 / math.sqrt(len(concepts))
    difficulty_weight = 0.7 + (0.15 * event.difficulty)
    evidence_weight = coverage_weight * difficulty_weight * max(0.25, event.grading_confidence)
    for concept in concepts:
      concept_events.setdefault(concept, []).append((event, evidence_weight))

  projections: list[ConceptMastery] = []
  for concept, entries in concept_events.items():
    total_weight = sum(weight for _, weight in entries)
    if total_weight > 0:
      mastery = sum(event.score * weight for event, weight in entries) / total_weight
      confidence = 1.0 - math.exp(-total_weight / 2.5)
    else:
      # An uncovered concept is unknown rather than failed.
      mastery = 0.5
      confidence = 0.0

    streak = 0
    for event, _ in reversed(entries):
      if not event.correct:
        break
      streak += 1
    projections.append(ConceptMastery(
      knowledge_point=concept,
      mastery=round(mastery, 4),
      confidence=round(confidence, 4),
      evidence_count=len(entries),
      weighted_evidence=round(total_weight, 4),
      correct_streak=streak,
    ))

  projections.sort(key=lambda item: (item.mastery, -item.confidence, item.knowledge_point))
  return projections


def aggregate_mastery(concepts: list[ConceptMastery]) -> tuple[float, float]:
  if not concepts:
    return 0.0, 0.0
  weights = [0.3 + (0.7 * concept.confidence) for concept in concepts]
  overall = sum(concept.mastery * weight for concept, weight in zip(concepts, weights)) / sum(weights)
  confidence = sum(concept.confidence for concept in concepts) / len(concepts)
  return round(overall, 4), round(confidence, 4)


class LearningStateStore:
  """Course-partitioned SQLite storage for sessions and append-only evidence."""

  def __init__(self, root: Path = LEARNING_STATE_ROOT) -> None:
    self.root = root
    self._lock = threading.RLock()

  def create_session(self, session: AdaptiveTestSession) -> AdaptiveTestSession:
    with self._connect(session.course_id) as connection:
      connection.execute(
        '''
        INSERT INTO adaptive_test_sessions (
          id, course_id, lecture_document_id, status, target_question_count,
          candidate_question_ids, asked_question_ids, current_question_id,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ''',
        self._session_values(session),
      )
    return session

  def save_session(self, session: AdaptiveTestSession) -> AdaptiveTestSession:
    session.updated_at = _now()
    with self._connect(session.course_id) as connection:
      cursor = connection.execute(
        '''
        UPDATE adaptive_test_sessions SET
          status = ?, target_question_count = ?, candidate_question_ids = ?,
          asked_question_ids = ?, current_question_id = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND course_id = ?
        ''',
        (
          session.status,
          session.target_question_count,
          json.dumps(session.candidate_question_ids, ensure_ascii=False),
          json.dumps(session.asked_question_ids, ensure_ascii=False),
          session.current_question_id,
          session.updated_at,
          session.completed_at,
          session.id,
          session.course_id,
        ),
      )
      if cursor.rowcount != 1:
        raise KeyError(f'Adaptive test session not found: {session.id}')
    return session

  def get_session(self, course_id: str, session_id: str) -> AdaptiveTestSession | None:
    with self._connect(course_id) as connection:
      row = connection.execute(
        'SELECT * FROM adaptive_test_sessions WHERE id = ? AND course_id = ?',
        (session_id, course_id),
      ).fetchone()
    return self._row_to_session(row) if row else None

  def find_session(self, session_id: str) -> AdaptiveTestSession | None:
    for database in self._database_paths():
      with self._connect_path(database) as connection:
        row = connection.execute(
          'SELECT * FROM adaptive_test_sessions WHERE id = ?',
          (session_id,),
        ).fetchone()
      if row:
        return self._row_to_session(row)
    return None

  def find_active(self, course_id: str, lecture_document_id: str) -> AdaptiveTestSession | None:
    with self._connect(course_id) as connection:
      row = connection.execute(
        '''
        SELECT * FROM adaptive_test_sessions
        WHERE course_id = ? AND lecture_document_id = ? AND status = 'active'
        ORDER BY created_at DESC LIMIT 1
        ''',
        (course_id, lecture_document_id),
      ).fetchone()
    return self._row_to_session(row) if row else None

  def append_event(self, event: LearningEvent) -> LearningEvent:
    with self._connect(event.course_id) as connection:
      self._insert_event(connection, event)
    return event

  def get_assessment_spec(
    self,
    course_id: str,
    question_id: str,
    source_fingerprint: str,
  ) -> dict[str, Any] | None:
    with self._connect(course_id) as connection:
      row = connection.execute(
        '''
        SELECT spec_json FROM assessment_specs
        WHERE question_id = ? AND source_fingerprint = ?
        ''',
        (question_id, source_fingerprint),
      ).fetchone()
    if not row:
      return None
    try:
      payload = json.loads(row['spec_json'])
    except (TypeError, ValueError):
      return None
    return payload if isinstance(payload, dict) else None

  def get_latest_assessment_spec(
    self,
    course_id: str,
    question_id: str,
  ) -> dict[str, Any] | None:
    """Return the latest persisted spec for historical answer rendering."""
    with self._connect(course_id) as connection:
      row = connection.execute(
        'SELECT spec_json FROM assessment_specs WHERE question_id = ?',
        (question_id,),
      ).fetchone()
    if not row:
      return None
    try:
      payload = json.loads(row['spec_json'])
    except (TypeError, ValueError):
      return None
    return payload if isinstance(payload, dict) else None

  def save_assessment_spec(
    self,
    course_id: str,
    question_id: str,
    source_document_id: str,
    source_fingerprint: str,
    spec: dict[str, Any],
  ) -> None:
    timestamp = _now()
    with self._connect(course_id) as connection:
      connection.execute(
        '''
        INSERT INTO assessment_specs (
          question_id, source_document_id, source_fingerprint, spec_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(question_id) DO UPDATE SET
          source_document_id = excluded.source_document_id,
          source_fingerprint = excluded.source_fingerprint,
          spec_json = excluded.spec_json,
          updated_at = excluded.updated_at
        ''',
        (
          question_id,
          source_document_id,
          source_fingerprint,
          json.dumps(spec, ensure_ascii=False),
          timestamp,
          timestamp,
        ),
      )

  def delete_assessment_spec(self, course_id: str, question_id: str) -> None:
    with self._connect(course_id) as connection:
      connection.execute(
        'DELETE FROM assessment_specs WHERE question_id = ?',
        (question_id,),
      )

  def ensure_assessment_preparation(
    self,
    course_id: str,
    question_id: str,
    source_document_id: str,
    source_fingerprint: str,
  ) -> AssessmentPreparationRecord:
    """Create a pending task or invalidate stale state when its source changes."""
    timestamp = _now()
    with self._connect(course_id) as connection:
      row = connection.execute(
        'SELECT * FROM assessment_preparations WHERE question_id = ?',
        (question_id,),
      ).fetchone()
      if row is None:
        connection.execute(
          '''
          INSERT INTO assessment_preparations (
            course_id, question_id, source_document_id, source_fingerprint,
            status, attempt_count, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', 0, '', ?, ?)
          ''',
          (course_id, question_id, source_document_id, source_fingerprint, timestamp, timestamp),
        )
      elif str(row['source_fingerprint']) != source_fingerprint:
        connection.execute(
          '''
          UPDATE assessment_preparations SET
            source_document_id = ?, source_fingerprint = ?, status = 'pending',
            attempt_count = 0, last_error = '', updated_at = ?
          WHERE question_id = ?
          ''',
          (source_document_id, source_fingerprint, timestamp, question_id),
        )
      row = connection.execute(
        'SELECT * FROM assessment_preparations WHERE question_id = ?',
        (question_id,),
      ).fetchone()
    return self._row_to_assessment_preparation(row)

  def get_assessment_preparation(
    self,
    course_id: str,
    question_id: str,
  ) -> AssessmentPreparationRecord | None:
    with self._connect(course_id) as connection:
      row = connection.execute(
        'SELECT * FROM assessment_preparations WHERE question_id = ?',
        (question_id,),
      ).fetchone()
    return self._row_to_assessment_preparation(row) if row else None

  def claim_assessment_preparation(
    self,
    course_id: str,
    question_id: str,
    source_fingerprint: str,
    max_attempts: int,
  ) -> bool:
    """Atomically move one pending task to processing."""
    with self._connect(course_id) as connection:
      cursor = connection.execute(
        '''
        UPDATE assessment_preparations SET
          status = 'processing', attempt_count = attempt_count + 1,
          last_error = '', updated_at = ?
        WHERE question_id = ? AND source_fingerprint = ?
          AND status = 'pending' AND attempt_count < ?
        ''',
        (_now(), question_id, source_fingerprint, max_attempts),
      )
    return cursor.rowcount == 1

  def finish_assessment_preparation(
    self,
    course_id: str,
    question_id: str,
    source_fingerprint: str,
    expected_source_fingerprint: str | None = None,
  ) -> bool:
    with self._connect(course_id) as connection:
      if expected_source_fingerprint is None:
        cursor = connection.execute(
          '''
          UPDATE assessment_preparations SET
            source_fingerprint = ?, status = 'ready', last_error = '', updated_at = ?
          WHERE question_id = ?
          ''',
          (source_fingerprint, _now(), question_id),
        )
      else:
        cursor = connection.execute(
          '''
          UPDATE assessment_preparations SET
            source_fingerprint = ?, status = 'ready', last_error = '', updated_at = ?
          WHERE question_id = ? AND source_fingerprint = ?
          ''',
          (source_fingerprint, _now(), question_id, expected_source_fingerprint),
        )
    return cursor.rowcount == 1

  def fail_assessment_preparation(
    self,
    course_id: str,
    question_id: str,
    error: str,
    max_attempts: int,
  ) -> str:
    """Return pending while automatic retries remain, otherwise persist failed."""
    with self._connect(course_id) as connection:
      row = connection.execute(
        'SELECT attempt_count FROM assessment_preparations WHERE question_id = ?',
        (question_id,),
      ).fetchone()
      attempt_count = int(row['attempt_count']) if row else max_attempts
      status = 'pending' if attempt_count < max_attempts else 'failed'
      connection.execute(
        '''
        UPDATE assessment_preparations SET status = ?, last_error = ?, updated_at = ?
        WHERE question_id = ?
        ''',
        (status, str(error or '')[:1000], _now(), question_id),
      )
    return status

  def retry_assessment_preparation(self, course_id: str, question_id: str) -> None:
    """A user-initiated retry starts a fresh bounded attempt cycle."""
    with self._connect(course_id) as connection:
      connection.execute(
        '''
        UPDATE assessment_preparations SET
          status = 'pending', attempt_count = 0, last_error = '', updated_at = ?
        WHERE question_id = ?
        ''',
        (_now(), question_id),
      )

  def recover_interrupted_assessment_preparations(self, max_attempts: int) -> int:
    """Reset processing rows left behind by a previous backend process."""
    recovered = 0
    for database in self._database_paths():
      with self._connect_path(database) as connection:
        cursor = connection.execute(
          '''
          UPDATE assessment_preparations SET
            status = CASE WHEN attempt_count < ? THEN 'pending' ELSE 'failed' END,
            last_error = CASE
              WHEN attempt_count < ? THEN 'Interrupted by backend restart; queued again.'
              ELSE 'Maximum preparation attempts reached after backend restart.'
            END,
            updated_at = ?
          WHERE status = 'processing'
          ''',
          (max_attempts, max_attempts, _now()),
        )
        recovered += cursor.rowcount
    return recovered

  def get_question_reference_answer(
    self,
    course_id: str,
    question_id: str,
  ) -> QuestionReferenceAnswer | None:
    with self._connect(course_id) as connection:
      row = connection.execute(
        'SELECT * FROM question_reference_answers WHERE question_id = ?',
        (question_id,),
      ).fetchone()
    if not row:
      return None
    try:
      structured = json.loads(row['structured_answer_json'])
    except (TypeError, ValueError):
      structured = {}
    return QuestionReferenceAnswer(
      question_id=str(row['question_id']),
      source_document_id=str(row['source_document_id']),
      answer_text=str(row['answer_text']),
      structured_answer=structured if isinstance(structured, dict) else {},
      answer_source=str(row['answer_source']),
      model=str(row['model']),
      confidence=float(row['confidence']),
      needs_review=bool(row['needs_review']),
      created_at=str(row['created_at']),
      updated_at=str(row['updated_at']),
    )

  def save_question_reference_answer(
    self,
    course_id: str,
    answer: QuestionReferenceAnswer,
  ) -> QuestionReferenceAnswer:
    timestamp = _now()
    answer.updated_at = timestamp
    with self._connect(course_id) as connection:
      connection.execute(
        '''
        INSERT INTO question_reference_answers (
          question_id, source_document_id, answer_text, structured_answer_json,
          answer_source, model, confidence, needs_review, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(question_id) DO UPDATE SET
          source_document_id = excluded.source_document_id,
          answer_text = excluded.answer_text,
          structured_answer_json = excluded.structured_answer_json,
          answer_source = excluded.answer_source,
          model = excluded.model,
          confidence = excluded.confidence,
          needs_review = excluded.needs_review,
          updated_at = excluded.updated_at
        ''',
        (
          answer.question_id,
          answer.source_document_id,
          answer.answer_text,
          json.dumps(answer.structured_answer, ensure_ascii=False),
          answer.answer_source,
          answer.model,
          answer.confidence,
          int(answer.needs_review),
          answer.created_at,
          timestamp,
        ),
      )
    return answer

  def record_answer(
    self,
    event: LearningEvent,
    session: AdaptiveTestSession,
  ) -> tuple[LearningEvent, AdaptiveTestSession]:
    """Atomically append evidence and advance the mutable session cursor."""
    session.updated_at = _now()
    with self._connect(event.course_id) as connection:
      self._insert_event(connection, event)
      cursor = connection.execute(
        '''
        UPDATE adaptive_test_sessions SET
          status = ?, target_question_count = ?, candidate_question_ids = ?,
          asked_question_ids = ?, current_question_id = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND course_id = ?
        ''',
        (
          session.status,
          session.target_question_count,
          json.dumps(session.candidate_question_ids, ensure_ascii=False),
          json.dumps(session.asked_question_ids, ensure_ascii=False),
          session.current_question_id,
          session.updated_at,
          session.completed_at,
          session.id,
          session.course_id,
        ),
      )
      if cursor.rowcount != 1:
        raise KeyError(f'Adaptive test session not found: {session.id}')
    return event, session

  def session_events(self, course_id: str, session_id: str) -> list[LearningEvent]:
    return self._events(
      course_id,
      'test_session_id = ?',
      (session_id,),
    )

  def effective_session_events(self, course_id: str, session_id: str) -> list[LearningEvent]:
    return self._latest_revisions(self.session_events(course_id, session_id))

  def lecture_events(self, course_id: str, lecture_document_id: str) -> list[LearningEvent]:
    return self._events(
      course_id,
      'lecture_document_id = ?',
      (lecture_document_id,),
    )

  def effective_lecture_events(self, course_id: str, lecture_document_id: str) -> list[LearningEvent]:
    return self._latest_revisions(self.lecture_events(course_id, lecture_document_id))

  def delete_document(self, course_id: str, document_id: str) -> None:
    with self._connect(course_id) as connection:
      connection.execute(
        'DELETE FROM learning_events WHERE lecture_document_id = ? OR source_document_id = ?',
        (document_id, document_id),
      )
      connection.execute(
        'DELETE FROM adaptive_test_sessions WHERE lecture_document_id = ?',
        (document_id,),
      )
      connection.execute(
        'DELETE FROM assessment_specs WHERE source_document_id = ?',
        (document_id,),
      )
      connection.execute(
        'DELETE FROM assessment_preparations WHERE source_document_id = ?',
        (document_id,),
      )
      connection.execute(
        'DELETE FROM question_reference_answers WHERE source_document_id = ?',
        (document_id,),
      )

  def delete_course(self, course_id: str) -> None:
    database = self.database_path(course_id)
    with self._lock:
      for suffix in ('', '-wal', '-shm'):
        path = Path(f'{database}{suffix}')
        if path.is_file():
          path.unlink()
      if database.parent.is_dir() and not any(database.parent.iterdir()):
        database.parent.rmdir()

  def database_path(self, course_id: str) -> Path:
    normalized = str(course_id or '').strip()
    if not normalized:
      raise ValueError('course_id is required.')
    safe = _SAFE_ID.sub('-', normalized).strip('.-')[:80] or 'course'
    suffix = hashlib.sha256(normalized.encode('utf-8')).hexdigest()[:10]
    return self.root / f'{safe}-{suffix}' / 'learning-state.sqlite3'

  def _events(self, course_id: str, where: str, values: tuple[Any, ...]) -> list[LearningEvent]:
    with self._connect(course_id) as connection:
      rows = connection.execute(
        f'SELECT * FROM learning_events WHERE {where} ORDER BY created_at, id',
        values,
      ).fetchall()
    return [self._row_to_event(row) for row in rows]

  @staticmethod
  def _latest_revisions(events: list[LearningEvent]) -> list[LearningEvent]:
    latest: dict[tuple[str, str], LearningEvent] = {}
    for event in events:
      key = (event.test_session_id, event.question_id)
      previous = latest.get(key)
      if previous is None or (event.revision, event.created_at, event.id) > (
        previous.revision,
        previous.created_at,
        previous.id,
      ):
        latest[key] = event
    return sorted(latest.values(), key=lambda item: (item.created_at, item.id))

  @contextmanager
  def _connect(self, course_id: str) -> Iterator[sqlite3.Connection]:
    with self._connect_path(self.database_path(course_id)) as connection:
      yield connection

  @contextmanager
  def _connect_path(self, path: Path) -> Iterator[sqlite3.Connection]:
    with self._lock:
      path.parent.mkdir(parents=True, exist_ok=True)
      connection = sqlite3.connect(path, timeout=15)
      connection.row_factory = sqlite3.Row
      connection.execute('PRAGMA journal_mode=WAL')
      connection.execute('PRAGMA foreign_keys=ON')
      self._initialize(connection)
      try:
        with connection:
          yield connection
      finally:
        connection.close()

  def _database_paths(self) -> list[Path]:
    if not self.root.is_dir():
      return []
    return sorted(self.root.glob('*/learning-state.sqlite3'))

  @staticmethod
  def _initialize(connection: sqlite3.Connection) -> None:
    connection.executescript(
      '''
      CREATE TABLE IF NOT EXISTS adaptive_test_sessions (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        lecture_document_id TEXT NOT NULL,
        status TEXT NOT NULL,
        target_question_count INTEGER NOT NULL,
        candidate_question_ids TEXT NOT NULL,
        asked_question_ids TEXT NOT NULL,
        current_question_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_test_sessions_lecture
        ON adaptive_test_sessions(course_id, lecture_document_id, status);
      CREATE TABLE IF NOT EXISTS assessment_specs (
        question_id TEXT PRIMARY KEY,
        source_document_id TEXT NOT NULL DEFAULT '',
        source_fingerprint TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assessment_specs_document
        ON assessment_specs(source_document_id);
      CREATE TABLE IF NOT EXISTS assessment_preparations (
        course_id TEXT NOT NULL,
        question_id TEXT PRIMARY KEY,
        source_document_id TEXT NOT NULL DEFAULT '',
        source_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN (
          'pending', 'processing', 'ready', 'failed', 'needs_review'
        )),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_assessment_preparations_status
        ON assessment_preparations(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_assessment_preparations_document
        ON assessment_preparations(source_document_id);
      CREATE TABLE IF NOT EXISTS question_reference_answers (
        question_id TEXT PRIMARY KEY,
        source_document_id TEXT NOT NULL DEFAULT '',
        answer_text TEXT NOT NULL,
        structured_answer_json TEXT NOT NULL DEFAULT '{}',
        answer_source TEXT NOT NULL CHECK(answer_source IN ('ai_generated', 'user_corrected')),
        model TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL DEFAULT 1.0,
        needs_review INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_question_reference_answers_document
        ON question_reference_answers(source_document_id);
      '''
    )
    connection.execute('PRAGMA optimize')

    event_columns = {
      str(row['name'])
      for row in connection.execute('PRAGMA table_info(learning_events)').fetchall()
    }
    needs_revision_migration = bool(event_columns) and 'revision' not in event_columns
    if needs_revision_migration:
      connection.executescript(
        '''
        DROP INDEX IF EXISTS idx_learning_events_lecture;
        DROP INDEX IF EXISTS idx_learning_events_session;
        ALTER TABLE learning_events RENAME TO learning_events_before_revisions;
        '''
      )

    connection.executescript(
      '''
      CREATE TABLE IF NOT EXISTS learning_events (
        id TEXT PRIMARY KEY,
        course_id TEXT NOT NULL,
        lecture_document_id TEXT NOT NULL,
        test_session_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_document_id TEXT NOT NULL DEFAULT '',
        knowledge_points TEXT NOT NULL,
        difficulty INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        score REAL NOT NULL,
        response_time_ms INTEGER NOT NULL,
        response_text TEXT NOT NULL,
        grading_method TEXT NOT NULL,
        grading_confidence REAL NOT NULL,
        grading_feedback TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        supersedes_event_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(test_session_id, question_id, revision)
      );
      '''
    )

    event_columns = {
      str(row['name'])
      for row in connection.execute('PRAGMA table_info(learning_events)').fetchall()
    }
    if 'structured_responses' not in event_columns:
      connection.execute(
        "ALTER TABLE learning_events ADD COLUMN structured_responses TEXT NOT NULL DEFAULT '[]'"
      )
    if 'part_grading_results' not in event_columns:
      connection.execute(
        "ALTER TABLE learning_events ADD COLUMN part_grading_results TEXT NOT NULL DEFAULT '[]'"
      )
    if 'assessment_spec_snapshot' not in event_columns:
      connection.execute(
        "ALTER TABLE learning_events ADD COLUMN assessment_spec_snapshot TEXT NOT NULL DEFAULT '{}'"
      )

    if needs_revision_migration:
      connection.execute(
        '''
        INSERT INTO learning_events (
          id, course_id, lecture_document_id, test_session_id, question_id,
          source_type, source_document_id, knowledge_points, difficulty, correct,
          score, response_time_ms, response_text, grading_method,
          grading_confidence, grading_feedback, revision, supersedes_event_id,
          created_at
        )
        SELECT
          id, course_id, lecture_document_id, test_session_id, question_id,
          source_type, source_document_id, knowledge_points, difficulty, correct,
          score, response_time_ms, response_text, grading_method,
          grading_confidence, grading_feedback, 1, NULL, created_at
        FROM learning_events_before_revisions
        '''
      )
      connection.execute('DROP TABLE learning_events_before_revisions')

    connection.executescript(
      '''
      CREATE INDEX IF NOT EXISTS idx_learning_events_lecture
        ON learning_events(course_id, lecture_document_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_learning_events_session
        ON learning_events(test_session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_learning_events_latest
        ON learning_events(test_session_id, question_id, revision DESC);
      '''
    )

  @staticmethod
  def _session_values(session: AdaptiveTestSession) -> tuple[Any, ...]:
    return (
      session.id,
      session.course_id,
      session.lecture_document_id,
      session.status,
      session.target_question_count,
      json.dumps(session.candidate_question_ids, ensure_ascii=False),
      json.dumps(session.asked_question_ids, ensure_ascii=False),
      session.current_question_id,
      session.created_at,
      session.updated_at,
      session.completed_at,
    )

  @staticmethod
  def _insert_event(connection: sqlite3.Connection, event: LearningEvent) -> None:
    connection.execute(
      '''
      INSERT INTO learning_events (
        id, course_id, lecture_document_id, test_session_id, question_id,
        source_type, source_document_id, knowledge_points, difficulty, correct,
        score, response_time_ms, response_text, structured_responses,
        part_grading_results, assessment_spec_snapshot, grading_method,
        grading_confidence, grading_feedback, revision, supersedes_event_id,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ''',
      (
        event.id,
        event.course_id,
        event.lecture_document_id,
        event.test_session_id,
        event.question_id,
        event.source_type,
        event.source_document_id,
        json.dumps(event.knowledge_points, ensure_ascii=False),
        event.difficulty,
        int(event.correct),
        event.score,
        event.response_time_ms,
        event.response_text,
        json.dumps(event.structured_responses, ensure_ascii=False),
        json.dumps(event.part_grading_results, ensure_ascii=False),
        json.dumps(event.assessment_spec_snapshot, ensure_ascii=False),
        event.grading_method,
        event.grading_confidence,
        event.grading_feedback,
        event.revision,
        event.supersedes_event_id,
        event.created_at,
      ),
    )

  @staticmethod
  def _row_to_session(row: sqlite3.Row) -> AdaptiveTestSession:
    return AdaptiveTestSession(
      id=row['id'],
      course_id=row['course_id'],
      lecture_document_id=row['lecture_document_id'],
      status=row['status'],
      target_question_count=row['target_question_count'],
      candidate_question_ids=json.loads(row['candidate_question_ids']),
      asked_question_ids=json.loads(row['asked_question_ids']),
      current_question_id=row['current_question_id'],
      created_at=row['created_at'],
      updated_at=row['updated_at'],
      completed_at=row['completed_at'],
    )

  @staticmethod
  def _row_to_event(row: sqlite3.Row) -> LearningEvent:
    return LearningEvent(
      id=row['id'],
      course_id=row['course_id'],
      lecture_document_id=row['lecture_document_id'],
      test_session_id=row['test_session_id'],
      question_id=row['question_id'],
      source_type=row['source_type'],
      source_document_id=row['source_document_id'],
      knowledge_points=json.loads(row['knowledge_points']),
      difficulty=row['difficulty'],
      correct=bool(row['correct']),
      score=row['score'],
      response_time_ms=row['response_time_ms'],
      response_text=row['response_text'],
      structured_responses=json.loads(row['structured_responses'] or '[]'),
      part_grading_results=json.loads(row['part_grading_results'] or '[]'),
      assessment_spec_snapshot=json.loads(row['assessment_spec_snapshot'] or '{}'),
      grading_method=row['grading_method'],
      grading_confidence=row['grading_confidence'],
      grading_feedback=row['grading_feedback'],
      revision=row['revision'],
      supersedes_event_id=row['supersedes_event_id'],
      created_at=row['created_at'],
    )

  @staticmethod
  def _row_to_assessment_preparation(row: sqlite3.Row) -> AssessmentPreparationRecord:
    return AssessmentPreparationRecord(
      course_id=str(row['course_id']),
      question_id=str(row['question_id']),
      source_document_id=str(row['source_document_id']),
      source_fingerprint=str(row['source_fingerprint']),
      status=str(row['status']),
      attempt_count=int(row['attempt_count']),
      last_error=str(row['last_error']),
      created_at=str(row['created_at']),
      updated_at=str(row['updated_at']),
    )

