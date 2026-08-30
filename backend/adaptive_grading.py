from __future__ import annotations

import json
import re
from decimal import Decimal
from typing import Any, Protocol

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError
import requests

from .assessment_planner import AssessmentPart, AssessmentPlanner, AssessmentSpec
from .question_pipeline import extract_json_object
from .runtime_config import load_api_config


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
      grading = GradingResult.model_validate(extract_json_object(str(content)))
    except (requests.RequestException, KeyError, TypeError, ValueError, ValidationError) as exc:
      raise HTTPException(status_code=502, detail=f'Text model grading failed: {exc}') from exc
    # One stable threshold keeps the mastery algorithm independent of provider wording.
    grading.correct = grading.score >= 0.75
    grading.method = 'llm_reference'
    return grading

  @staticmethod
  def _normalize_exact(value: str) -> str:
    return re.sub(r'[\s,，。.;；:：]', '', value).casefold()




class PartGrader(Protocol):
  def grade(
    self,
    candidate: dict[str, Any],
    assessment_spec: AssessmentSpec,
    responses: list[dict[str, str]],
    legacy_answer: str,
  ) -> tuple[StructuredGradingResult, list[dict[str, str]], str]: ...


class StructuredPartGrader:
  """Uses deterministic grading for objective parts and AI only for text parts."""

  def __init__(self, subjective_grader: QuestionGrader) -> None:
    self.subjective_grader = subjective_grader

  def grade(
    self,
    candidate: dict[str, Any],
    assessment_spec: AssessmentSpec,
    responses: list[dict[str, str]],
    legacy_answer: str,
  ) -> tuple[StructuredGradingResult, list[dict[str, str]], str]:
    if not responses:
      legacy = self.subjective_grader.grade(candidate, legacy_answer)
      return StructuredGradingResult(**legacy.model_dump(), parts=[]), [], legacy_answer

    response_by_id = {
      str(response.get('part_id') or ''): str(response.get('value') or '').strip()
      for response in responses
      if str(response.get('value') or '').strip()
    }
    required_ids = {part.id for part in assessment_spec.parts if part.required}
    if not required_ids.issubset(response_by_id):
      missing = ', '.join(sorted(required_ids - set(response_by_id)))
      raise HTTPException(status_code=422, detail=f'Required assessment parts are missing: {missing}')
    if set(response_by_id) - {part.id for part in assessment_spec.parts}:
      raise HTTPException(status_code=422, detail='The submission contains an unknown assessment part.')

    part_results = [
      self.grade_part(candidate, part, response_by_id.get(part.id, ''))
      for part in assessment_spec.parts
      if response_by_id.get(part.id, '') or part.required
    ]
    part_by_id = {part.id: part for part in assessment_spec.parts}
    weighted_score = sum(result.score * part_by_id[result.part_id].weight for result in part_results)
    weighted_confidence = sum(
      result.confidence * part_by_id[result.part_id].weight for result in part_results
    )
    score = round(max(0.0, min(weighted_score, 1.0)), 4)
    confidence = round(max(0.0, min(weighted_confidence, 1.0)), 4)
    normalized_responses = [
      {'part_id': part.id, 'value': response_by_id[part.id]}
      for part in assessment_spec.parts
      if part.id in response_by_id
    ]
    response_text = '\n'.join(
      f'{item["part_id"]}: {item["value"]}' for item in normalized_responses
    )
    return (
      StructuredGradingResult(
        score=score,
        correct=score >= 0.75,
        confidence=confidence,
        feedback='；'.join(
          f'{result.part_id}: {result.feedback}' for result in part_results if result.feedback
        )[:1200],
        method='structured_parts',
        parts=part_results,
      ),
      normalized_responses,
      response_text,
    )

  def grade_part(
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
    grading = self.subjective_grader.grade_text(
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
