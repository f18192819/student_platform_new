from __future__ import annotations

import asyncio
import logging
import re
import threading
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .adaptive_candidates import CandidateProvider, RelationCandidateProvider, RelationQuestionQuery
from .adaptive_grading import (
  GradingResult,
  ConfiguredQuestionGrader,
  PartGrader,
  QuestionGrader,
  StructuredPartGrader,
)
from .assessment_planner import AssessmentPlanner, AssessmentSpec
from .assessment_preparation import AssessmentPreparationCoordinator
from .adaptive_results import AdaptiveTestResultAssembler
from .adaptive_selection import QuestionSelectionStrategy, RuleBasedQuestionSelectionStrategy
from .learning_repositories import LearningStateRepositories
from .learning_state import (
  AdaptiveTestSession,
  LearningEvent,
  LearningStateStore,
)
from .question_pipeline import resolve_question_image_asset

adaptive_testing_router = APIRouter(prefix='/api/adaptive-tests', tags=['adaptive-testing'])
LOGGER = logging.getLogger(__name__)
_REFERENCE_MARKER = re.compile(
  r'(?im)^\s*(?:\d{2,8}\s*)?(?:参考答案|标准答案|解答|答案|解析|solution|answer)\s*[:：]\s*'
)
_SEGMENT_ID_LINE = re.compile(r'(?m)^\s*\d{3,8}\s*$')
class StartAdaptiveTestRequest(BaseModel):
  model_config = ConfigDict(extra='forbid')
  course_id: str = Field(min_length=1)
  lecture_document_id: str = Field(min_length=1)
  target_question_count: int = Field(default=7, ge=5, le=10)


class AssessmentResponse(BaseModel):
  model_config = ConfigDict(extra='forbid')
  part_id: str = Field(min_length=1, max_length=80)
  value: str = Field(min_length=1, max_length=20000)


class SubmitAdaptiveAnswerRequest(BaseModel):
  model_config = ConfigDict(extra='forbid')
  question_id: str = Field(default='', max_length=128)
  responses: list[AssessmentResponse] = Field(default_factory=list, max_length=12)
  answer: str | None = Field(default=None, max_length=20000)
  response_time_ms: int = Field(default=0, ge=0, le=24 * 60 * 60 * 1000)

  @model_validator(mode='after')
  def validate_answer_payload(self) -> 'SubmitAdaptiveAnswerRequest':
    if not self.responses and not str(self.answer or '').strip():
      raise ValueError('responses or legacy answer is required.')
    response_ids = [item.part_id for item in self.responses]
    if len(response_ids) != len(set(response_ids)):
      raise ValueError('part_id values must be unique.')
    return self


class CorrectReferenceAnswerRequest(BaseModel):
  model_config = ConfigDict(extra='forbid')
  answer_text: str = Field(min_length=1, max_length=30000)


def _clean_source_text(value: Any) -> str:
  text = str(value or '').replace('\r\n', '\n').strip()
  return re.sub(r'\n{3,}', '\n\n', _SEGMENT_ID_LINE.sub('', text)).strip()


def split_question_material(question: dict[str, Any]) -> tuple[str, str, str]:
  """Return the original prompt, hidden reference answer, and grading method."""
  content = _clean_source_text(question.get('content'))
  analysis = question.get('analysis') if isinstance(question.get('analysis'), dict) else {}
  explicit_answer = next(
    (
      _clean_source_text(value)
      for value in (
        question.get('standard_answer'),
        question.get('reference_answer'),
        question.get('answer'),
        analysis.get('standard_answer'),
        analysis.get('reference_answer'),
        analysis.get('answer'),
      )
      if _clean_source_text(value)
    ),
    '',
  )
  if explicit_answer:
    question_type = str(analysis.get('question_type') or '').casefold()
    is_objective = bool(re.search(r'选择|判断|填空|单选|多选|true|false|choice', question_type))
    method = 'exact_answer' if is_objective and len(explicit_answer) <= 200 else 'llm_reference'
    return content, explicit_answer, method

  match = _REFERENCE_MARKER.search(content)
  if match:
    prompt = content[:match.start()].strip()
    reference = content[match.end():].strip()
    if prompt and reference:
      return prompt, reference, 'llm_reference'
  return content, '', 'ungradable'


class AdaptiveTestingService:
  def __init__(
    self,
    relation_pipeline: RelationQuestionQuery,
    store: LearningStateStore | None = None,
    grader: QuestionGrader | None = None,
    repositories: LearningStateRepositories | None = None,
    candidate_provider: CandidateProvider | None = None,
    part_grader: PartGrader | None = None,
    selection_strategy: QuestionSelectionStrategy | None = None,
    result_assembler: AdaptiveTestResultAssembler | None = None,
  ) -> None:
    self.store = store or LearningStateStore()
    self.grader = grader or ConfiguredQuestionGrader()
    self.part_grader = part_grader or StructuredPartGrader(self.grader)
    self.repositories = repositories or LearningStateRepositories.from_store(self.store)
    self.selection_strategy = selection_strategy or RuleBasedQuestionSelectionStrategy()
    self.result_assembler = result_assembler or AdaptiveTestResultAssembler()
    self.assessment_planner = AssessmentPlanner(self.store)
    self.candidate_provider = candidate_provider or RelationCandidateProvider(
      relation_pipeline,
      self.assessment_planner,
      split_question_material,
    )
    self.assessment_preparation = AssessmentPreparationCoordinator(
      self._assessment_spec,
      self._cached_assessment_spec,
      self._assessment_identity,
      self.store,
      max_workers=2,
      max_attempts=3,
    )
    self._lock = threading.RLock()

  def start(self, request: StartAdaptiveTestRequest) -> dict[str, Any]:
    started_at = time.perf_counter()
    with self._lock:
      existing = self.repositories.sessions.find_active(
        request.course_id,
        request.lecture_document_id,
      )
      if existing:
        return self._session_payload(existing)
      candidates, skipped = self._candidates(request.course_id, request.lecture_document_id)
      if not candidates:
        raise HTTPException(
          status_code=422,
          detail='No related question has a reliable answer or reference solution for grading.',
        )
      target_count = min(request.target_question_count, len(candidates))
      session = AdaptiveTestSession(
        course_id=request.course_id,
        lecture_document_id=request.lecture_document_id,
        target_question_count=target_count,
        candidate_question_ids=[str(item['question_id']) for item in candidates],
      )
      session.current_question_id = self._select_next(session, candidates)
      session.target_question_count = min(
        session.target_question_count,
        len(session.candidate_question_ids),
      )
      self.repositories.sessions.create(session)
      payload = self._session_payload(session, candidates)
      payload['skipped_ungradable_questions'] = skipped
      LOGGER.info(
        'adaptive.start.ready_candidates course=%s lecture=%s ready=%s total=%s',
        request.course_id,
        request.lecture_document_id,
        int(payload.get('preparation', {}).get('ready_count') or 0),
        len(session.candidate_question_ids),
      )
      LOGGER.info(
        'adaptive.start.duration course=%s lecture=%s duration_ms=%.1f',
        request.course_id,
        request.lecture_document_id,
        (time.perf_counter() - started_at) * 1000,
      )
      return payload

  def active(self, course_id: str, lecture_document_id: str) -> dict[str, Any]:
    session = self.repositories.sessions.find_active(course_id, lecture_document_id)
    return self._session_payload(session) if session else {'session': None}

  def get(self, session_id: str) -> dict[str, Any]:
    session = self._require_session(session_id)
    return self._session_payload(session)

  def submit(self, session_id: str, request: SubmitAdaptiveAnswerRequest) -> dict[str, Any]:
    with self._lock:
      session = self._require_session(session_id)
      if session.status not in {'active', 'completed'}:
        raise HTTPException(status_code=409, detail='Adaptive test session is not accepting answers.')
      candidates, _ = self._candidates(session.course_id, session.lecture_document_id)
      candidate_by_id = {str(item['question_id']): item for item in candidates}
      question_id = str(request.question_id or session.current_question_id or '').strip()
      unlocked_question_ids = set(session.asked_question_ids)
      if session.current_question_id:
        unlocked_question_ids.add(session.current_question_id)
      if question_id not in unlocked_question_ids:
        raise HTTPException(status_code=409, detail='This question has not been unlocked in the adaptive test.')
      candidate = candidate_by_id.get(question_id)
      if not candidate:
        raise HTTPException(status_code=409, detail='The selected source question is no longer available.')

      previous_by_question = {
        event.question_id: event
        for event in self.repositories.events.for_session(session.course_id, session.id)
      }
      previous_event = previous_by_question.get(question_id)
      is_revision = previous_event is not None
      if not is_revision and (session.status != 'active' or question_id != session.current_question_id):
        raise HTTPException(status_code=409, detail='Only the current adaptive question can be answered for the first time.')

      preferred_assessment = (
        self._revision_assessment_spec(
          session.course_id,
          candidate,
          previous_event,
        )
        if previous_event is not None
        else self._cached_assessment_spec(session.course_id, candidate)
      )
      assessment_spec = self._session_assessment_spec(
        session,
        candidate,
        preferred=preferred_assessment,
      )
      if assessment_spec is None:
        raise HTTPException(status_code=409, detail='本题作答结构尚未准备完成，请稍后重试。')
      candidate['reference_answer'] = assessment_spec.reference_answer
      grading, structured_responses, response_text = self.part_grader.grade(
        candidate,
        assessment_spec,
        [response.model_dump() for response in request.responses],
        str(request.answer or '').strip(),
      )
      event = LearningEvent(
        course_id=session.course_id,
        lecture_document_id=session.lecture_document_id,
        test_session_id=session.id,
        question_id=str(candidate['question_id']),
        source_type=str(candidate['source_type']),
        source_document_id=str(candidate['document_id']),
        knowledge_points=list(candidate['knowledge_points']),
        difficulty=int(candidate['difficulty']),
        correct=grading.correct,
        score=grading.score,
        response_time_ms=request.response_time_ms,
        response_text=response_text,
        structured_responses=structured_responses,
        part_grading_results=[item.model_dump() for item in grading.parts],
        assessment_spec_snapshot=assessment_spec.model_dump(),
        grading_method=grading.method,
        grading_confidence=grading.confidence,
        grading_feedback=grading.feedback,
        revision=(previous_event.revision + 1) if previous_event else 1,
        supersedes_event_id=previous_event.id if previous_event else None,
      )
      if not is_revision:
        session.asked_question_ids.append(event.question_id)
        remaining = [
          item for item in candidates
          if str(item['question_id']) not in set(session.asked_question_ids)
        ]
        if len(session.asked_question_ids) >= session.target_question_count or not remaining:
          session.status = 'completed'
          session.current_question_id = None
          session.completed_at = datetime.now(tz=timezone.utc).isoformat()
        else:
          session.current_question_id = self._select_next(session, candidates, pending_event=event)
      self.repositories.progress.record(event, session)

      response = self._session_payload(session, candidates)
      response['grading'] = grading.model_dump()
      response['saved_answer'] = self._public_answer(event, candidate)
      response['answered_question'] = {
        **self._public_question(candidate, session.course_id, assessment_spec),
        'reference_answer': str(candidate['reference_answer'])[:12000],
      }
      return response

  def correct_reference_answer(
    self,
    session_id: str,
    question_id: str,
    request: CorrectReferenceAnswerRequest,
  ) -> dict[str, Any]:
    with self._lock:
      session = self._require_session(session_id)
      answered_ids = {
        event.question_id
        for event in self.repositories.events.for_session(session.course_id, session.id)
      }
      if question_id not in answered_ids:
        raise HTTPException(status_code=409, detail='提交本题答案后才能修正参考答案。')

      candidates, _ = self._candidates(session.course_id, session.lecture_document_id)
      candidate = next(
        (item for item in candidates if str(item.get('question_id') or '') == question_id),
        None,
      )
      if candidate is None:
        raise HTTPException(status_code=404, detail='没有找到该题目的原始数据。')

      saved = self.assessment_planner.save_user_correction(
        course_id=session.course_id,
        source_document_id=str(candidate.get('document_id') or ''),
        question_id=question_id,
        prompt=str(candidate.get('prompt') or ''),
        answer_text=request.answer_text,
        analysis=candidate.get('_analysis') if isinstance(candidate.get('_analysis'), dict) else {},
      )
      candidate['reference_answer'] = saved.answer_text
      self.assessment_preparation.schedule(session.course_id, candidate)
      payload = self._session_payload(session, candidates)
      payload['reference_answer_update'] = {
        'question_id': question_id,
        'source': saved.answer_source,
        'confidence': saved.confidence,
        'needs_review': saved.needs_review,
        'updated_at': saved.updated_at,
      }
      return payload

  def _assessment_spec(self, course_id: str, candidate: dict[str, Any]) -> AssessmentSpec:
    return self.assessment_planner.get_or_create(
      course_id=course_id,
      source_document_id=str(candidate.get('document_id') or ''),
      question_id=str(candidate.get('question_id') or ''),
      prompt=str(candidate.get('prompt') or ''),
      reference_answer=str(candidate.get('reference_answer') or ''),
      analysis=candidate.get('_analysis') if isinstance(candidate.get('_analysis'), dict) else {},
    )

  def _cached_assessment_spec(
    self,
    course_id: str,
    candidate: dict[str, Any],
  ) -> AssessmentSpec | None:
    return self.assessment_planner.get_cached(
      course_id=course_id,
      question_id=str(candidate.get('question_id') or ''),
      prompt=str(candidate.get('prompt') or ''),
      reference_answer=str(candidate.get('reference_answer') or ''),
      analysis=candidate.get('_analysis') if isinstance(candidate.get('_analysis'), dict) else {},
    )

  def _historical_assessment_spec(
    self,
    course_id: str,
    candidate: dict[str, Any],
    event: LearningEvent | None = None,
  ) -> AssessmentSpec | None:
    if event and event.assessment_spec_snapshot:
      try:
        return AssessmentSpec.model_validate(event.assessment_spec_snapshot)
      except ValidationError:
        pass
    return self.assessment_planner.get_latest_cached(
      course_id=course_id,
      question_id=str(candidate.get('question_id') or ''),
    )

  def _revision_assessment_spec(
    self,
    course_id: str,
    candidate: dict[str, Any],
    event: LearningEvent,
  ) -> AssessmentSpec | None:
    historical = self._historical_assessment_spec(course_id, candidate, event)
    current = self._cached_assessment_spec(course_id, candidate)
    if (
      historical is not None
      and current is not None
      and current.reference_answer_updated_at
      and current.reference_answer_updated_at != historical.reference_answer_updated_at
    ):
      return current
    return historical or current

  def _session_assessment_spec(
    self,
    session: AdaptiveTestSession,
    candidate: dict[str, Any],
    *,
    preferred: AssessmentSpec | None = None,
  ) -> AssessmentSpec | None:
    """Bind the exact private grading spec shown in one test session."""
    question_id = str(candidate.get('question_id') or '').strip()
    if not question_id:
      return None
    saved = self.store.get_session_assessment_spec(
      session.course_id,
      session.id,
      question_id,
    )
    if saved:
      try:
        bound = AssessmentSpec.model_validate(saved)
        # A user correction is the only supported reason to replace a spec that
        # has already been shown. Background policy/cache refreshes must not
        # change part ids while a test session is active.
        if (
          preferred is not None
          and preferred.reference_answer_updated_at
          and preferred.reference_answer_updated_at != bound.reference_answer_updated_at
        ):
          self.store.save_session_assessment_spec(
            session.course_id,
            session.id,
            question_id,
            preferred.model_dump(),
          )
          return preferred
        return bound
      except ValidationError:
        pass
    assessment = preferred or self._cached_assessment_spec(session.course_id, candidate)
    if assessment is None:
      return None
    self.store.save_session_assessment_spec(
      session.course_id,
      session.id,
      question_id,
      assessment.model_dump(),
    )
    return assessment

  def _assessment_identity(
    self,
    course_id: str,
    candidate: dict[str, Any],
  ) -> tuple[str, str, str]:
    question_id = str(candidate.get('question_id') or '')
    source_document_id = str(candidate.get('document_id') or '')
    fingerprint = self.assessment_planner.preparation_fingerprint(
      course_id=course_id,
      question_id=question_id,
      prompt=str(candidate.get('prompt') or ''),
      reference_answer=str(candidate.get('reference_answer') or ''),
      analysis=candidate.get('_analysis') if isinstance(candidate.get('_analysis'), dict) else {},
    )
    return question_id, source_document_id, fingerprint

  def queue_related_assessments(self, question_ids: set[str] | None = None) -> dict[str, int]:
    """Queue specs for related questions without waiting for any model request."""
    targets = self.candidate_provider.assessment_targets(question_ids)
    queued = ready = failed = 0
    seen: set[tuple[str, str]] = set()
    for target in targets:
      course_id = str(target.get('course_id') or '')
      question_id = str(target.get('question_id') or '')
      key = (course_id, question_id)
      if not course_id or not question_id or key in seen:
        continue
      seen.add(key)
      candidate = None
      for lecture_document_id in target.get('lecture_document_ids') or []:
        candidates, _ = self._candidates(course_id, str(lecture_document_id or ''))
        candidate = next(
          (item for item in candidates if str(item.get('question_id') or '') == question_id),
          None,
        )
        if candidate is not None:
          break
      if candidate is None:
        continue
      status = self.assessment_preparation.schedule(course_id, candidate)
      if status.state == 'ready':
        ready += 1
      elif status.state == 'failed':
        failed += 1
      else:
        queued += 1
    return {'queued': queued, 'ready': ready, 'failed': failed}

  def resume_assessment_preparations(self) -> dict[str, int]:
    interrupted = self.assessment_preparation.recover_interrupted()
    summary = self.queue_related_assessments()
    summary['interrupted'] = interrupted
    LOGGER.info(
      'assessment.prepare.resume queued=%s ready=%s failed=%s interrupted=%s',
      summary['queued'],
      summary['ready'],
      summary['failed'],
      interrupted,
    )
    return summary

  def cancel(self, session_id: str) -> dict[str, Any]:
    with self._lock:
      session = self._require_session(session_id)
      if session.status == 'active':
        session.status = 'cancelled'
        session.current_question_id = None
        session.completed_at = datetime.now(tz=timezone.utc).isoformat()
        self.repositories.sessions.save(session)
      return self._session_payload(session)

  def _require_session(self, session_id: str) -> AdaptiveTestSession:
    session = self.repositories.sessions.find(session_id)
    if not session:
      raise HTTPException(status_code=404, detail='Adaptive test session not found.')
    return session

  def _candidates(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> tuple[list[dict[str, Any]], int]:
    return self.candidate_provider.candidates(course_id, lecture_document_id)

  def _select_next(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    pending_event: LearningEvent | None = None,
  ) -> str | None:
    started_at = time.perf_counter()
    asked = set(session.asked_question_ids)
    remaining = [item for item in candidates if str(item['question_id']) not in asked]
    if not remaining:
      return None
    lecture_events = self.repositories.events.for_lecture(
      session.course_id,
      session.lecture_document_id,
    )
    candidate_concepts = {
      str(concept or '').strip()
      for candidate in candidates
      for concept in candidate.get('knowledge_points') or []
      if str(concept or '').strip()
    }
    external_evidence = [
      event for event in self.repositories.events.for_course(session.course_id)
      if event.source_type in {'self-submitted-homework', 'self-submitted-past-exam'}
      and candidate_concepts.intersection(event.knowledge_points)
    ]
    lecture_event_ids = {event.id for event in lecture_events}
    lecture_events.extend(event for event in external_evidence if event.id not in lecture_event_ids)
    question_history = self.repositories.events.question_history_for_lecture(
      session.course_id,
      session.lecture_document_id,
    )
    session_events = self.repositories.events.for_session(session.course_id, session.id)
    if pending_event is not None:
      lecture_events.append(pending_event)
      session_events.append(pending_event)
      question_history.setdefault(pending_event.question_id, []).append(pending_event)
    ranked = self.selection_strategy.rank(
      session,
      candidates,
      lecture_events,
      session_events,
      question_history,
    )
    for candidate in ranked:
      if self._cached_assessment_spec(session.course_id, candidate) is not None:
        self._prefetch_assessments(session, ranked, exclude={str(candidate['question_id'])})
        LOGGER.info(
          'adaptive.select.duration session=%s duration_ms=%.1f selected=%s',
          session.id,
          (time.perf_counter() - started_at) * 1000,
          candidate['question_id'],
        )
        return str(candidate['question_id'])
    self._prefetch_assessments(session, ranked)
    LOGGER.info(
      'adaptive.select.duration session=%s duration_ms=%.1f selected=none',
      session.id,
      (time.perf_counter() - started_at) * 1000,
    )
    return None

  def _prefetch_assessments(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    exclude: set[str] | None = None,
  ) -> None:
    excluded = (exclude or set()) | set(session.asked_question_ids)
    remaining_target = max(0, session.target_question_count - len(session.asked_question_ids))
    statuses: list[tuple[dict[str, Any], str]] = []
    for candidate in candidates:
      if str(candidate.get('question_id') or '') in excluded:
        continue
      state = self.assessment_preparation.status(session.course_id, candidate).state
      if state not in {'failed', 'needs_review'}:
        statuses.append((candidate, state))

    desired_buffer = min(len(statuses), remaining_target + 3)
    provisioned = sum(1 for _, state in statuses if state in {'ready', 'preparing'})
    if provisioned >= desired_buffer:
      return

    for candidate, state in statuses:
      if state != 'idle':
        continue
      self.assessment_preparation.schedule(session.course_id, candidate)
      provisioned += 1
      if provisioned >= desired_buffer:
        break

  def _refresh_candidate_pool(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
  ) -> list[dict[str, Any]]:
    """Remove permanently unavailable questions and close exhausted sessions."""
    candidate_by_id = {str(item.get('question_id') or ''): item for item in candidates}
    asked = set(session.asked_question_ids)
    retained_ids: list[str] = []
    for question_id in session.candidate_question_ids:
      if question_id in asked:
        retained_ids.append(question_id)
        continue
      candidate = candidate_by_id.get(question_id)
      if candidate is None:
        continue
      status = self.assessment_preparation.status(session.course_id, candidate)
      if status.state in {'failed', 'needs_review'}:
        continue
      retained_ids.append(question_id)

    changed = retained_ids != session.candidate_question_ids
    session.candidate_question_ids = retained_ids
    next_target = min(session.target_question_count, len(retained_ids))
    if next_target != session.target_question_count:
      session.target_question_count = next_target
      changed = True
    if session.current_question_id and session.current_question_id not in retained_ids:
      session.current_question_id = None
      changed = True

    answered_count = len(
      self.repositories.events.for_session(session.course_id, session.id)
    )
    if session.status == 'active' and answered_count >= session.target_question_count:
      session.status = 'completed'
      session.current_question_id = None
      session.completed_at = datetime.now(tz=timezone.utc).isoformat()
      changed = True
    if changed:
      self.repositories.sessions.save(session)

    allowed = set(retained_ids)
    return [
      candidate for candidate in candidates
      if str(candidate.get('question_id') or '') in allowed
    ]

  def _session_payload(
    self,
    session: AdaptiveTestSession | None,
    candidates: list[dict[str, Any]] | None = None,
  ) -> dict[str, Any]:
    if session is None:
      return {'session': None}
    if candidates is None:
      candidates, _ = self._candidates(session.course_id, session.lecture_document_id)
    candidates = self._refresh_candidate_pool(session, candidates)
    allowed_question_ids = set(session.candidate_question_ids)
    candidates = [
      candidate for candidate in candidates
      if str(candidate.get('question_id') or '') in allowed_question_ids
    ]
    candidate_by_id = {str(item['question_id']): item for item in candidates}
    if session.status == 'active':
      current = candidate_by_id.get(session.current_question_id or '')
      if session.current_question_id and current is None:
        session.candidate_question_ids = [
          question_id for question_id in session.candidate_question_ids
          if question_id != session.current_question_id
        ]
        session.target_question_count = min(
          session.target_question_count,
          max(1, len(session.candidate_question_ids)),
        )
        session.current_question_id = None
      current_ready = bool(current and self._session_assessment_spec(session, current) is not None)
      if not current_ready:
        session.current_question_id = self._select_next(session, candidates)
        self.repositories.sessions.save(session)
        allowed_question_ids = set(session.candidate_question_ids)
        candidates = [
          candidate for candidate in candidates
          if str(candidate.get('question_id') or '') in allowed_question_ids
        ]
        candidate_by_id = {str(item['question_id']): item for item in candidates}
    events = self.repositories.events.for_session(session.course_id, session.id)
    events_by_question = {event.question_id: event for event in events}
    unlocked_ids = list(dict.fromkeys([
      *session.asked_question_ids,
      *([session.current_question_id] if session.current_question_id else []),
    ]))
    assessments_by_question: dict[str, AssessmentSpec] = {}
    for question_id in unlocked_ids:
      candidate = candidate_by_id.get(question_id)
      if candidate is None:
        continue
      event = events_by_question.get(question_id)
      preferred = (
        self._revision_assessment_spec(session.course_id, candidate, event)
        if event is not None else self._cached_assessment_spec(session.course_id, candidate)
      )
      assessment = self._session_assessment_spec(
        session,
        candidate,
        preferred=preferred,
      )
      if assessment is not None:
        assessments_by_question[question_id] = assessment
    payload: dict[str, Any] = {
      'session': session.model_dump(),
      'progress': {
        'answered': len(events),
        'target': session.target_question_count,
        'correct': sum(1 for event in events if event.correct),
      },
      'current_question': self._public_question(
        candidate_by_id[session.current_question_id],
        session.course_id,
        assessments_by_question[session.current_question_id],
      )
      if (
        session.current_question_id in candidate_by_id
        and session.current_question_id in assessments_by_question
      ) else None,
      'questions': [
        self._public_question(
          candidate_by_id[question_id],
          session.course_id,
          assessments_by_question[question_id],
        )
        for question_id in unlocked_ids
        if question_id in candidate_by_id and question_id in assessments_by_question
      ],
      'answers': [
        self._public_answer(event, candidate_by_id.get(event.question_id))
        for event in events
      ],
      'preparation': self._preparation_payload(session, candidates),
    }
    if session.status == 'completed':
      payload['result'] = self._result(session, candidates, events)
    return payload

  def _result(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    session_events: list[LearningEvent],
  ) -> dict[str, Any]:
    lecture_events = self.repositories.events.for_lecture(
      session.course_id,
      session.lecture_document_id,
    )
    return self.result_assembler.assemble(
      session,
      candidates,
      session_events,
      lecture_events,
    )

  @staticmethod
  def _recommended_pages(candidates: list[dict[str, Any]], weak: list[Any]) -> list[dict[str, Any]]:
    return AdaptiveTestResultAssembler.recommended_pages(candidates, weak)

  def _public_question(
    self,
    candidate: dict[str, Any],
    course_id: str,
    assessment: AssessmentSpec | None = None,
  ) -> dict[str, Any]:
    assessment = assessment or self._cached_assessment_spec(course_id, candidate)
    if assessment is None:
      raise HTTPException(status_code=409, detail='本题作答结构正在准备中，请稍后刷新。')
    candidate['reference_answer'] = assessment.reference_answer
    return {
      'question_id': str(candidate.get('question_id') or ''),
      'source_type': str(candidate.get('source_type') or ''),
      'source_document_id': str(candidate.get('document_id') or ''),
      'source_document_name': str(candidate.get('document_name') or ''),
      'source_page_number': candidate.get('page_number'),
      'title': str(candidate.get('title') or ''),
      'prompt': str(candidate.get('prompt') or ''),
      'difficulty': int(candidate.get('difficulty') or 1),
      'knowledge_points': list(candidate.get('knowledge_points') or []),
      'images': list(candidate.get('images') or []),
      'assessment_spec': assessment.public_payload(),
    }

  def _preparation_payload(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
  ) -> dict[str, Any]:
    asked = set(session.asked_question_ids)
    remaining = [
      candidate for candidate in candidates
      if str(candidate.get('question_id') or '') not in asked
    ]
    statuses = [
      self.assessment_preparation.status(session.course_id, candidate)
      for candidate in remaining
    ]
    ready = sum(status.state == 'ready' for status in statuses)
    preparing = sum(status.state == 'preparing' for status in statuses)
    failed = [status.error for status in statuses if status.state == 'failed']
    state = 'ready' if session.current_question_id or session.status == 'completed' else 'preparing'
    if not session.current_question_id and failed and not ready and not preparing:
      state = 'failed'
    return {
      'state': state,
      'ready_count': ready,
      'preparing_count': preparing,
      'failed_count': len(failed),
      'message': failed[0] if state == 'failed' else '',
    }

  def retry_preparation(self, session_id: str) -> dict[str, Any]:
    with self._lock:
      session = self._require_session(session_id)
      candidates, _ = self._candidates(session.course_id, session.lecture_document_id)
      asked = set(session.asked_question_ids)
      retried = 0
      for candidate in candidates:
        if str(candidate.get('question_id') or '') in asked:
          continue
        if self.assessment_preparation.status(session.course_id, candidate).state == 'failed':
          self.assessment_preparation.retry(session.course_id, candidate)
          retried += 1
          if retried >= 3:
            break
      if not session.current_question_id:
        session.current_question_id = self._select_next(session, candidates)
        self.repositories.sessions.save(session)
      return self._session_payload(session, candidates)

  def close(self) -> None:
    self.assessment_preparation.close()

  @staticmethod
  def _public_answer(event: LearningEvent, candidate: dict[str, Any] | None) -> dict[str, Any]:
    return {
      'event_id': event.id,
      'question_id': event.question_id,
      'response_text': event.response_text,
      'responses': event.structured_responses,
      'part_grading_results': event.part_grading_results,
      'score': event.score,
      'correct': event.correct,
      'confidence': event.grading_confidence,
      'feedback': event.grading_feedback,
      'method': event.grading_method,
      'revision': event.revision,
      'reference_answer': str((candidate or {}).get('reference_answer') or '')[:12000],
      'updated_at': event.created_at,
    }


_store = LearningStateStore()
_service: AdaptiveTestingService | None = None


def configure_adaptive_testing(relation_pipeline: RelationQuestionQuery | None) -> None:
  global _service
  if _service is not None:
    _service.close()
  _service = AdaptiveTestingService(relation_pipeline, store=_store) if relation_pipeline else None


def delete_learning_document(course_id: str, document_id: str) -> None:
  if not str(course_id or '').strip() or not str(document_id or '').strip():
    return
  _store.delete_document(course_id, document_id)


def delete_learning_course(course_id: str) -> None:
  if not str(course_id or '').strip():
    return
  _store.delete_course(course_id)


def queue_related_assessment_preparations(
  question_ids: set[str] | None = None,
) -> dict[str, int]:
  return _get_service().queue_related_assessments(question_ids)


def resume_assessment_preparations() -> dict[str, int]:
  return _get_service().resume_assessment_preparations()


def _get_service() -> AdaptiveTestingService:
  if _service is None:
    raise HTTPException(status_code=503, detail='Adaptive testing service is not initialized.')
  return _service


@adaptive_testing_router.post('')
async def start_adaptive_test(request: StartAdaptiveTestRequest = Body(...)) -> dict[str, Any]:
  return await asyncio.to_thread(_get_service().start, request)


@adaptive_testing_router.get('/active')
async def get_active_adaptive_test(
  course_id: str = Query(..., min_length=1),
  lecture_document_id: str = Query(..., min_length=1),
) -> dict[str, Any]:
  return await asyncio.to_thread(_get_service().active, course_id, lecture_document_id)


@adaptive_testing_router.get('/question-assets/{document_id}/{image_id}', response_class=FileResponse)
async def read_question_image(document_id: str, image_id: str) -> FileResponse:
  image_path = await asyncio.to_thread(resolve_question_image_asset, document_id, image_id)
  return FileResponse(image_path)


@adaptive_testing_router.get('/{session_id}')
async def get_adaptive_test(session_id: str) -> dict[str, Any]:
  return await asyncio.to_thread(_get_service().get, session_id)


@adaptive_testing_router.post('/{session_id}/answers')
async def submit_adaptive_test_answer(
  session_id: str,
  request: SubmitAdaptiveAnswerRequest = Body(...),
) -> dict[str, Any]:
  return await asyncio.to_thread(_get_service().submit, session_id, request)


@adaptive_testing_router.post('/{session_id}/preparation/retry')
async def retry_adaptive_test_preparation(session_id: str) -> dict[str, Any]:
  return await asyncio.to_thread(_get_service().retry_preparation, session_id)


@adaptive_testing_router.put('/{session_id}/questions/{question_id}/reference-answer')
async def correct_adaptive_test_reference_answer(
  session_id: str,
  question_id: str,
  request: CorrectReferenceAnswerRequest = Body(...),
) -> dict[str, Any]:
  return await asyncio.to_thread(
    _get_service().correct_reference_answer,
    session_id,
    question_id,
    request,
  )


@adaptive_testing_router.delete('/{session_id}')
async def cancel_adaptive_test(session_id: str) -> dict[str, Any]:
  return await asyncio.to_thread(_get_service().cancel, session_id)
