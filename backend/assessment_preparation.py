from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

from .assessment_planner import AssessmentSpec
from .learning_state import LearningStateStore


PreparationKey = tuple[str, str]
PreparationIdentity = tuple[str, str, str]
PrepareAssessment = Callable[[str, dict[str, Any]], AssessmentSpec]
ReadAssessment = Callable[[str, dict[str, Any]], AssessmentSpec | None]
IdentifyAssessment = Callable[[str, dict[str, Any]], PreparationIdentity]
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class AssessmentPreparationStatus:
  state: str
  error: str = ''


class AssessmentPreparationCoordinator:
  """Runs a small durable AssessmentSpec queue with in-process deduplication."""

  def __init__(
    self,
    prepare: PrepareAssessment,
    read: ReadAssessment,
    identify: IdentifyAssessment,
    store: LearningStateStore,
    max_workers: int = 2,
    max_attempts: int = 3,
  ) -> None:
    self._prepare = prepare
    self._read = read
    self._identify = identify
    self._store = store
    self._max_attempts = max(1, max_attempts)
    self._executor = ThreadPoolExecutor(
      max_workers=max(1, max_workers),
      thread_name_prefix='assessment-preparation',
    )
    self._lock = threading.RLock()
    self._futures: dict[PreparationKey, Future[AssessmentSpec]] = {}
    self._latest_candidates: dict[PreparationKey, dict[str, Any]] = {}
    self._closed = False

  @staticmethod
  def _key(course_id: str, candidate: dict[str, Any]) -> PreparationKey:
    return course_id, str(candidate.get('question_id') or '')

  def schedule(self, course_id: str, candidate: dict[str, Any]) -> AssessmentPreparationStatus:
    question_id, source_document_id, source_fingerprint = self._identify(course_id, candidate)
    if not question_id:
      return AssessmentPreparationStatus('failed', 'Question id is missing.')

    cached = self._read(course_id, candidate)
    if cached is not None:
      self._store.ensure_assessment_preparation(
        course_id, question_id, source_document_id, cached.source_fingerprint,
      )
      self._store.finish_assessment_preparation(course_id, question_id, cached.source_fingerprint)
      LOGGER.info('assessment.prepare.cache_hit course=%s question=%s', course_id, question_id)
      return AssessmentPreparationStatus('ready')

    record = self._store.ensure_assessment_preparation(
      course_id, question_id, source_document_id, source_fingerprint,
    )
    if record.status == 'ready':
      self._store.retry_assessment_preparation(course_id, question_id)
      record = self._store.get_assessment_preparation(course_id, question_id)
    key = self._key(course_id, candidate)
    snapshot = dict(candidate)
    with self._lock:
      self._latest_candidates[key] = snapshot
      future = self._futures.get(key)
      if future is not None and not future.done():
        return AssessmentPreparationStatus('preparing')
      if record.status == 'processing':
        return AssessmentPreparationStatus('preparing')
      if record.status == 'failed':
        return AssessmentPreparationStatus('failed', record.last_error)
      if record.status == 'needs_review':
        return AssessmentPreparationStatus('needs_review', record.last_error)
      if self._closed:
        return AssessmentPreparationStatus('pending')
      if not self._store.claim_assessment_preparation(
        course_id, question_id, source_fingerprint, self._max_attempts,
      ):
        latest = self._store.get_assessment_preparation(course_id, question_id)
        if latest and latest.status == 'pending' and latest.attempt_count >= self._max_attempts:
          self._store.fail_assessment_preparation(
            course_id,
            question_id,
            latest.last_error or 'Maximum preparation attempts reached.',
            self._max_attempts,
          )
          latest = self._store.get_assessment_preparation(course_id, question_id)
        return self._status_from_record(latest)

      queued_at = time.perf_counter()
      future = self._executor.submit(self._run, course_id, snapshot, queued_at)
      self._futures[key] = future
      future.add_done_callback(
        lambda completed, job_key=key, job_candidate=snapshot: self._finish(
          job_key, job_candidate, completed,
        )
      )
    LOGGER.info('assessment.prepare.queued course=%s question=%s', course_id, question_id)
    return AssessmentPreparationStatus('preparing')

  def status(self, course_id: str, candidate: dict[str, Any]) -> AssessmentPreparationStatus:
    question_id, source_document_id, source_fingerprint = self._identify(course_id, candidate)
    cached = self._read(course_id, candidate)
    if cached is not None:
      self._store.ensure_assessment_preparation(
        course_id, question_id, source_document_id, cached.source_fingerprint,
      )
      self._store.finish_assessment_preparation(course_id, question_id, cached.source_fingerprint)
      return AssessmentPreparationStatus('ready')
    record = self._store.ensure_assessment_preparation(
      course_id, question_id, source_document_id, source_fingerprint,
    )
    if record.status == 'ready':
      self._store.retry_assessment_preparation(course_id, question_id)
      record = self._store.get_assessment_preparation(course_id, question_id)
    key = self._key(course_id, candidate)
    with self._lock:
      future = self._futures.get(key)
      if future is not None and not future.done():
        return AssessmentPreparationStatus('preparing')
    return self._status_from_record(record)

  def retry(self, course_id: str, candidate: dict[str, Any]) -> AssessmentPreparationStatus:
    question_id, source_document_id, source_fingerprint = self._identify(course_id, candidate)
    self._store.ensure_assessment_preparation(
      course_id, question_id, source_document_id, source_fingerprint,
    )
    self._store.retry_assessment_preparation(course_id, question_id)
    return self.schedule(course_id, candidate)

  def recover_interrupted(self) -> int:
    recovered = self._store.recover_interrupted_assessment_preparations(self._max_attempts)
    if recovered:
      LOGGER.info('assessment.prepare.resume interrupted=%s', recovered)
    return recovered

  def _run(
    self,
    course_id: str,
    candidate: dict[str, Any],
    queued_at: float,
  ) -> AssessmentSpec:
    question_id = str(candidate.get('question_id') or '')
    LOGGER.info(
      'assessment.prepare.started course=%s question=%s queue_ms=%.1f',
      course_id,
      question_id,
      (time.perf_counter() - queued_at) * 1000,
    )
    return self._prepare(course_id, candidate)

  def _finish(
    self,
    key: PreparationKey,
    candidate: dict[str, Any],
    future: Future[AssessmentSpec],
  ) -> None:
    course_id, question_id = key
    error = ''
    spec: AssessmentSpec | None = None
    try:
      spec = future.result()
    except Exception as exc:  # The API exposes a short failure summary, not a worker traceback.
      error = str(getattr(exc, 'detail', '') or exc)[:1000]
    with self._lock:
      self._futures.pop(key, None)
      latest_candidate = self._latest_candidates.pop(key, candidate)

    expected_fingerprint = self._identify(course_id, candidate)[2]
    current_record = self._store.get_assessment_preparation(course_id, question_id)
    source_changed = bool(
      current_record and current_record.source_fingerprint != expected_fingerprint
    )

    if spec is not None:
      applied = self._store.finish_assessment_preparation(
        course_id,
        question_id,
        spec.source_fingerprint,
        expected_source_fingerprint=expected_fingerprint,
      )
      if applied:
        LOGGER.info('assessment.prepare.ready course=%s question=%s', course_id, question_id)
        return

    if source_changed:
      next_status = 'pending'
      LOGGER.info(
        'assessment.prepare.queued course=%s question=%s reason=fingerprint_changed',
        course_id,
        question_id,
      )
    else:
      next_status = self._store.fail_assessment_preparation(
        course_id, question_id, error, self._max_attempts,
      )
      LOGGER.warning(
        'assessment.prepare.failed course=%s question=%s status=%s error=%s',
        course_id,
        question_id,
        next_status,
        error,
      )
    if next_status == 'pending' and not self._closed:
      self.schedule(course_id, latest_candidate)

  @staticmethod
  def _status_from_record(record: Any) -> AssessmentPreparationStatus:
    if record is None:
      return AssessmentPreparationStatus('idle')
    if record.status in {'pending', 'processing'}:
      return AssessmentPreparationStatus('preparing')
    return AssessmentPreparationStatus(str(record.status), str(record.last_error or ''))

  def close(self) -> None:
    self._closed = True
    self._executor.shutdown(wait=False, cancel_futures=True)
