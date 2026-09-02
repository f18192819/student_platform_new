from __future__ import annotations

import base64
import json
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Protocol

from PIL import Image, ImageOps

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
  UserAnswerNotFound,
  UserAnswerStore,
  UserQuestionAnswer,
)


GRADING_VERSION = 'user-answer-grading-v1'
MAX_PDF_PAGES = 16
MAX_PROVIDER_IMAGE_EDGE = 2400
MAX_PROVIDER_IMAGE_PIXELS = 5_000_000
MAX_SOURCE_IMAGE_PIXELS = 40_000_000
MAX_PROVIDER_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PROVIDER_TOTAL_BYTES = 24 * 1024 * 1024

IMAGE_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}


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
              source_reference = str(
                source_question.get('reference_answer')
                or source_question.get('standard_answer')
                or source_question.get('answer')
                or question.get('reference_answer')
                or question.get('standard_answer')
                or question.get('answer')
                or '',
              ).strip()
              reference = saved.answer_text if saved else source_reference
              return {
                'title': str(question.get('title') or ''),
                'content': str(question.get('content') or ''),
                'analysis': question.get('analysis') if isinstance(question.get('analysis'), dict) else {},
                'reference_answer': reference,
                'reference_confidence': saved.confidence if saved else (1.0 if source_reference else 0.0),
                'reference_needs_review': saved.needs_review if saved else not bool(source_reference),
                'reference_source': saved.answer_source if saved else ('source' if source_reference else 'missing'),
                'question_images': question_images,
              }
    raise UserAnswerGradingError('Question context is no longer available.')


def _image_content_type(path: Path) -> str:
  content_type = IMAGE_CONTENT_TYPES.get(path.suffix.lower())
  if content_type is None:
    raise UserAnswerGradingError(f'Unsupported question image format: {path.suffix or "unknown"}.')
  return content_type


def _data_url(path: Path, content_type: str, remaining_bytes: int) -> tuple[str, int]:
  byte_size = path.stat().st_size
  if byte_size > MAX_PROVIDER_IMAGE_BYTES:
    raise UserAnswerGradingError('A prepared image is too large for grading. Please reduce its resolution.')
  if byte_size > remaining_bytes:
    raise UserAnswerGradingError('The answer images exceed the grading request size limit.')
  with path.open('rb') as source:
    content = source.read(MAX_PROVIDER_IMAGE_BYTES + 1)
  if len(content) != byte_size or len(content) > MAX_PROVIDER_IMAGE_BYTES:
    raise UserAnswerGradingError('Unable to safely read a prepared grading image.')
  encoded = base64.b64encode(content).decode('ascii')
  return f'data:{content_type};base64,{encoded}', byte_size


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
        rendered.append(self._render_image(path, target / 'images' / f'{asset.order:03d}-{asset.id}'))
        continue
      rendered.extend(self._render_pdf(path, target / asset.id))
    return rendered

  def render_paths(self, paths: list[Path], target: Path) -> list[tuple[Path, str]]:
    return [
      self._render_image(path, target / f'{index:03d}-{path.stem}')
      for index, path in enumerate(paths)
    ]

  @staticmethod
  def _render_image(path: Path, target: Path) -> tuple[Path, str]:
    content_type = _image_content_type(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
      with Image.open(path) as source:
        source.seek(0)
        image = ImageOps.exif_transpose(source).copy()
      width, height = image.size
      if width <= 0 or height <= 0 or width * height > MAX_SOURCE_IMAGE_PIXELS:
        raise UserAnswerGradingError('An image is too large to process safely.')
      scale = min(
        1.0,
        MAX_PROVIDER_IMAGE_EDGE / max(width, height),
        (MAX_PROVIDER_IMAGE_PIXELS / (width * height)) ** 0.5,
      )
      if scale < 1.0:
        image = image.resize(
          (max(1, round(width * scale)), max(1, round(height * scale))),
          Image.Resampling.LANCZOS,
        )
      if content_type == 'image/png':
        output = target.with_suffix('.png')
        image.save(output, format='PNG', optimize=True)
        return output, 'image/png'
      if content_type == 'image/webp':
        output = target.with_suffix('.webp')
        image.save(output, format='WEBP', quality=92, method=6)
        return output, 'image/webp'
      if content_type == 'image/gif':
        output = target.with_suffix('.gif')
        image.convert('P', palette=Image.Palette.ADAPTIVE).save(output, format='GIF')
        return output, 'image/gif'
      output = target.with_suffix('.jpg')
      image.convert('RGB').save(output, format='JPEG', quality=92, optimize=True, subsampling=0)
      return output, 'image/jpeg'
    except UserAnswerGradingError:
      raise
    except Exception as exc:
      raise UserAnswerGradingError(f'Unable to prepare image {path.name}: {exc}') from exc

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
        if document.page_count > MAX_PDF_PAGES:
          raise UserAnswerGradingError(
            f'当前答案共 {document.page_count} 页，最多支持 {MAX_PDF_PAGES} 页答案，请拆分后重新上传。',
          )
        for index, page in enumerate(document):
          raw_output = target / f'.raw-page-{index + 1}.png'
          page.get_pixmap(matrix=fitz.Matrix(1.7, 1.7), alpha=False).save(raw_output)
          try:
            pages.append(AnswerVisualRenderer._render_image(
              raw_output, target / f'page-{index + 1}',
            ))
          finally:
            raw_output.unlink(missing_ok=True)
    except UserAnswerGradingError:
      raise
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
      question_images = self.renderer.render_paths(
        list(context.get('question_images') or []), temporary / 'question-images',
      )
      remaining_bytes = MAX_PROVIDER_TOTAL_BYTES
      for question_image, content_type in question_images:
        url, byte_size = _data_url(question_image, content_type, remaining_bytes)
        remaining_bytes -= byte_size
        user_content.append({
          'type': 'image_url',
          'image_url': {'url': url, 'detail': 'high'},
        })
      user_content.append({'type': 'text', 'text': 'Student answer images begin below.'})
      for path, content_type in images:
        url, byte_size = _data_url(path, content_type, remaining_bytes)
        remaining_bytes -= byte_size
        user_content.append({
          'type': 'image_url',
          'image_url': {'url': url, 'detail': 'high'},
        })
      payload = self.chat_client.complete_json(
        base_url=str(config.get('ocrBaseUrl') or config.get('baseUrl') or ''),
        api_key=str(config.get('ocrApiKey') or config.get('apiKey') or ''),
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
      if not self.store.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
        return
      understanding, grading, model = self.service.grade(attempt)
      if not self.store.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
        return
      self.store.save_grading(
        attempt.course_id,
        attempt.question_id,
        attempt.id,
        understanding=understanding,
        grading=grading,
        model=model,
        version=GRADING_VERSION,
      )
    except UserAnswerNotFound:
      return
    except Exception as exc:  # noqa: BLE001 - persist every provider/render failure for retry.
      if self.store.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
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
