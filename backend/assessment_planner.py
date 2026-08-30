from __future__ import annotations

import hashlib
import json
import random
import re
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from typing import Any, Literal

import requests
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .learning_state import LearningStateStore, QuestionReferenceAnswer
from .question_pipeline import QuestionAnalyzer
from .runtime_config import load_api_config

DEFAULT_NUMERIC_TOLERANCE = 1e-6
ASSESSMENT_POLICY_VERSION = 'objective-answer-choice-v7'
_NUMBER = re.compile(r'^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$')
_FRACTION = re.compile(r'^([+-]?\d+)\s*/\s*([+-]?\d+)$')
_LATEX_FRACTION = re.compile(r'^\\frac\s*\{([+-]?\d+)\}\s*\{([+-]?\d+)\}$')
_MATH_SIGNAL = re.compile(
  r'(?:\\(?:frac|dfrac|tfrac|sqrt|sum|prod|int|oint|lim|begin|det|lambda|omega|alpha|beta|gamma|delta|'
  r'theta|partial|nabla|vec|mathbf|mathrm|operatorname|sin|cos|tan|log|ln|exp)|'
  r'[=^_+\-*/×÷±]|[A-Za-z]\s*[({]|\d\s*[A-Za-z])'
)
_TEXT_TASK_SIGNAL = re.compile(r'(?:说明|解释|证明|为什么|理由|原理|论证|justify|explain|prove)', re.I)
_OBJECTIVE_TASK_SIGNAL = re.compile(
  r'(?:求|求出|求得|求解|计算|写出|给出|列出|确定|化简|解出|判断|选择|比较|指出|填写|'
  r'为多少|是多少|等于多少)',
  re.I,
)
_SYMBOLIC_TASK_SIGNAL = re.compile(
  r'(?:求|写出|给出|计算|确定|化简|解出|得到).{0,80}'
  r'(?:表达式|公式|方程|函数|波函数|矩阵|行列式|特征值|特征向量|极限|导数|积分|'
  r'电场(?:强度)?|磁场|磁感应强度|场强|电势|电压|电流|功率|频率|角频率|波数|'
  r'动量|能量|力|速度|加速度|概率|分布)',
  re.I,
)


def _now() -> str:
  return datetime.now(tz=timezone.utc).isoformat()


class AssessmentOption(BaseModel):
  model_config = ConfigDict(extra='forbid')
  id: str
  content: str


class AssessmentPart(BaseModel):
  """Private assessment part. Answer material must never be sent directly to clients."""

  model_config = ConfigDict(extra='forbid')
  id: str
  type: Literal['choice', 'numeric', 'text']
  prompt: str
  weight: float = Field(gt=0.0, le=1.0)
  required: bool = True
  options: list[AssessmentOption] = Field(default_factory=list)
  correct_option_id: str | None = None
  expected_value: str | None = None
  tolerance: float | None = Field(default=None, ge=0.0)
  reference_answer: str


class AssessmentSpec(BaseModel):
  model_config = ConfigDict(extra='forbid')
  question_id: str
  source_fingerprint: str
  parts: list[AssessmentPart] = Field(min_length=1)
  reference_answer: str = ''
  reference_answer_source: Literal['original', 'ai_generated', 'user_corrected'] = 'original'
  reference_answer_confidence: float = Field(default=1.0, ge=0.0, le=1.0)
  reference_answer_needs_review: bool = False
  reference_answer_updated_at: str = ''
  created_at: str = Field(default_factory=_now)

  def public_payload(self) -> dict[str, Any]:
    return {
      'question_id': self.question_id,
      'reference_answer_info': {
        'source': self.reference_answer_source,
        'confidence': self.reference_answer_confidence,
        'needs_review': self.reference_answer_needs_review,
        'updated_at': self.reference_answer_updated_at,
      },
      'parts': [
        {
          'id': part.id,
          'type': part.type,
          'prompt': part.prompt,
          'weight': part.weight,
          'required': part.required,
          'options': [option.model_dump() for option in part.options],
        }
        for part in self.parts
      ],
    }


class PlannedPart(BaseModel):
  model_config = ConfigDict(extra='forbid')
  type: Literal['choice', 'numeric', 'text']
  prompt: str = Field(min_length=1, max_length=1200)
  weight: float = Field(gt=0.0, le=1.0)
  reference_excerpt: str = Field(min_length=1, max_length=12000)
  distractors: list[str] = Field(default_factory=list, max_length=3)
  uncertain: bool = False


class PlannedAssessment(BaseModel):
  model_config = ConfigDict(extra='forbid')
  parts: list[PlannedPart] = Field(min_length=1, max_length=10)


class AssessmentTask(BaseModel):
  """One independently answerable requirement found before UI planning."""

  model_config = ConfigDict(extra='forbid')
  id: str = Field(min_length=1, max_length=80)
  prompt: str = Field(min_length=1, max_length=1200)
  answer_kind: Literal['expression', 'numeric', 'objective', 'text']
  reference_excerpt: str = Field(min_length=1, max_length=12000)


class AssessmentTaskInventory(BaseModel):
  model_config = ConfigDict(extra='forbid')
  task_count: int = Field(ge=1, le=10)
  tasks: list[AssessmentTask] = Field(min_length=1, max_length=10)
  reference_complete: bool
  uncovered_requirements: list[str] = Field(max_length=10)


class GeneratedAnswerPart(BaseModel):
  model_config = ConfigDict(extra='forbid')
  id: str = Field(min_length=1, max_length=80)
  prompt: str = Field(min_length=1, max_length=1200)
  answer_kind: Literal['expression', 'numeric', 'objective', 'text']
  answer: str = Field(min_length=1, max_length=12000)


class GeneratedReferenceAnswer(BaseModel):
  model_config = ConfigDict(extra='forbid')
  complete_answer: str = Field(min_length=1, max_length=30000)
  parts: list[GeneratedAnswerPart] = Field(min_length=1, max_length=10)
  confidence: float = Field(ge=0.0, le=1.0)
  assumptions: list[str] = Field(default_factory=list, max_length=10)


class DistractorPlan(BaseModel):
  model_config = ConfigDict(extra='forbid')
  distractors: list[str] = Field(min_length=3, max_length=3)


class TaskDistractors(DistractorPlan):
  task_id: str = Field(min_length=1, max_length=80)


class DistractorBatch(BaseModel):
  model_config = ConfigDict(extra='forbid')
  items: list[TaskDistractors] = Field(min_length=1, max_length=10)


class AssessmentPlanner:
  """Plans and persists how one real source question is answered during a test."""

  def __init__(self, store: LearningStateStore) -> None:
    self.store = store

  def get_or_create(
    self,
    *,
    course_id: str,
    source_document_id: str,
    question_id: str,
    prompt: str,
    reference_answer: str,
    analysis: dict[str, Any],
  ) -> AssessmentSpec:
    saved_answer = self.store.get_question_reference_answer(course_id, question_id)
    effective_answer = saved_answer.answer_text if saved_answer else str(reference_answer or '').strip()
    answer_source: Literal['original', 'ai_generated', 'user_corrected'] = (
      saved_answer.answer_source if saved_answer else 'original'
    )
    answer_confidence = saved_answer.confidence if saved_answer else 1.0
    answer_needs_review = saved_answer.needs_review if saved_answer else False
    answer_updated_at = saved_answer.updated_at if saved_answer else ''

    if not effective_answer:
      saved_answer = self._generate_and_save_reference_answer(
        course_id=course_id,
        source_document_id=source_document_id,
        question_id=question_id,
        prompt=prompt,
        partial_answer='',
        analysis=analysis,
      )
      effective_answer = saved_answer.answer_text
      answer_source = saved_answer.answer_source
      answer_confidence = saved_answer.confidence
      answer_needs_review = saved_answer.needs_review
      answer_updated_at = saved_answer.updated_at

    fingerprint = self._fingerprint(prompt, effective_answer, analysis)
    cached = self.store.get_assessment_spec(course_id, question_id, fingerprint)
    if cached:
      try:
        return AssessmentSpec.model_validate(cached)
      except ValidationError:
        pass

    try:
      planned = self._request_plan(prompt, effective_answer, analysis)
    except HTTPException as exc:
      if exc.status_code != 422 or answer_source == 'user_corrected':
        raise
      saved_answer = self._generate_and_save_reference_answer(
        course_id=course_id,
        source_document_id=source_document_id,
        question_id=question_id,
        prompt=prompt,
        partial_answer=effective_answer,
        analysis=analysis,
      )
      effective_answer = saved_answer.answer_text
      answer_source = saved_answer.answer_source
      answer_confidence = saved_answer.confidence
      answer_needs_review = saved_answer.needs_review
      answer_updated_at = saved_answer.updated_at
      fingerprint = self._fingerprint(prompt, effective_answer, analysis)
      cached = self.store.get_assessment_spec(course_id, question_id, fingerprint)
      if cached:
        try:
          return AssessmentSpec.model_validate(cached)
        except ValidationError:
          pass
      planned = self._request_plan(prompt, effective_answer, analysis)
    if planned is None:
      raise HTTPException(
        status_code=502,
        detail='AI 子问盘点失败，未生成不完整测验。请稍后重试。',
      )
    spec = self._materialize(question_id, fingerprint, prompt, effective_answer, planned)
    spec.reference_answer = effective_answer
    spec.reference_answer_source = answer_source
    spec.reference_answer_confidence = answer_confidence
    spec.reference_answer_needs_review = answer_needs_review
    spec.reference_answer_updated_at = answer_updated_at
    self.store.save_assessment_spec(
      course_id,
      question_id,
      source_document_id,
      fingerprint,
      spec.model_dump(),
    )
    return spec

  def get_cached(
    self,
    *,
    course_id: str,
    question_id: str,
    prompt: str,
    reference_answer: str,
    analysis: dict[str, Any],
  ) -> AssessmentSpec | None:
    """Return a valid persisted spec without ever invoking a model."""
    saved_answer = self.store.get_question_reference_answer(course_id, question_id)
    effective_answer = saved_answer.answer_text if saved_answer else str(reference_answer or '').strip()
    if not effective_answer:
      return None
    fingerprint = self._fingerprint(prompt, effective_answer, analysis)
    cached = self.store.get_assessment_spec(course_id, question_id, fingerprint)
    if not cached:
      return None
    try:
      return AssessmentSpec.model_validate(cached)
    except ValidationError:
      return None

  def get_latest_cached(self, *, course_id: str, question_id: str) -> AssessmentSpec | None:
    """Read the last valid spec without requiring the current policy fingerprint."""
    cached = self.store.get_latest_assessment_spec(course_id, question_id)
    if not cached:
      return None
    try:
      return AssessmentSpec.model_validate(cached)
    except ValidationError:
      return None

  def saved_reference_answer(
    self,
    course_id: str,
    question_id: str,
  ) -> QuestionReferenceAnswer | None:
    return self.store.get_question_reference_answer(course_id, question_id)

  def preparation_fingerprint(
    self,
    *,
    course_id: str,
    question_id: str,
    prompt: str,
    reference_answer: str,
    analysis: dict[str, Any],
  ) -> str:
    """Fingerprint the effective source without invoking any model."""
    saved_answer = self.store.get_question_reference_answer(course_id, question_id)
    effective_answer = saved_answer.answer_text if saved_answer else str(reference_answer or '').strip()
    return self._fingerprint(prompt, effective_answer, analysis)

  def save_user_correction(
    self,
    *,
    course_id: str,
    source_document_id: str,
    question_id: str,
    prompt: str,
    answer_text: str,
    analysis: dict[str, Any],
  ) -> QuestionReferenceAnswer:
    normalized = str(answer_text or '').strip()
    if not normalized:
      raise HTTPException(status_code=422, detail='修正后的参考答案不能为空。')
    answer = QuestionReferenceAnswer(
      question_id=question_id,
      source_document_id=source_document_id,
      answer_text=normalized,
      structured_answer={
        'complete_answer': normalized,
        'correction_source': 'user',
      },
      answer_source='user_corrected',
      model='',
      confidence=1.0,
      needs_review=False,
    )
    saved = self.store.save_question_reference_answer(course_id, answer)
    self.store.delete_assessment_spec(course_id, question_id)
    return saved

  @staticmethod
  def _fingerprint(prompt: str, reference_answer: str, analysis: dict[str, Any]) -> str:
    payload = json.dumps(
      {
        'policy_version': ASSESSMENT_POLICY_VERSION,
        'prompt': prompt,
        'reference_answer': reference_answer,
        'analysis': analysis,
      },
      ensure_ascii=False,
      sort_keys=True,
    )
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()

  def _generate_and_save_reference_answer(
    self,
    *,
    course_id: str,
    source_document_id: str,
    question_id: str,
    prompt: str,
    partial_answer: str,
    analysis: dict[str, Any],
  ) -> QuestionReferenceAnswer:
    generated, model = self._request_generated_reference_answer(
      prompt,
      partial_answer,
      analysis,
    )
    complete_answer = generated.complete_answer.strip()
    compact_complete = re.sub(r'\s+', '', complete_answer)
    missing_parts = [
      part for part in generated.parts
      if re.sub(r'\s+', '', part.answer) not in compact_complete
    ]
    if missing_parts:
      complete_answer = '\n\n'.join([
        complete_answer,
        *(
          f'### {part.prompt}\n\n{part.answer}'
          for part in missing_parts
        ),
      ])
    answer = QuestionReferenceAnswer(
      question_id=question_id,
      source_document_id=source_document_id,
      answer_text=complete_answer,
      structured_answer=generated.model_dump(),
      answer_source='ai_generated',
      model=model,
      confidence=generated.confidence,
      needs_review=True,
    )
    return self.store.save_question_reference_answer(course_id, answer)

  @staticmethod
  def _request_generated_reference_answer(
    prompt: str,
    partial_answer: str,
    analysis: dict[str, Any],
  ) -> tuple[GeneratedReferenceAnswer, str]:
    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      raise HTTPException(
        status_code=422,
        detail='生成参考答案需要先配置文本处理模型。',
      )

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = GeneratedReferenceAnswer.model_json_schema()
    payload = {
      'model': model,
      'temperature': 0.1,
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'generated_reference_answer', 'strict': True, 'schema': schema},
      },
      'messages': [
        {
          'role': 'system',
          'content': (
            '你是严谨的课程题目解答器。原题没有参考答案或现有答案只覆盖部分子问，请独立完成整道题。'
            '必须先枚举题干要求回答的全部独立任务，再逐项给出答案，不能只做最后一问，不能遗漏并列对象或物理量。'
            '数学表达式使用可渲染的 LaTeX；数值保留单位和必要精度；解释题给出关键推理。'
            'complete_answer 必须是一份完整、可作为评分依据的 Markdown 解答，并包含 parts 中每一项的答案。'
            'parts 中每项填写稳定 id、面向学生的任务 prompt、answer_kind 和该项完整答案。'
            '已有部分答案只能作为线索，需要自行校验；发现错误时应纠正，不能盲目续写。'
            '若题目信息或图像细节不足，基于题干中明确条件作答，在 assumptions 中说明假设并降低 confidence。'
            '不要声称答案来自教材或教师；只返回符合 JSON Schema 的 JSON。'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps({
            'question_prompt': prompt[:18000],
            'existing_partial_answer': partial_answer[:12000],
            'question_analysis': analysis,
            'json_schema': schema,
          }, ensure_ascii=False),
        },
      ],
    }
    for attempt in range(2):
      if attempt:
        payload['response_format'] = {'type': 'json_object'}
      try:
        response = requests.post(
          f'{root}/chat/completions',
          headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
          json=payload,
          timeout=180,
        )
        response.raise_for_status()
        content = response.json()['choices'][0]['message']['content']
        generated = GeneratedReferenceAnswer.model_validate(
          QuestionAnalyzer._extract_json_object(str(content))
        )
        return generated, model
      except (requests.RequestException, KeyError, TypeError, ValueError, ValidationError):
        continue
    raise HTTPException(status_code=502, detail='AI 参考答案生成失败，请稍后重试。')

  def _request_plan(
    self,
    prompt: str,
    reference_answer: str,
    analysis: dict[str, Any],
  ) -> PlannedAssessment | None:
    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      return None

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = AssessmentTaskInventory.model_json_schema()
    payload = {
      'model': model,
      'temperature': 0.15,
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'assessment_task_inventory', 'strict': True, 'schema': schema},
      },
      'messages': [
        {
          'role': 'system',
          'content': (
            '你是课程测验的题目任务分析器。此步骤只盘点原题要求学生回答的全部独立任务，不生成选项。'
            '先通读完整题干和参考答案，再给出准确的 task_count 和一一对应的 tasks，不能只提取最后一问。'
            '题干中每个编号子问、并列动词、不同对象、不同物理量都要逐项检查。比如“求 P、Q 两点的 E 和 B，判断 E、B 是否连续，'
            '并分析原因”至少包含 P 点 E、P 点 B、Q 点 E、Q 点 B、连续性判断、原因分析等独立任务。'
            '只有多个量必须作为一个不可分割的整体作答时才允许合并，不能为了减少数量而合并。'
            'answer_kind 规则：单一具体数值为 numeric；公式、矩阵、函数、方程或符号结果为 expression；'
            '有唯一短结论、判断、枚举或概念选择的客观答案为 objective；解释、证明、原因和开放论述为 text。'
            '判定必须偏向可客观作答：凡是“求、计算、写出、给出、确定、化简、解出、判断”等任务，'
            '只要答案是数值、符号、公式、表达式、物理量或唯一短结论，就不能标为 text。'
            '只有题目明确要求说明、解释、证明、分析原因、论述思路，或确实不存在唯一客观答案时才使用 text。'
            '题干要求“求某个物理量、场强、波函数或表达式”时，即使答案是“为零”或参考答案使用中文描述，'
            '也必须标为 expression，不能标为 text；只有要求解释原因或推导思路时才标为 text。'
            '每个 reference_excerpt 必须逐字摘自真实参考答案，并且只包含当前任务所需的最小充分答案。'
            '如果题干确实要求解释原因，必须单列 text 任务。prompt 面向学生且不能泄漏答案。'
            '最后判断参考答案是否覆盖题干要求的全部任务：全部覆盖时 reference_complete=true 且 uncovered_requirements=[]；'
            '只给出部分子问答案、答案被截断或缺少任何必答项时 reference_complete=false，并在 uncovered_requirements 列出缺失项。'
            '不能为了让 reference_complete=true 而忽略题干中的子问，也不能为缺失答案的任务虚构 reference_excerpt。'
            '只返回符合 JSON Schema 的 JSON。'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps(
            {
              'question_prompt': prompt[:16000],
              'reference_answer': reference_answer[:16000],
              'question_analysis': analysis,
              'json_schema': schema,
            },
            ensure_ascii=False,
          ),
        },
      ],
    }
    try:
      inventory = None
      for attempt in range(2):
        if attempt:
          payload['response_format'] = {'type': 'json_object'}
        try:
          response = requests.post(
            f'{root}/chat/completions',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json=payload,
            timeout=150,
          )
          response.raise_for_status()
          content = response.json()['choices'][0]['message']['content']
          candidate = AssessmentTaskInventory.model_validate(
            QuestionAnalyzer._extract_json_object(str(content))
          )
          if candidate.task_count != len(candidate.tasks):
            raise ValueError('Assessment task_count does not match tasks.')
          if not candidate.reference_complete or candidate.uncovered_requirements:
            raise HTTPException(
              status_code=422,
              detail='参考答案未覆盖原题全部子问，已跳过该题。',
            )
          if any(
            not self._validated_excerpt(task.reference_excerpt, reference_answer)
            for task in candidate.tasks
          ):
            raise ValueError('Assessment task reference excerpt is not source-grounded.')
          inventory = candidate
          break
        except HTTPException:
          raise
        except (requests.RequestException, KeyError, TypeError, ValueError, ValidationError):
          continue
      if inventory is None:
        return None
      tasks = [self._normalize_task_kind(task) for task in inventory.tasks]
      choice_tasks = [
        task for task in tasks
        if task.answer_kind in {'expression', 'objective'}
      ]
      distractor_sets = self._request_distractor_batch(choice_tasks, prompt)
      parts = []
      for task in tasks:
        if task.answer_kind == 'numeric':
          part_type = 'numeric'
        elif task.answer_kind in {'expression', 'objective'}:
          part_type = 'choice'
        else:
          part_type = 'text'
        distractors = (
          distractor_sets.get(task.id, [])
          if part_type == 'choice'
          else []
        )
        parts.append(PlannedPart(
          type=part_type,
          prompt=task.prompt,
          weight=1.0,
          reference_excerpt=task.reference_excerpt,
          distractors=distractors,
          uncertain=False,
        ))
      return PlannedAssessment(parts=parts)
    except (requests.RequestException, KeyError, TypeError, ValueError, ValidationError):
      return None

  @classmethod
  def _normalize_task_kind(cls, task: AssessmentTask) -> AssessmentTask:
    if task.answer_kind == 'numeric' and cls.parse_numeric(task.reference_excerpt) is None:
      return task.model_copy(update={'answer_kind': 'expression'})
    if task.answer_kind == 'text' and cls._prompt_requires_objective_answer(task.prompt):
      return task.model_copy(update={'answer_kind': 'expression'})
    return task

  @classmethod
  def _prompt_requires_objective_answer(cls, prompt: str) -> bool:
    text = str(prompt or '').strip()
    if not text or _TEXT_TASK_SIGNAL.search(text):
      return False
    return bool(_OBJECTIVE_TASK_SIGNAL.search(text) or cls._prompt_requires_symbolic_answer(text))

  @staticmethod
  def _prompt_requires_symbolic_answer(prompt: str) -> bool:
    text = str(prompt or '').strip()
    if not text or _TEXT_TASK_SIGNAL.search(text):
      return False
    return bool(_SYMBOLIC_TASK_SIGNAL.search(text))

  def _request_distractor_batch(
    self,
    tasks: list[AssessmentTask],
    question_prompt: str,
  ) -> dict[str, list[str]]:
    """Generate alternatives for every objective task in one model request."""
    if not tasks:
      return {}
    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      return {}

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = DistractorBatch.model_json_schema()
    payload = {
      'model': model,
      'temperature': 0.35,
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'assessment_distractor_batch', 'strict': True, 'schema': schema},
      },
      'messages': [
        {
          'role': 'system',
          'content': (
            '你负责为同一道课程题的多个客观作答任务批量生成错误选项。每个输入 task_id 必须原样返回且只能返回一次，'
            '每项必须给出恰好三个互不重复的 distractors，不得遗漏任务，不要输出正确答案。'
            'expression 优先模拟正负号、分母、指数、漏项、系数、转置/逆矩阵、求导或积分等典型错误；'
            'objective 生成与题意相关、互斥且容易混淆的错误结论。干扰项不能与正确答案等价，不能明显荒谬。'
            '只返回符合 JSON Schema 的 JSON。'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps({
            'question_prompt': question_prompt[:8000],
            'tasks': [
              {
                'task_id': task.id,
                'task_prompt': task.prompt,
                'answer_kind': task.answer_kind,
                'correct_answer': task.reference_excerpt,
              }
              for task in tasks
            ],
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
        payload['response_format'] = {'type': 'json_object'}
        response = requests.post(
          f'{root}/chat/completions',
          headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
          json=payload,
          timeout=90,
        )
      response.raise_for_status()
      content = response.json()['choices'][0]['message']['content']
      result = DistractorBatch.model_validate(
        QuestionAnalyzer._extract_json_object(str(content))
      )
      expected_ids = {task.id for task in tasks}
      generated = {
        item.task_id: item.distractors
        for item in result.items
        if item.task_id in expected_ids
      }
      return generated
    except (requests.RequestException, KeyError, TypeError, ValueError, ValidationError):
      return {}

  def _request_distractors(
    self,
    correct_answer: str,
    question_prompt: str,
    answer_kind: Literal['expression', 'objective'] = 'expression',
  ) -> list[str]:
    """Ask the text-processing model only for plausible wrong alternatives."""
    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      return []

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = DistractorPlan.model_json_schema()
    payload = {
      'model': model,
      'temperature': 0.35,
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'expression_distractors', 'strict': True, 'schema': schema},
      },
      'messages': [
        {
          'role': 'system',
          'content': (
            '你只负责为课程测验中的正确答案生成三个错误干扰项。不要输出正确答案。'
            '三个干扰项必须互不重复、不能与正确答案数学等价，并保持相同的表达形式和难度。'
            '当 answer_kind=expression 时，优先模拟典型学生错误：正负号错误、分母错误、指数错误、漏项、系数错误、'
            '转置与逆矩阵混淆、求导或积分常见错误。当 answer_kind=objective 时，生成与题意相关、互斥且容易混淆的错误结论。'
            '不要生成明显荒谬、无关或可同时成立的选项。'
            '只返回符合 JSON Schema 的 JSON。'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps({
            'question_prompt': question_prompt[:8000],
            'answer_kind': answer_kind,
            'correct_answer': correct_answer[:4000],
            'json_schema': schema,
          }, ensure_ascii=False),
        },
      ],
    }
    for attempt in range(2):
      if attempt:
        payload['response_format'] = {'type': 'json_object'}
      try:
        response = requests.post(
          f'{root}/chat/completions',
          headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
          json=payload,
          timeout=90,
        )
        response.raise_for_status()
        content = response.json()['choices'][0]['message']['content']
        result = DistractorPlan.model_validate(
          QuestionAnalyzer._extract_json_object(str(content))
        )
        valid = self._valid_distractors(correct_answer, result.distractors)
        if len(valid) == 3:
          return valid
      except (requests.RequestException, KeyError, TypeError, ValueError, ValidationError):
        continue
    return []

  def _materialize(
    self,
    question_id: str,
    fingerprint: str,
    prompt: str,
    reference_answer: str,
    planned: PlannedAssessment | None,
  ) -> AssessmentSpec:
    if planned is None:
      numeric = self.parse_numeric(reference_answer)
      if numeric is not None:
        parts = [AssessmentPart(
          id='part-1',
          type='numeric',
          prompt='请输入最终数值结果。',
          weight=1.0,
          expected_value=str(numeric),
          tolerance=DEFAULT_NUMERIC_TOLERANCE,
          reference_answer=reference_answer,
        )]
      elif self._looks_like_expression(reference_answer):
        choice = self._choice_part(
          'part-1',
          '请选择正确的表达式。',
          1.0,
          reference_answer,
          self._request_distractors(reference_answer, prompt, 'expression'),
        )
        if choice is None:
          raise HTTPException(status_code=502, detail='表达式选项生成失败，请重试。')
        parts = [choice]
      else:
        parts = [self._text_part('part-1', '简要说明你的结论或思路。', 1.0, reference_answer)]
      return AssessmentSpec(question_id=question_id, source_fingerprint=fingerprint, parts=parts)

    materialized: list[AssessmentPart] = []
    for index, item in enumerate(planned.parts, start=1):
      part_id = f'part-{index}'
      reference = self._validated_excerpt(item.reference_excerpt, reference_answer)
      if not reference:
        raise HTTPException(
          status_code=502,
          detail=f'{item.prompt} 的参考答案定位失败，未缓存不完整测验，请重试。',
        )
      numeric = self.parse_numeric(reference)
      if numeric is not None:
        materialized.append(AssessmentPart(
          id=part_id,
          type='numeric',
          prompt=item.prompt,
          weight=item.weight,
          expected_value=str(numeric),
          tolerance=DEFAULT_NUMERIC_TOLERANCE,
          reference_answer=reference,
        ))
        continue
      if (
        self._looks_like_expression(reference)
        or item.type == 'choice'
        or self._prompt_requires_objective_answer(item.prompt)
      ):
        distractors = self._valid_distractors(reference, item.distractors)
        if len(distractors) < 3:
          distractors = self._valid_distractors(
            reference,
            [
              *distractors,
              *self._request_distractors(
                reference,
                f'{prompt}\n\n当前独立任务：{item.prompt}',
                'expression' if self._looks_like_expression(reference) else 'objective',
              ),
            ],
          )
        choice = self._choice_part(
          part_id,
          item.prompt,
          item.weight,
          reference,
          distractors,
        )
        if choice:
          materialized.append(choice)
          continue
        raise HTTPException(
          status_code=502,
          detail=f'{item.prompt} 的选择项生成失败，未缓存不完整测验，请重试。',
        )
      if item.uncertain:
        materialized.append(self._text_part(part_id, item.prompt, item.weight, reference))
        continue
      materialized.append(self._text_part(part_id, item.prompt, item.weight, reference))

    if _TEXT_TASK_SIGNAL.search(prompt) and not any(part.type == 'text' for part in materialized):
      materialized.append(self._text_part(
        f'part-{len(materialized) + 1}',
        '简要说明题目所要求的理由或条件为什么成立。',
        1.0,
        reference_answer,
      ))

    total_weight = sum(part.weight for part in materialized)
    if total_weight <= 0:
      materialized = [self._text_part('part-1', '简要说明你的结论或思路。', 1.0, reference_answer)]
    else:
      for part in materialized:
        part.weight = round(part.weight / total_weight, 8)
      materialized[-1].weight = round(
        1.0 - sum(part.weight for part in materialized[:-1]),
        8,
      )
    return AssessmentSpec(question_id=question_id, source_fingerprint=fingerprint, parts=materialized)

  @staticmethod
  def _text_part(part_id: str, prompt: str, weight: float, reference: str) -> AssessmentPart:
    return AssessmentPart(
      id=part_id,
      type='text',
      prompt=prompt or '简要说明你的结论或思路。',
      weight=weight,
      reference_answer=reference,
    )

  @classmethod
  def _choice_part(
    cls,
    part_id: str,
    prompt: str,
    weight: float,
    reference: str,
    distractor_values: list[str],
  ) -> AssessmentPart | None:
    distractors = cls._valid_distractors(reference, distractor_values)
    if len(distractors) != 3:
      return None
    contents = [reference, *distractors]
    random.SystemRandom().shuffle(contents)
    options = [
      AssessmentOption(id=chr(65 + option_index), content=content)
      for option_index, content in enumerate(contents)
    ]
    correct_option_id = next(option.id for option in options if option.content == reference)
    return AssessmentPart(
      id=part_id,
      type='choice',
      prompt=prompt or '请选择正确的表达式。',
      weight=weight,
      options=options,
      correct_option_id=correct_option_id,
      reference_answer=reference,
    )

  @staticmethod
  def _validated_excerpt(excerpt: str, reference: str) -> str:
    candidate = str(excerpt or '').strip()
    if not candidate:
      return ''
    compact_candidate = re.sub(r'\s+', '', candidate)
    compact_reference = re.sub(r'\s+', '', reference)
    return candidate if compact_candidate in compact_reference else ''

  @staticmethod
  def _looks_like_expression(value: str) -> bool:
    text = value.strip()
    chinese_prose_length = len(re.findall(r'[\u4e00-\u9fff]', text))
    simple_symbol = re.fullmatch(r'(?:[A-Za-z]|\\[A-Za-z]+)', text)
    return bool(
      text
      and len(text) <= 1200
      and chinese_prose_length <= 20
      and (_MATH_SIGNAL.search(text) or simple_symbol)
    )

  @staticmethod
  def _normalize_expression(value: str) -> str:
    return re.sub(r'[\s$`，。；;]', '', str(value or '')).casefold()

  @classmethod
  def _valid_distractors(cls, correct: str, values: list[str]) -> list[str]:
    correct_key = cls._normalize_expression(correct)
    seen = {correct_key}
    result: list[str] = []
    for value in values:
      content = str(value or '').strip()
      key = cls._normalize_expression(content)
      if not content or not key or key in seen:
        continue
      seen.add(key)
      result.append(content)
    return result[:3]

  @staticmethod
  def parse_numeric(value: str) -> Decimal | None:
    text = str(value or '').strip()
    text = re.sub(r'^\$+|\$+$', '', text).strip()
    boxed = re.fullmatch(r'\\boxed\s*\{(.+)\}', text)
    if boxed:
      text = boxed.group(1).strip()
    match = _FRACTION.fullmatch(text) or _LATEX_FRACTION.fullmatch(text)
    if match:
      denominator = int(match.group(2))
      if denominator == 0:
        return None
      return Decimal(Fraction(int(match.group(1)), denominator).numerator) / Decimal(
        Fraction(int(match.group(1)), denominator).denominator
      )
    if not _NUMBER.fullmatch(text):
      return None
    try:
      numeric = Decimal(text)
    except InvalidOperation:
      return None
    return numeric if numeric.is_finite() else None

