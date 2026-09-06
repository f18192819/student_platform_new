from __future__ import annotations

import hashlib
import logging
import sqlite3
from datetime import datetime, timezone
from threading import RLock
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from .learning_state import LearningEvent, LearningStateStore
from .user_answers import (
  ErrorType,
  ReviewedError,
  UserAnswerConflictError,
  UserAnswerDeletionError,
  UserAnswerError,
  UserAnswerNotFound,
  UserAnswerQuestionResult,
  UserAnswerQuestionReview,
  UserAnswerStore,
  UserAnswerValidationError,
  UserQuestionAnswer,
  normalize_error_deductions,
)


SELF_SUBMITTED_SOURCE_TYPES = {
  'homework': 'self-submitted-homework',
  'past-exam': 'self-submitted-past-exam',
}

logger = logging.getLogger(__name__)


def _now() -> str:
  return datetime.now(timezone.utc).isoformat()


class ReviewErrorInput(BaseModel):
  id: str
  source: Literal['ai', 'user']
  accepted: bool = True
  type: ErrorType | None = None
  location: str = ''
  student_reasoning: str = ''
  problem: str = ''
  correction: str = ''
  severity: Literal['low', 'medium', 'high'] = 'medium'
  deduction: float | None = Field(default=None, ge=0.0, le=1.0)


class SaveQuestionReviewRequest(BaseModel):
  base_grading_revision: int = Field(ge=1)
  errors: list[ReviewErrorInput]


class ReviewQuestionContextProvider(Protocol):
  def resolve(self, course_id: str, source_document_id: str, question_id: str) -> dict[str, Any]: ...


class UserAnswerReviewService:
  """Apply a human overlay without mutating the underlying AI grading."""

  def __init__(
    self,
    answers: UserAnswerStore,
    learning: LearningStateStore,
    contexts: ReviewQuestionContextProvider,
  ) -> None:
    self.answers = answers
    self.learning = learning
    self.contexts = contexts
    self._lock = RLock()

  def save(
    self,
    course_id: str,
    source_document_id: str,
    route_question_id: str,
    attempt_id: str,
    question_id: str,
    request: SaveQuestionReviewRequest,
  ) -> tuple[UserQuestionAnswer, UserAnswerQuestionReview]:
    with self._lock:
      return self._save(
        course_id, source_document_id, route_question_id, attempt_id, question_id, request,
      )

  def _save(
    self,
    course_id: str,
    source_document_id: str,
    route_question_id: str,
    attempt_id: str,
    question_id: str,
    request: SaveQuestionReviewRequest,
  ) -> tuple[UserQuestionAnswer, UserAnswerQuestionReview]:
    attempt = self.answers.get_attempt(
      course_id, source_document_id, route_question_id, attempt_id,
    )
    if attempt is None:
      raise UserAnswerNotFound('User answer attempt not found.')
    current_revision = len(attempt.grading_revisions)
    if request.base_grading_revision != current_revision:
      raise UserAnswerConflictError('The AI grading changed. Review the latest result before saving again.')
    result = self._question_result(attempt, question_id)
    grading = normalize_error_deductions(result.grading)
    reviewed_errors = self._resolve_errors(grading.errors, request.errors)
    final_score = self._final_score(grading.score, reviewed_errors)
    next_revision = max((
      item.revision for item in attempt.manual_review_revisions
      if item.question_id == question_id
    ), default=0) + 1
    event_id = hashlib.sha256(
      f'user-answer:{attempt.id}:{question_id}:review:{next_revision}'.encode('utf-8')
    ).hexdigest()[:32]
    review = UserAnswerQuestionReview(
      revision=next_revision,
      question_id=question_id,
      base_grading_revision=current_revision,
      errors=reviewed_errors,
      final_score=final_score,
      final_correct=final_score >= 0.999,
      reviewed_at=_now(),
      learning_event_id=event_id,
    )
    saved_attempt, saved_review, _ = self.answers.save_manual_review(
      course_id, attempt.question_id, attempt.id, review,
    )
    self._publish_learning_event(saved_attempt, result, saved_review)
    refreshed = self.answers.get_attempt(
      course_id, source_document_id, route_question_id, attempt_id,
    )
    return refreshed or saved_attempt, saved_review

  def delete_attempt_evidence(self, course_id: str, attempt_ids: list[str]) -> int:
    return self.learning.delete_user_answer_events(course_id, attempt_ids)

  def delete_attempt(
    self,
    course_id: str,
    source_document_id: str,
    route_question_id: str,
    attempt_id: str,
  ) -> tuple[UserQuestionAnswer, int]:
    with self._lock:
      if self.answers.get_attempt(
        course_id, source_document_id, route_question_id, attempt_id,
      ) is None:
        raise UserAnswerNotFound('User answer attempt not found.')
      session_id = f'user-answer:{attempt_id}'
      previous_events = self.learning.session_events(course_id, session_id)
      try:
        # Zero deleted rows is valid for pending, failed, and unreviewed Attempts.
        self.learning.delete_user_answer_events(course_id, [attempt_id])
      except sqlite3.Error as error:
        logger.exception(
          'Failed removing learning evidence for user answer Attempt',
          extra={'course_id': course_id, 'attempt_id': attempt_id},
        )
        raise UserAnswerDeletionError(
          '暂时无法清理该作答的学习记录，请稍后重试。',
          status_code=503,
        ) from error
      try:
        return self.answers.delete_attempt(
          course_id, source_document_id, route_question_id, attempt_id,
        )
      except UserAnswerError:
        attempt_still_exists = self.answers.get_attempt(
          course_id, source_document_id, route_question_id, attempt_id,
        ) is not None
        if attempt_still_exists:
          try:
            for event in previous_events:
              self.learning.append_event(event)
          except sqlite3.Error as restore_error:
            logger.exception(
              'Failed restoring learning evidence after user answer deletion rollback',
              extra={'course_id': course_id, 'attempt_id': attempt_id},
            )
            raise UserAnswerDeletionError(
              '删除未完成，且学习记录恢复失败，请停止操作并检查服务日志。',
              status_code=503,
            ) from restore_error
        raise

  @staticmethod
  def _question_result(attempt: UserQuestionAnswer, question_id: str) -> UserAnswerQuestionResult:
    result = next((item for item in attempt.question_results if item.question_id == question_id), None)
    if result is None and question_id == attempt.question_id and attempt.grading and attempt.understanding:
      result = UserAnswerQuestionResult(
        question_id=question_id,
        understanding=attempt.understanding,
        grading=attempt.grading,
      )
    if result is None:
      raise UserAnswerNotFound('The selected question grading result was not found.')
    return result

  @staticmethod
  def _resolve_errors(ai_errors, requested: list[ReviewErrorInput]) -> list[ReviewedError]:
    decisions: dict[str, ReviewErrorInput] = {}
    user_errors: list[ReviewedError] = []
    for item in requested:
      if not item.id.strip() or item.id in decisions:
        raise UserAnswerValidationError('Every review error must have a unique id.')
      decisions[item.id] = item
      if item.source == 'user':
        if item.type is None or not item.problem.strip() or item.deduction is None:
          raise UserAnswerValidationError('A user-added error needs type, description, and deduction.')
        user_errors.append(ReviewedError(
          id=item.id,
          source='user',
          accepted=item.accepted,
          type=item.type,
          location=item.location,
          student_reasoning=item.student_reasoning,
          problem=item.problem.strip(),
          correction=item.correction.strip(),
          severity=item.severity,
          deduction=item.deduction,
        ))

    ai_ids = {error.id for error in ai_errors}
    invalid_ai_ids = {
      item.id for item in requested if item.source == 'ai' and item.id not in ai_ids
    }
    if invalid_ai_ids:
      raise UserAnswerValidationError('The review contains an unknown AI error.')
    resolved = [
      ReviewedError(
        **error.model_dump(),
        source='ai',
        accepted=decisions.get(error.id).accepted if error.id in decisions else True,
      )
      for error in ai_errors
    ]
    return [*resolved, *user_errors]

  @staticmethod
  def _final_score(base_score: float, errors: list[ReviewedError]) -> float:
    restored = sum(error.deduction for error in errors if error.source == 'ai' and not error.accepted)
    added = sum(error.deduction for error in errors if error.source == 'user' and error.accepted)
    return round(max(0.0, min(1.0, base_score + restored - added)), 6)

  def _publish_learning_event(
    self,
    attempt: UserQuestionAnswer,
    result: UserAnswerQuestionResult,
    review: UserAnswerQuestionReview,
  ) -> None:
    if not self.answers.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
      return
    session_id = f'user-answer:{attempt.id}'
    existing = self.learning.session_events(attempt.course_id, session_id)
    if any(event.id == review.learning_event_id for event in existing):
      return
    previous = next((
      event for event in reversed(self.learning.effective_session_events(attempt.course_id, session_id))
      if event.question_id == result.question_id
    ), None)
    context = self.contexts.resolve(
      attempt.course_id, attempt.source_document_id, result.question_id,
    )
    analysis = context.get('analysis') if isinstance(context.get('analysis'), dict) else {}
    concepts = self._knowledge_points(analysis, result)
    difficulty = self._difficulty(analysis)
    accepted_errors = [
      error.model_dump() for error in review.errors if error.accepted
    ]
    event = LearningEvent(
      id=review.learning_event_id,
      course_id=attempt.course_id,
      lecture_document_id='',
      test_session_id=session_id,
      question_id=result.question_id,
      source_type=SELF_SUBMITTED_SOURCE_TYPES[attempt.source_type],
      source_document_id=attempt.source_document_id,
      knowledge_points=concepts,
      difficulty=difficulty,
      correct=review.final_correct,
      score=review.final_score,
      response_text=result.understanding.transcription,
      grading_method='human-reviewed-ai',
      grading_confidence=1.0,
      grading_feedback=result.grading.feedback,
      error_evidence=accepted_errors,
      revision=(previous.revision + 1) if previous else 1,
      supersedes_event_id=previous.id if previous else None,
      created_at=review.reviewed_at,
    )
    self.learning.append_event(event)

  @staticmethod
  def _knowledge_points(analysis: dict[str, Any], result: UserAnswerQuestionResult) -> list[str]:
    values = analysis.get('knowledge_points') or []
    concepts = [
      str(value.get('name') if isinstance(value, dict) else value).strip()
      for value in values
      if str(value.get('name') if isinstance(value, dict) else value).strip()
    ]
    if not concepts:
      concepts = [item.name.strip() for item in result.grading.knowledge_points if item.name.strip()]
    return list(dict.fromkeys(concepts))

  @staticmethod
  def _difficulty(analysis: dict[str, Any]) -> int:
    value = analysis.get('difficulty', 3)
    if isinstance(value, dict):
      value = value.get('level', 3)
    try:
      return max(1, min(5, int(value)))
    except (TypeError, ValueError):
      return 3


__all__ = [
  'ReviewErrorInput',
  'SaveQuestionReviewRequest',
  'UserAnswerReviewService',
]
