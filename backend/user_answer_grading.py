from __future__ import annotations

import base64
import json
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Protocol

from .knowledge_storage import read_knowledge_library
from .learning_state import LearningStateStore
from .provider_transport import MultimodalChatClient, ProviderTransportError
from .question_pipeline import (
  load_question_record,
  question_image_attachments,
  resolve_question_image_asset,
)
from .runtime_config import load_api_config
from .user_answers import (
  AnswerUnderstanding,
  UserAnswerGrading,
  UserAnswerStore,
  UserQuestionAnswer,
)


GRADING_VERSION = 'user-answer-grading-v1'
MAX_PDF_PAGES = 16


class UserAnswerGradingError(RuntimeError):
  pass


class QuestionContextProvider(Protocol):
  def resolve(self, course_id: str, source_document_id: str, question_id: str) -> dict[str, Any]: ...


class KnowledgeQuestionContextProvider:
  """Read the stable question projection and saved reference answer."""

  def __init__(self, learning_store: LearningStateStore | None = None) -> None:
    self.learning_store = learning_store or LearningStateStore()

  def resolve(self, course_id: str, source_document_id: str, question_id: str) -> dict[str, Any]:
    library = read_knowledge_library()
    for course in library.get('courses') or []:
      if not isinstance(course, dict) or str(course.get('id') or '') != course_id:
        continue
      for folder in course.get('homeworkFolders') or []:
        if not isinstance(folder, dict):
          continue
        for document in folder.get('homeworkDocuments') or []:
          if not isinstance(document, dict) or str(document.get('id') or '') != source_document_id:
            continue
          for question in document.get('questions') or []:
            if isinstance(question, dict) and str(question.get('id') or '') == question_id:
              saved = self.learning_store.get_question_reference_answer(course_id, question_id)
              source_question = load_question_record(source_document_id, question_id) or question
              question_images: list[Path] = []
              try:
                question_images = [
                  resolve_question_image_asset(source_document_id, str(attachment['id']))
                  for attachment in question_image_attachments(
                    source_document_id,
                    source_question,
                    str(source_question.get('content') or question.get('content') or ''),
                  )
                ]
              except Exception:  # noqa: BLE001 - a missing source visual must not lose the user answer.
                question_images = []
              reference = saved.answer_text if saved else str(
                question.get('reference_answer')
                or question.get('standard_answer')
                or question.get('answer')
                or '',
              ).strip()
              return {
                'title': str(question.get('title') or ''),
                'content': str(question.get('content') or ''),
                'analysis': question.get('analysis') if isinstance(question.get('analysis'), dict) else {},
                'reference_answer': reference,
                'reference_confidence': saved.confidence if saved else 0.0,
                'reference_needs_review': saved.needs_review if saved else not bool(reference),
                'question_images': question_images,
              }
    raise UserAnswerGradingError('Question context is no longer available.')


def _data_url(path: Path, content_type: str) -> str:
  encoded = base64.b64encode(path.read_bytes()).decode('ascii')
  return f'data:{content_type};base64,{encoded}'


class AnswerVisualRenderer:
  """Convert answer assets to provider-ready images without retaining derivatives."""

  def render(self, store: UserAnswerStore, attempt: UserQuestionAnswer, target: Path) -> list[tuple[Path, str]]:
    rendered: list[tuple[Path, str]] = []
    for asset in sorted(attempt.assets, key=lambda item: item.order):
      path, _ = store.asset(
        attempt.course_id,
        attempt.source_document_id,
        attempt.question_id,
        asset.id,
        attempt.id,
      )
      if asset.kind == 'image':
        rendered.append((path, asset.content_type))
        continue
      rendered.extend(self._render_pdf(path, target / asset.id))
    return rendered

  @staticmethod
  def _render_pdf(path: Path, target: Path) -> list[tuple[Path, str]]:
    try:
      import fitz
    except ImportError as exc:  # pragma: no cover - deployment dependency guard.
      raise UserAnswerGradingError('PyMuPDF is required to grade PDF answers.') from exc
    target.mkdir(parents=True, exist_ok=True)
    pages: list[tuple[Path, str]] = []
    try:
      with fitz.open(path) as document:
        for index, page in enumerate(document):
          if index >= MAX_PDF_PAGES:
            break
          output = target / f'page-{index + 1}.png'
          page.get_pixmap(matrix=fitz.Matrix(1.7, 1.7), alpha=False).save(output)
          pages.append((output, 'image/png'))
    except Exception as exc:
      raise UserAnswerGradingError(f'Unable to render answer PDF: {exc}') from exc
    if not pages:
      raise UserAnswerGradingError('The answer PDF contains no readable pages.')
    return pages


class UserAnswerGradingService:
  """Domain service for one multimodal understanding + grading projection."""

  def __init__(
    self,
    store: UserAnswerStore,
    context_provider: QuestionContextProvider | None = None,
    chat_client: MultimodalChatClient | None = None,
    renderer: AnswerVisualRenderer | None = None,
  ) -> None:
    self.store = store
    self.context_provider = context_provider or KnowledgeQuestionContextProvider()
    self.chat_client = chat_client or MultimodalChatClient()
    self.renderer = renderer or AnswerVisualRenderer()

  def grade(self, attempt: UserQuestionAnswer) -> tuple[AnswerUnderstanding, UserAnswerGrading, str]:
    config = load_api_config() or {}
    model = str(config.get('ocrModel') or config.get('model') or '').strip()
    context = self.context_provider.resolve(
      attempt.course_id, attempt.source_document_id, attempt.question_id,
    )
    schema = self._schema()
    temporary = Path(tempfile.mkdtemp(prefix=f'user-answer-{attempt.id[:8]}-'))
    try:
      images = self.renderer.render(self.store, attempt, temporary)
      if not images:
        raise UserAnswerGradingError('The answer contains no visual content to grade.')
      user_content: list[dict[str, Any]] = [{
        'type': 'text',
        'text': json.dumps({
          'question': {'title': context['title'], 'content': context['content']},
          'question_analysis': context['analysis'],
          'reference_answer': context['reference_answer'],
          'reference_reliability': {
            'confidence': context['reference_confidence'],
            'needs_review': context['reference_needs_review'],
          },
          'instruction': (
            'Question source images, if available, appear first. A separator then marks the student answer '
            'images, which are ordered by upload and PDF page.'
          ),
        }, ensure_ascii=False),
      }]
      for question_image in context.get('question_images') or []:
        suffix = question_image.suffix.lower()
        content_type = 'image/png' if suffix == '.png' else 'image/jpeg'
        user_content.append({
          'type': 'image_url',
          'image_url': {'url': _data_url(question_image, content_type), 'detail': 'high'},
        })
      user_content.append({'type': 'text', 'text': 'Student answer images begin below.'})
      user_content.extend({
        'type': 'image_url',
        'image_url': {'url': _data_url(path, content_type), 'detail': 'high'},
      } for path, content_type in images)
      payload = self.chat_client.complete_json(
        base_url=str(config.get('baseUrl') or ''),
        api_key=str(config.get('apiKey') or ''),
        model=model,
        messages=[
          {
            'role': 'system',
            'content': (
              'You grade a student handwritten answer. Read all images in order. Return only the requested '
              'structured JSON. Preserve uncertainty: if handwriting or the reference answer is unreliable, '
              'set needs_review=true. Diagnose evidence, not personality. Scores are 0..1. Do not invent '
              'missing work. error_types must use the supplied enum.'
            ),
          },
          {'role': 'user', 'content': user_content},
        ],
        schema=schema,
        schema_name='user_answer_grading',
        timeout=240,
        allow_plain_fallback=True,
      )
      understanding = AnswerUnderstanding.model_validate(payload.get('understanding') or {})
      grading_payload = dict(payload.get('grading') or {})
      score = min(1.0, max(0.0, float(grading_payload.get('score') or 0.0)))
      confidence = min(1.0, max(0.0, float(grading_payload.get('confidence') or 0.0)))
      needs_review = bool(
        grading_payload.get('needs_review')
        or confidence < 0.55
        or understanding.confidence < 0.55
        or context['reference_needs_review']
      )
      grading_payload.update({
        'score': score,
        'correct': score >= 0.75,
        'confidence': confidence,
        'needs_review': needs_review,
        'is_wrong': score < 0.75 and not needs_review,
      })
      grading = UserAnswerGrading.model_validate(grading_payload)
      return understanding, grading, model
    except ProviderTransportError as exc:
      raise UserAnswerGradingError(str(exc)) from exc
    finally:
      shutil.rmtree(temporary, ignore_errors=True)

  @staticmethod
  def _schema() -> dict[str, Any]:
    schema = {
      'type': 'object',
      'additionalProperties': False,
      'required': ['understanding', 'grading'],
      'properties': {
        'understanding': AnswerUnderstanding.model_json_schema(),
        'grading': UserAnswerGrading.model_json_schema(),
      },
    }
    # Pydantic references are valid JSON Schema and accepted by compatible providers.
    definitions = {}
    for model in (AnswerUnderstanding, UserAnswerGrading):
      definitions.update(model.model_json_schema().get('$defs') or {})
    if definitions:
      schema['$defs'] = definitions
    return schema


class UserAnswerGradingCoordinator:
  """Process-local idempotent queue; Attempt state remains the durable source of truth."""

  def __init__(
    self,
    store: UserAnswerStore,
    service: UserAnswerGradingService | None = None,
    max_workers: int = 2,
  ) -> None:
    self.store = store
    self.service = service or UserAnswerGradingService(store)
    self._max_workers = max_workers
    self._executor: ThreadPoolExecutor | None = None
    self._lock = threading.Lock()
    self._in_flight: set[tuple[str, str, str]] = set()

  def queue(self, attempt: UserQuestionAnswer) -> bool:
    key = (attempt.course_id, attempt.question_id, attempt.id)
    with self._lock:
      if key in self._in_flight:
        return False
      self._in_flight.add(key)
      if self._executor is None:
        self._executor = ThreadPoolExecutor(
          max_workers=self._max_workers,
          thread_name_prefix='answer-grading',
        )
      self._executor.submit(self._run, attempt, key)
    return True

  def _run(self, attempt: UserQuestionAnswer, key: tuple[str, str, str]) -> None:
    try:
      if not self.store.mark_processing(attempt.course_id, attempt.question_id, attempt.id):
        return
      understanding, grading, model = self.service.grade(attempt)
      self.store.save_grading(
        attempt.course_id,
        attempt.question_id,
        attempt.id,
        understanding=understanding,
        grading=grading,
        model=model,
        version=GRADING_VERSION,
      )
    except Exception as exc:  # noqa: BLE001 - persist every provider/render failure for retry.
      self.store.mark_failed(attempt.course_id, attempt.question_id, attempt.id, str(exc))
    finally:
      with self._lock:
        self._in_flight.discard(key)

  def resume_pending(self) -> int:
    attempts = self.store.pending_attempts()
    return sum(1 for attempt in attempts if self.queue(attempt))

  def shutdown(self) -> None:
    with self._lock:
      executor = self._executor
      self._executor = None
    if executor is not None:
      executor.shutdown(wait=True, cancel_futures=False)


__all__ = [
  'AnswerVisualRenderer',
  'GRADING_VERSION',
  'KnowledgeQuestionContextProvider',
  'QuestionContextProvider',
  'UserAnswerGradingCoordinator',
  'UserAnswerGradingError',
  'UserAnswerGradingService',
]
