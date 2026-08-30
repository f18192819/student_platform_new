from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Protocol

import requests
from fastapi import APIRouter, Body, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .assessment_planner import AssessmentPart, AssessmentPlanner, AssessmentSpec
from .assessment_preparation import AssessmentPreparationCoordinator
from .learning_state import (
  AdaptiveTestSession,
  LearningEvent,
  LearningStateStore,
  aggregate_mastery,
  project_concept_mastery,
)
from .question_pipeline import QuestionAnalyzer, question_image_attachments, resolve_question_image_asset
from .question_relations import QuestionRelationPipeline
from .runtime_config import load_api_config

adaptive_testing_router = APIRouter(prefix='/api/adaptive-tests', tags=['adaptive-testing'])
LOGGER = logging.getLogger(__name__)
_REFERENCE_MARKER = re.compile(
  r'(?im)^\s*(?:\d{2,8}\s*)?(?:参考答案|标准答案|解答|答案|解析|solution|answer)\s*[:：]\s*'
)
_SEGMENT_ID_LINE = re.compile(r'(?m)^\s*\d{3,8}\s*$')
_SUPPORTED_SOURCE_TYPES = {
  'homework',
  'past-exam',
  'exercise-set',
  'lecture-example',
  'classroom-example',
}


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


class GradingResult(BaseModel):
  model_config = ConfigDict(extra='forbid')
  score: float = Field(ge=0.0, le=1.0)
  correct: bool
  confidence: float = Field(ge=0.0, le=1.0)
  feedback: str = Field(max_length=1200)
  method: str = Field(max_length=80)


class PartGradingResult(BaseModel):
  model_config = ConfigDict(extra='forbid')
  part_id: str
  type: str
  score: float = Field(ge=0.0, le=1.0)
  correct: bool
  confidence: float = Field(ge=0.0, le=1.0)
  feedback: str = Field(max_length=1200)
  method: str = Field(max_length=80)


class StructuredGradingResult(GradingResult):
  parts: list[PartGradingResult] = Field(default_factory=list)


class QuestionGrader(Protocol):
  def grade(self, candidate: dict[str, Any], answer: str) -> GradingResult: ...

  def grade_text(self, prompt: str, reference: str, answer: str) -> GradingResult: ...


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


class ConfiguredQuestionGrader:
  """Grades subjective answers only; mastery projection remains deterministic code."""

  def grade(self, candidate: dict[str, Any], answer: str) -> GradingResult:
    method = str(candidate.get('grading_method') or '')
    reference = str(candidate.get('reference_answer') or '').strip()
    if method == 'exact_answer':
      expected = self._normalize_exact(reference)
      submitted = self._normalize_exact(answer)
      correct = bool(expected and submitted == expected)
      return GradingResult(
        score=1.0 if correct else 0.0,
        correct=correct,
        confidence=1.0,
        feedback='答案匹配。' if correct else '答案与现有标准答案不一致。',
        method='exact_answer',
      )
    if method != 'llm_reference' or not reference:
      raise HTTPException(status_code=422, detail='This question does not have a reliable grading reference.')

    return self.grade_text(str(candidate.get('prompt') or ''), reference, answer)

  def grade_text(self, prompt: str, reference: str, answer: str) -> GradingResult:
    if not reference.strip():
      raise HTTPException(status_code=422, detail='This assessment part has no grading reference.')

    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      raise HTTPException(status_code=422, detail='Text model configuration is required for subjective grading.')
    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = GradingResult.model_json_schema()
    payload = {
      'model': model,
      'temperature': 0.0,
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'question_grading', 'strict': True, 'schema': schema},
      },
      'messages': [
        {
          'role': 'system',
          'content': (
            '你是严格但允许等价推导和部分分的课程题目评分器。只比较学生答案与题目、参考解答，'
            '不得因为措辞或推导顺序不同而扣分；关键公式、结论或思路正确即可给相应分数。'
            'score 为 0 到 1，confidence 表示评分把握。correct 先按 score >= 0.75 返回。'
            '反馈应简短指出正确部分或首个关键缺失。只返回符合 JSON Schema 的对象。'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps({
            'question': prompt,
            'reference_answer': reference[:16000],
            'student_answer': answer,
            'json_schema': schema,
          }, ensure_ascii=False),
        },
      ],
    }
    try:
      response = requests.post(
        f'{root}/chat/completions',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        json=payload,
        timeout=90,
      )
      if response.status_code >= 400:
        fallback = {**payload, 'response_format': {'type': 'json_object'}}
        response = requests.post(
          f'{root}/chat/completions',
          headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
          json=fallback,
          timeout=90,
        )
      response.raise_for_status()
      content = response.json()['choices'][0]['message']['content']
      grading = GradingResult.model_validate(QuestionAnalyzer._extract_json_object(str(content)))
    except (requests.RequestException, KeyError, TypeError, ValueError, ValidationError) as exc:
      raise HTTPException(status_code=502, detail=f'Text model grading failed: {exc}') from exc
    # One stable threshold keeps the mastery algorithm independent of provider wording.
    grading.correct = grading.score >= 0.75
    grading.method = 'llm_reference'
    return grading

  @staticmethod
  def _normalize_exact(value: str) -> str:
    return re.sub(r'[\s,，。.;；:：]', '', value).casefold()


class AdaptiveTestingService:
  def __init__(
    self,
    relation_pipeline: QuestionRelationPipeline,
    store: LearningStateStore | None = None,
    grader: QuestionGrader | None = None,
  ) -> None:
    self.relation_pipeline = relation_pipeline
    self.store = store or LearningStateStore()
    self.grader = grader or ConfiguredQuestionGrader()
    self.assessment_planner = AssessmentPlanner(self.store)
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
      existing = self.store.find_active(request.course_id, request.lecture_document_id)
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
      self.store.create_session(session)
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
    session = self.store.find_active(course_id, lecture_document_id)
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
        for event in self.store.effective_session_events(session.course_id, session.id)
      }
      previous_event = previous_by_question.get(question_id)
      is_revision = previous_event is not None
      if not is_revision and (session.status != 'active' or question_id != session.current_question_id):
        raise HTTPException(status_code=409, detail='Only the current adaptive question can be answered for the first time.')

      assessment_spec = self._cached_assessment_spec(session.course_id, candidate)
      if assessment_spec is None and previous_event is not None:
        assessment_spec = self._historical_assessment_spec(
          session.course_id,
          candidate,
          previous_event,
        )
      if assessment_spec is None:
        raise HTTPException(status_code=409, detail='本题作答结构尚未准备完成，请稍后重试。')
      candidate['reference_answer'] = assessment_spec.reference_answer
      grading, structured_responses, response_text = self._grade_submission(
        candidate,
        assessment_spec,
        request,
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
      self.store.record_answer(event, session)

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
        for event in self.store.effective_session_events(session.course_id, session.id)
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

  def _grade_submission(
    self,
    candidate: dict[str, Any],
    assessment_spec: AssessmentSpec,
    request: SubmitAdaptiveAnswerRequest,
  ) -> tuple[StructuredGradingResult, list[dict[str, str]], str]:
    if not request.responses:
      legacy_answer = str(request.answer or '').strip()
      legacy = self.grader.grade(candidate, legacy_answer)
      return (
        StructuredGradingResult(**legacy.model_dump(), parts=[]),
        [],
        legacy_answer,
      )

    response_by_id = {
      response.part_id: response.value.strip()
      for response in request.responses
      if response.value.strip()
    }
    required_ids = {part.id for part in assessment_spec.parts if part.required}
    if not required_ids.issubset(response_by_id):
      missing = ', '.join(sorted(required_ids - set(response_by_id)))
      raise HTTPException(status_code=422, detail=f'Required assessment parts are missing: {missing}')
    if set(response_by_id) - {part.id for part in assessment_spec.parts}:
      raise HTTPException(status_code=422, detail='The submission contains an unknown assessment part.')

    part_results: list[PartGradingResult] = []
    for part in assessment_spec.parts:
      value = response_by_id.get(part.id, '')
      if not value and not part.required:
        continue
      part_results.append(self._grade_part(candidate, part, value))

    weighted_score = sum(
      result.score * next(part.weight for part in assessment_spec.parts if part.id == result.part_id)
      for result in part_results
    )
    weighted_confidence = sum(
      result.confidence * next(part.weight for part in assessment_spec.parts if part.id == result.part_id)
      for result in part_results
    )
    score = round(max(0.0, min(weighted_score, 1.0)), 4)
    confidence = round(max(0.0, min(weighted_confidence, 1.0)), 4)
    correct = score >= 0.75
    feedback = '；'.join(
      f'{result.part_id}: {result.feedback}' for result in part_results if result.feedback
    )[:1200]
    responses = [
      {'part_id': part.id, 'value': response_by_id.get(part.id, '')}
      for part in assessment_spec.parts
      if part.id in response_by_id
    ]
    response_text = '\n'.join(
      f'{item["part_id"]}: {item["value"]}' for item in responses
    )
    return (
      StructuredGradingResult(
        score=score,
        correct=correct,
        confidence=confidence,
        feedback=feedback,
        method='structured_parts',
        parts=part_results,
      ),
      responses,
      response_text,
    )

  def _grade_part(
    self,
    candidate: dict[str, Any],
    part: AssessmentPart,
    value: str,
  ) -> PartGradingResult:
    if part.type == 'choice':
      correct = bool(part.correct_option_id and value == part.correct_option_id)
      return PartGradingResult(
        part_id=part.id,
        type=part.type,
        score=1.0 if correct else 0.0,
        correct=correct,
        confidence=1.0,
        feedback='选择正确。' if correct else '选择错误。',
        method='choice_exact',
      )
    if part.type == 'numeric':
      submitted = AssessmentPlanner.parse_numeric(value)
      expected = AssessmentPlanner.parse_numeric(str(part.expected_value or ''))
      correct = False
      if submitted is not None and expected is not None:
        tolerance = Decimal(str(part.tolerance or 0.0))
        allowed_error = max(tolerance, abs(expected) * tolerance)
        correct = abs(submitted - expected) <= allowed_error
      return PartGradingResult(
        part_id=part.id,
        type=part.type,
        score=1.0 if correct else 0.0,
        correct=correct,
        confidence=1.0,
        feedback='数值正确。' if correct else '数值不正确或格式无法识别。',
        method='numeric_tolerance',
      )

    grading = self.grader.grade_text(
      f'{candidate.get("prompt") or ""}\n\n当前作答部分：{part.prompt}',
      part.reference_answer,
      value,
    )
    return PartGradingResult(
      part_id=part.id,
      type=part.type,
      score=grading.score,
      correct=grading.correct,
      confidence=grading.confidence,
      feedback=grading.feedback,
      method='llm_reference',
    )

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
    targets = self.relation_pipeline.assessment_relation_targets(question_ids)
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
        self.store.save_session(session)
      return self._session_payload(session)

  def _require_session(self, session_id: str) -> AdaptiveTestSession:
    session = self.store.find_session(session_id)
    if not session:
      raise HTTPException(status_code=404, detail='Adaptive test session not found.')
    return session

  def _candidates(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> tuple[list[dict[str, Any]], int]:
    related = self.relation_pipeline.lecture_document_questions(course_id, lecture_document_id)
    candidates: list[dict[str, Any]] = []
    skipped = 0
    for question in related.get('questions') or []:
      document_type = str(question.get('document_type') or '')
      if document_type not in _SUPPORTED_SOURCE_TYPES:
        continue
      analysis = question.get('analysis') if isinstance(question.get('analysis'), dict) else {}
      concepts = list(dict.fromkeys(
        str(value or '').strip()
        for value in analysis.get('knowledge_points') or []
        if str(value or '').strip()
      ))
      difficulty_payload = analysis.get('difficulty') if isinstance(analysis.get('difficulty'), dict) else {}
      difficulty = max(1, min(5, int(difficulty_payload.get('level') or 1)))
      prompt, reference_answer, grading_method = split_question_material(question)
      saved_reference = self.assessment_planner.saved_reference_answer(
        course_id,
        str(question.get('question_id') or ''),
      )
      if saved_reference:
        reference_answer = saved_reference.answer_text
        grading_method = 'llm_reference'
      if not prompt or not concepts:
        skipped += 1
        continue
      relations = []
      for relation in question.get('lecture_relations') or []:
        if not isinstance(relation, dict) or relation.get('relation_type') != 'question_to_lecture_page':
          continue
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        if str(target.get('document_id') or '') != lecture_document_id:
          continue
        if int(target.get('page_number') or 0) <= 0:
          continue
        target_course_id = str(target.get('course_id') or '').strip()
        if target_course_id and target_course_id != course_id:
          continue
        relations.append(relation)
      if not relations:
        skipped += 1
        continue
      candidates.append({
        **question,
        '_analysis': analysis,
        'prompt': prompt,
        'reference_answer': reference_answer,
        'grading_method': grading_method,
        'knowledge_points': concepts,
        'difficulty': difficulty,
        'source_type': (
          'lecture_example'
          if document_type in {'lecture-example', 'classroom-example'}
          else 'past-exam' if document_type == 'past-exam' else 'homework'
        ),
        'images': question_image_attachments(
          str(question.get('document_id') or ''),
          question,
          prompt,
        ),
        'lecture_relations': relations,
        'relation_score': max(
          (float(item.get('rerank_score') or item.get('vector_score') or 0.0) for item in relations),
          default=0.0,
        ),
      })
    return candidates, skipped

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
    lecture_events = self.store.effective_lecture_events(session.course_id, session.lecture_document_id)
    session_events = self.store.effective_session_events(session.course_id, session.id)
    if pending_event is not None:
      lecture_events.append(pending_event)
      session_events.append(pending_event)
    all_concepts = [
      concept for candidate in candidates for concept in candidate['knowledge_points']
    ]
    projections = {
      item.knowledge_point: item
      for item in project_concept_mastery(lecture_events, list(dict.fromkeys(all_concepts)))
    }
    covered = Counter(
      concept for event in session_events for concept in event.knowledge_points
    )
    wrong = Counter(
      concept for event in session_events if not event.correct for concept in event.knowledge_points
    )
    used_difficulties = Counter(event.difficulty for event in session_events)

    def priority(candidate: dict[str, Any]) -> tuple[float, str]:
      concepts = candidate['knowledge_points']
      uncovered_ratio = sum(1 for concept in concepts if covered[concept] == 0) / len(concepts)
      wrong_ratio = sum(wrong[concept] for concept in concepts) / len(concepts)
      mastery_gap = sum(1.0 - projections[concept].mastery for concept in concepts) / len(concepts)
      confident_streak = sum(
        1 for concept in concepts
        if projections[concept].correct_streak >= 2 and projections[concept].confidence >= 0.45
      ) / len(concepts)
      difficulty_bonus = 0.6 if used_difficulties[int(candidate['difficulty'])] == 0 else 0.0
      breadth_bonus = min(len(concepts), 6) * 0.05
      relation_bonus = min(max(float(candidate['relation_score']), 0.0), 1.0) * 0.25
      score = (
        (4.0 * uncovered_ratio)
        + (3.0 * wrong_ratio)
        + (2.0 * mastery_gap)
        + difficulty_bonus
        + breadth_bonus
        + relation_bonus
        - (1.5 * confident_streak)
      )
      return score, str(candidate['question_id'])

    ranked = sorted(remaining, key=priority, reverse=True)
    for candidate in ranked:
      if self._cached_assessment_spec(session.course_id, candidate) is not None:
        self._prefetch_assessments(session.course_id, ranked, exclude={str(candidate['question_id'])})
        LOGGER.info(
          'adaptive.select.duration session=%s duration_ms=%.1f selected=%s',
          session.id,
          (time.perf_counter() - started_at) * 1000,
          candidate['question_id'],
        )
        return str(candidate['question_id'])
    self._prefetch_assessments(session.course_id, ranked)
    LOGGER.info(
      'adaptive.select.duration session=%s duration_ms=%.1f selected=none',
      session.id,
      (time.perf_counter() - started_at) * 1000,
    )
    return None

  def _prefetch_assessments(
    self,
    course_id: str,
    candidates: list[dict[str, Any]],
    exclude: set[str] | None = None,
  ) -> None:
    excluded = exclude or set()
    scheduled = 0
    for candidate in candidates:
      if str(candidate.get('question_id') or '') in excluded:
        continue
      status = self.assessment_preparation.status(course_id, candidate)
      if status.state in {'ready', 'failed'}:
        continue
      self.assessment_preparation.schedule(course_id, candidate)
      scheduled += 1
      if scheduled >= 3:
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
      self.store.effective_session_events(session.course_id, session.id)
    )
    if session.status == 'active' and answered_count >= session.target_question_count:
      session.status = 'completed'
      session.current_question_id = None
      session.completed_at = datetime.now(tz=timezone.utc).isoformat()
      changed = True
    if changed:
      self.store.save_session(session)

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
      current_ready = bool(
        current and self._cached_assessment_spec(session.course_id, current) is not None
      )
      if not current_ready:
        session.current_question_id = self._select_next(session, candidates)
        self.store.save_session(session)
        allowed_question_ids = set(session.candidate_question_ids)
        candidates = [
          candidate for candidate in candidates
          if str(candidate.get('question_id') or '') in allowed_question_ids
        ]
        candidate_by_id = {str(item['question_id']): item for item in candidates}
    events = self.store.effective_session_events(session.course_id, session.id)
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
      assessment = (
        self._historical_assessment_spec(session.course_id, candidate, event)
        if event is not None
        else self._cached_assessment_spec(session.course_id, candidate)
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
      )
      if (
        session.current_question_id in candidate_by_id
        and self._cached_assessment_spec(
          session.course_id,
          candidate_by_id[session.current_question_id],
        ) is not None
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
    lecture_events = self.store.effective_lecture_events(session.course_id, session.lecture_document_id)
    all_concepts = list(dict.fromkeys(
      concept for candidate in candidates for concept in candidate['knowledge_points']
    ))
    concepts = project_concept_mastery(lecture_events, all_concepts)
    overall, confidence = aggregate_mastery(concepts)
    weak = [
      concept for concept in concepts
      if concept.mastery < 0.7 or concept.evidence_count == 0
    ]
    candidate_by_id = {str(item['question_id']): item for item in candidates}
    wrong_questions = []
    for event in session_events:
      if event.correct:
        continue
      candidate = candidate_by_id.get(event.question_id)
      wrong_questions.append({
        'question_id': event.question_id,
        'source_type': event.source_type,
        'source_document_id': event.source_document_id,
        'title': str((candidate or {}).get('title') or ''),
        'page_number': (candidate or {}).get('page_number'),
        'score': event.score,
        'answer': event.response_text,
        'structured_responses': event.structured_responses,
        'part_grading_results': event.part_grading_results,
        'feedback': event.grading_feedback,
        'reference_answer': str((candidate or {}).get('reference_answer') or '')[:12000],
        'images': list((candidate or {}).get('images') or []),
      })
    return {
      'overall_mastery': overall,
      'confidence': confidence,
      'questions_answered': len(session_events),
      'questions_correct': sum(1 for event in session_events if event.correct),
      'concept_mastery': [item.model_dump() for item in concepts],
      'weak_concepts': [item.model_dump() for item in weak],
      'wrong_questions': wrong_questions,
      'recommended_pages': self._recommended_pages(candidates, weak),
      'mastery_scope': 'lecture_history',
    }

  @staticmethod
  def _recommended_pages(candidates: list[dict[str, Any]], weak: list[Any]) -> list[dict[str, Any]]:
    weak_by_name = {item.knowledge_point: item for item in weak}
    pages: dict[tuple[str, int], dict[str, Any]] = {}
    for candidate in candidates:
      matched_concepts = [
        concept for concept in candidate['knowledge_points'] if concept in weak_by_name
      ]
      if not matched_concepts:
        continue
      for relation in candidate['lecture_relations']:
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        document_id = str(target.get('document_id') or '')
        page_number = int(target.get('page_number') or 0)
        if not document_id or page_number <= 0:
          continue
        key = (document_id, page_number)
        score = float(relation.get('rerank_score') or relation.get('vector_score') or 0.0)
        existing = pages.setdefault(key, {
          'document_id': document_id,
          'document_name': str(target.get('document_name') or ''),
          'page_id': str(target.get('page_id') or ''),
          'page_number': page_number,
          'title': str(target.get('title') or ''),
          'knowledge_points': [],
          'relation_score': score,
        })
        existing['knowledge_points'] = list(dict.fromkeys(existing['knowledge_points'] + matched_concepts))
        existing['relation_score'] = max(existing['relation_score'], score)
    ranked = list(pages.values())
    ranked.sort(key=lambda item: (
      min(weak_by_name[name].mastery for name in item['knowledge_points']),
      -float(item['relation_score']),
      int(item['page_number']),
    ))
    return ranked[:10]

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
        self.store.save_session(session)
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


def configure_adaptive_testing(relation_pipeline: QuestionRelationPipeline | None) -> None:
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

