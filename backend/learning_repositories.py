from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .learning_state import AdaptiveTestSession, LearningEvent, LearningStateStore


class SessionRepository(Protocol):
  def create(self, session: AdaptiveTestSession) -> AdaptiveTestSession: ...
  def save(self, session: AdaptiveTestSession) -> AdaptiveTestSession: ...
  def find(self, session_id: str) -> AdaptiveTestSession | None: ...
  def find_active(self, course_id: str, lecture_document_id: str) -> AdaptiveTestSession | None: ...


class EventRepository(Protocol):
  def for_session(self, course_id: str, session_id: str) -> list[LearningEvent]: ...
  def for_lecture(self, course_id: str, lecture_document_id: str) -> list[LearningEvent]: ...
  def question_history_for_lecture(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> dict[str, list[LearningEvent]]: ...


class LearningProgressRepository(Protocol):
  def record(self, event: LearningEvent, session: AdaptiveTestSession) -> None: ...


class StoreSessionRepository:
  def __init__(self, store: LearningStateStore) -> None:
    self._store = store

  def create(self, session: AdaptiveTestSession) -> AdaptiveTestSession:
    return self._store.create_session(session)

  def save(self, session: AdaptiveTestSession) -> AdaptiveTestSession:
    return self._store.save_session(session)

  def find(self, session_id: str) -> AdaptiveTestSession | None:
    return self._store.find_session(session_id)

  def find_active(self, course_id: str, lecture_document_id: str) -> AdaptiveTestSession | None:
    return self._store.find_active(course_id, lecture_document_id)


class StoreEventRepository:
  def __init__(self, store: LearningStateStore) -> None:
    self._store = store

  def for_session(self, course_id: str, session_id: str) -> list[LearningEvent]:
    return self._store.effective_session_events(course_id, session_id)

  def for_lecture(self, course_id: str, lecture_document_id: str) -> list[LearningEvent]:
    return self._store.effective_lecture_events(course_id, lecture_document_id)

  def question_history_for_lecture(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> dict[str, list[LearningEvent]]:
    history: dict[str, list[LearningEvent]] = {}
    for event in self._store.effective_lecture_events(course_id, lecture_document_id):
      history.setdefault(event.question_id, []).append(event)
    return history


class StoreLearningProgressRepository:
  def __init__(self, store: LearningStateStore) -> None:
    self._store = store

  def record(self, event: LearningEvent, session: AdaptiveTestSession) -> None:
    self._store.record_answer(event, session)


@dataclass(frozen=True)
class LearningStateRepositories:
  sessions: SessionRepository
  events: EventRepository
  progress: LearningProgressRepository

  @classmethod
  def from_store(cls, store: LearningStateStore) -> 'LearningStateRepositories':
    return cls(
      sessions=StoreSessionRepository(store),
      events=StoreEventRepository(store),
      progress=StoreLearningProgressRepository(store),
    )
