from __future__ import annotations

import threading
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable

from .assessment_planner import AssessmentSpec


PreparationKey = tuple[str, str]
PrepareAssessment = Callable[[str, dict[str, Any]], AssessmentSpec]
ReadAssessment = Callable[[str, dict[str, Any]], AssessmentSpec | None]


@dataclass(frozen=True)
class AssessmentPreparationStatus:
  state: str
  error: str = ''


class AssessmentPreparationCoordinator:
  """Deduplicates bounded background AssessmentSpec generation jobs."""

  def __init__(self, prepare: PrepareAssessment, read: ReadAssessment, max_workers: int = 2) -> None:
    self._prepare = prepare
    self._read = read
    self._executor = ThreadPoolExecutor(
      max_workers=max(1, max_workers),
      thread_name_prefix='assessment-preparation',
    )
    self._lock = threading.RLock()
    self._futures: dict[PreparationKey, Future[AssessmentSpec]] = {}
    self._errors: dict[PreparationKey, str] = {}

  @staticmethod
  def _key(course_id: str, candidate: dict[str, Any]) -> PreparationKey:
    return course_id, str(candidate.get('question_id') or '')

  def schedule(self, course_id: str, candidate: dict[str, Any]) -> AssessmentPreparationStatus:
    cached = self._read(course_id, candidate)
    if cached is not None:
      return AssessmentPreparationStatus('ready')
    key = self._key(course_id, candidate)
    with self._lock:
      future = self._futures.get(key)
      if future is not None and not future.done():
        return AssessmentPreparationStatus('preparing')
      if key in self._errors:
        return AssessmentPreparationStatus('failed', self._errors[key])
      snapshot = dict(candidate)
      future = self._executor.submit(self._prepare, course_id, snapshot)
      self._futures[key] = future
      future.add_done_callback(lambda completed, job_key=key: self._finish(job_key, completed))
    return AssessmentPreparationStatus('preparing')

  def status(self, course_id: str, candidate: dict[str, Any]) -> AssessmentPreparationStatus:
    if self._read(course_id, candidate) is not None:
      return AssessmentPreparationStatus('ready')
    key = self._key(course_id, candidate)
    with self._lock:
      future = self._futures.get(key)
      if future is not None and not future.done():
        return AssessmentPreparationStatus('preparing')
      error = self._errors.get(key, '')
    return AssessmentPreparationStatus('failed', error) if error else AssessmentPreparationStatus('idle')

  def retry(self, course_id: str, candidate: dict[str, Any]) -> AssessmentPreparationStatus:
    key = self._key(course_id, candidate)
    with self._lock:
      self._errors.pop(key, None)
    return self.schedule(course_id, candidate)

  def _finish(self, key: PreparationKey, future: Future[AssessmentSpec]) -> None:
    error = ''
    try:
      future.result()
    except Exception as exc:  # The API exposes a short failure summary, not a worker traceback.
      error = str(getattr(exc, 'detail', '') or exc)[:1000]
    with self._lock:
      self._futures.pop(key, None)
      if error:
        self._errors[key] = error
      else:
        self._errors.pop(key, None)

  def close(self) -> None:
    self._executor.shutdown(wait=False, cancel_futures=True)
