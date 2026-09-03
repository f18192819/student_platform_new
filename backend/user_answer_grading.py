from __future__ import annotations

import base64
import json
import logging
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from PIL import Image, ImageOps

from .deepseek_web_bridge import DeepSeekWebBridgeClient, DeepSeekWebBridgeError
from .knowledge_storage import read_knowledge_library
from .learning_state import LearningStateStore
from .ocr_transport import (
  INCOMPATIBLE_OCR_MESSAGE,
  cache_ocr_transport,
  resolve_ocr_transport,
)
from .provider_models import provider_model_metadata
from .provider_transport import (
  LiteLLMOcrClient,
  MultimodalChatClient,
  ProviderTransportError,
  StructuredChatClient,
  extract_json_object,
  is_multimodal_protocol_error,
  is_ocr_protocol_error,
)
from .question_pipeline import (
  load_question_record,
  question_image_attachments,
  resolve_question_image_asset,
)
from .runtime_config import load_api_config
from .student_answer_reconstruction import (
  StudentAnswerMineruPreprocessor,
  StudentAnswerMineruResult,
  StudentAnswerReconstructionPrompt,
)
from .user_answers import (
  AnswerUnderstanding,
  ReconstructedQuestionAnswer,
  StudentAnswerReconstruction,
  UserAnswerGrading,
  UserAnswerNotFound,
  UserAnswerQuestionResult,
  UserAnswerStore,
  UserQuestionAnswer,
)


GRADING_VERSION = 'user-answer-grading-v1'
RECONSTRUCTION_VERSION = 'student-answer-reconstruction-v1'
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

logger = logging.getLogger(__name__)


class UserAnswerGradingError(RuntimeError):
  pass


@dataclass(frozen=True)
class UserAnswerDocumentGrading:
  question_results: list[UserAnswerQuestionResult]
  model: str


class QuestionContextProvider(Protocol):
  def resolve(self, course_id: str, source_document_id: str, question_id: str) -> dict[str, Any]: ...


class KnowledgeQuestionContextProvider:
  """Read the stable question projection and saved reference answer."""

  def __init__(self, learning_store: LearningStateStore | None = None) -> None:
    self.learning_store = learning_store or LearningStateStore()

  def resolve(self, course_id: str, source_document_id: str, question_id: str) -> dict[str, Any]:
    contexts = self.resolve_document(course_id, source_document_id)
    context = next((item for item in contexts if item['question_id'] == question_id), None)
    if context is None:
      raise UserAnswerGradingError('Question context is no longer available.')
    return context

  def resolve_document(self, course_id: str, source_document_id: str) -> list[dict[str, Any]]:
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
          document_questions = [item for item in document.get('questions') or [] if isinstance(item, dict)]
          all_questions = [
            {
              'question_id': str(item.get('id') or ''),
              'index': index + 1,
              'title': str(item.get('title') or ''),
              'content': str(item.get('content') or ''),
            }
            for index, item in enumerate(document_questions)
            if str(item.get('id') or '')
          ]
          contexts: list[dict[str, Any]] = []
          for index, question in enumerate(document_questions):
            question_id = str(question.get('id') or '')
            if question_id:
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
              contexts.append({
                'question_id': question_id,
                'question_index': index + 1,
                'title': str(question.get('title') or ''),
                'content': str(question.get('content') or ''),
                'analysis': question.get('analysis') if isinstance(question.get('analysis'), dict) else {},
                'reference_answer': reference,
                'reference_confidence': saved.confidence if saved else (1.0 if source_reference else 0.0),
                'reference_needs_review': saved.needs_review if saved else not bool(source_reference),
                'reference_source': saved.answer_source if saved else ('source' if source_reference else 'missing'),
                'question_images': question_images,
                'all_questions': all_questions,
              })
          if contexts:
            return contexts
    raise UserAnswerGradingError('Document question context is no longer available.')


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
  """Orchestrate MinerU evidence, answer reconstruction, then isolated grading."""

  def __init__(
    self,
    store: UserAnswerStore,
    context_provider: QuestionContextProvider | None = None,
    chat_client: MultimodalChatClient | None = None,
    renderer: AnswerVisualRenderer | None = None,
    ocr_client: LiteLLMOcrClient | None = None,
    text_client: StructuredChatClient | None = None,
    web_bridge_client: DeepSeekWebBridgeClient | None = None,
    mineru_preprocessor: StudentAnswerMineruPreprocessor | None = None,
  ) -> None:
    self.store = store
    self.context_provider = context_provider or KnowledgeQuestionContextProvider()
    self.chat_client = chat_client or MultimodalChatClient()
    self.renderer = renderer or AnswerVisualRenderer()
    self.ocr_client = ocr_client or LiteLLMOcrClient()
    self.text_client = text_client or chat_client or StructuredChatClient()
    self.web_bridge_client = web_bridge_client or DeepSeekWebBridgeClient()
    self.mineru_preprocessor = mineru_preprocessor or StudentAnswerMineruPreprocessor()

  def grade(self, attempt: UserQuestionAnswer) -> tuple[AnswerUnderstanding, UserAnswerGrading, str]:
    outcome = self.grade_document(attempt)
    compatibility_result = next(
      (item for item in outcome.question_results if item.question_id == attempt.question_id),
      outcome.question_results[0],
    )
    return compatibility_result.understanding, compatibility_result.grading, outcome.model

  def grade_document(self, attempt: UserQuestionAnswer) -> UserAnswerDocumentGrading:
    config = load_api_config() or {}
    ocr_base_url = str(config.get('ocrBaseUrl') or config.get('baseUrl') or '').strip()
    ocr_api_key = str(config.get('ocrApiKey') or config.get('apiKey') or '').strip()
    ocr_model = str(config.get('ocrModel') or config.get('model') or '').strip()
    contexts = self._document_contexts(attempt)
    context = next(
      (item for item in contexts if item.get('question_id') == attempt.question_id),
      contexts[0],
    )
    context.setdefault('question_id', attempt.question_id)
    context.setdefault('all_questions', [{
      'question_id': attempt.question_id,
      'index': 1,
      'title': str(context.get('title') or ''),
      'content': str(context.get('content') or ''),
    }])
    temporary = Path(tempfile.mkdtemp(prefix=f'user-answer-{attempt.id[:8]}-'))
    try:
      images = self.renderer.render(self.store, attempt, temporary)
      if not images:
        raise UserAnswerGradingError('The answer contains no visual content to grade.')
      mineru = self.mineru_preprocessor.process(self.store, attempt, temporary / 'mineru-evidence')
      if self.store.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
        self.store.save_mineru_projection(
          attempt.course_id,
          attempt.question_id,
          attempt.id,
          status='completed' if mineru.mineru_available else 'failed',
          markdown=mineru.markdown,
          layout=mineru.raw_layout,
          error=mineru.error,
        )
        self.store.mark_stage(attempt.course_id, attempt.question_id, attempt.id, 'reconstructing')

      reconstruction, reconstruction_model = self._reconstruct(
        config, context, images, mineru, ocr_base_url, ocr_api_key, ocr_model,
      )
      if self.store.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
        self.store.save_reconstruction(
          attempt.course_id,
          attempt.question_id,
          attempt.id,
          reconstruction=reconstruction,
          model=reconstruction_model,
          version=RECONSTRUCTION_VERSION,
        )
        self.store.mark_stage(attempt.course_id, attempt.question_id, attempt.id, 'grading')

      question_results: list[UserAnswerQuestionResult] = []
      grading_model = ''
      for index, question_context in enumerate(contexts):
        question_id = str(question_context.get('question_id') or '')
        understanding = self._understanding_for_question(reconstruction, question_id)
        grading_payload, grading_model = self._grade_reconstruction(
          config, question_context, understanding,
        )
        grading = self._validate_grading(grading_payload, question_context, understanding)
        question_results.append(UserAnswerQuestionResult(
          question_id=question_id,
          question_index=int(question_context.get('question_index') or index + 1),
          title=str(question_context.get('title') or ''),
          content=str(question_context.get('content') or ''),
          understanding=understanding,
          grading=grading,
        ))
      return UserAnswerDocumentGrading(question_results=question_results, model=grading_model)
    except ProviderTransportError as exc:
      raise UserAnswerGradingError(str(exc)) from exc
    finally:
      shutil.rmtree(temporary, ignore_errors=True)

  def _document_contexts(self, attempt: UserQuestionAnswer) -> list[dict[str, Any]]:
    resolve_document = getattr(self.context_provider, 'resolve_document', None)
    if callable(resolve_document):
      contexts = resolve_document(attempt.course_id, attempt.source_document_id)
      if contexts:
        return contexts
    context = self.context_provider.resolve(
      attempt.course_id, attempt.source_document_id, attempt.question_id,
    )
    context.setdefault('question_id', attempt.question_id)
    context.setdefault('question_index', 1)
    return [context]

  def _reconstruct(
    self,
    config: dict[str, Any],
    context: dict[str, Any],
    images: list[tuple[Path, str]],
    mineru: StudentAnswerMineruResult,
    base_url: str,
    api_key: str,
    model: str,
  ) -> tuple[StudentAnswerReconstruction, str]:
    prompt = StudentAnswerReconstructionPrompt.build(context, mineru)
    if str(config.get('ocrProvider') or 'api') == 'deepseek-web':
      try:
        raw = self.web_bridge_client.ocr(
          str(config.get('deepseekWebBridgeUrl') or '').strip(),
          [path for path, _ in images],
          prompt=prompt,
        )
      except DeepSeekWebBridgeError as exc:
        raise UserAnswerGradingError(str(exc)) from exc
      return self._parse_reconstruction(raw, context), 'deepseek-web'

    metadata = provider_model_metadata(base_url, model)
    transport = resolve_ocr_transport(model, metadata, base_url=base_url)
    if transport == 'litellm_ocr':
      try:
        transcription, _ = self._transcribe_images(
          images, base_url, api_key, model, 'Student answer', MAX_PROVIDER_TOTAL_BYTES,
        )
      except ProviderTransportError as exc:
        if is_ocr_protocol_error(exc):
          raise UserAnswerGradingError(INCOMPATIBLE_OCR_MESSAGE) from exc
        raise
      cache_ocr_transport(base_url, model, 'litellm_ocr')
      return self._reconstruct_from_text(config, context, mineru, transcription)

    try:
      reconstruction = self._reconstruct_via_vision(
        prompt, context, images, base_url, api_key, model,
      )
      cache_ocr_transport(base_url, model, 'openai_chat_vision')
      return reconstruction, model
    except ProviderTransportError as chat_error:
      if not is_multimodal_protocol_error(chat_error):
        raise
      logger.warning('Vision reconstruction rejected image input for %s: %s', model, chat_error)
      try:
        transcription, _ = self._transcribe_images(
          images, base_url, api_key, model, 'Student answer', MAX_PROVIDER_TOTAL_BYTES,
        )
      except ProviderTransportError as ocr_error:
        logger.warning('OCR fallback failed for %s: %s', model, ocr_error)
        raise UserAnswerGradingError(INCOMPATIBLE_OCR_MESSAGE) from ocr_error
      cache_ocr_transport(base_url, model, 'litellm_ocr')
      return self._reconstruct_from_text(config, context, mineru, transcription)

  def _reconstruct_via_vision(
    self,
    prompt: str,
    context: dict[str, Any],
    images: list[tuple[Path, str]],
    base_url: str,
    api_key: str,
    model: str,
  ) -> StudentAnswerReconstruction:
    content: list[dict[str, Any]] = [{'type': 'text', 'text': prompt}]
    remaining_bytes = MAX_PROVIDER_TOTAL_BYTES
    for path, content_type in images:
      url, byte_size = _data_url(path, content_type, remaining_bytes)
      remaining_bytes -= byte_size
      content.append({'type': 'image_url', 'image_url': {'url': url, 'detail': 'high'}})
    payload = self.chat_client.complete_json(
      base_url=base_url,
      api_key=api_key,
      model=model,
      messages=[
        {'role': 'user', 'content': content},
      ],
      schema=self._reconstruction_schema(),
      schema_name='student_answer_reconstruction',
      timeout=300,
      allow_plain_fallback=True,
    )
    return self._normalize_reconstruction(payload, context)

  def _reconstruct_from_text(
    self,
    config: dict[str, Any],
    context: dict[str, Any],
    mineru: StudentAnswerMineruResult,
    transcription: str,
  ) -> tuple[StudentAnswerReconstruction, str]:
    base_url, api_key, model = self._text_configuration(config)
    payload = self.text_client.complete_json(
      base_url=base_url,
      api_key=api_key,
      model=model,
      messages=[
        {
          'role': 'user',
          'content': StudentAnswerReconstructionPrompt.build(context, mineru, transcription),
        },
      ],
      schema=self._reconstruction_schema(),
      schema_name='student_answer_reconstruction',
      timeout=180,
      allow_plain_fallback=True,
    )
    return self._normalize_reconstruction(payload, context, transcription), model

  def _grade_reconstruction(
    self,
    config: dict[str, Any],
    context: dict[str, Any],
    understanding: AnswerUnderstanding,
  ) -> tuple[dict[str, Any], str]:
    if str(config.get('ocrProvider') or 'api') == 'deepseek-web':
      bridge_url = str(config.get('deepseekWebBridgeUrl') or '').strip()
      prompt = '\n\n'.join([
        self._grading_system_prompt(
          'The student answer has already been reconstructed. Grade only that reconstruction against the reference.',
        ),
        'Return one JSON object matching this JSON Schema:',
        json.dumps(self._grading_schema(), ensure_ascii=False),
        'INPUT:',
        json.dumps(self._grading_context(context) | {
          'reconstructed_student_answer': understanding.model_dump(),
        }, ensure_ascii=False),
      ])
      try:
        raw = self.web_bridge_client.chat(bridge_url, prompt, timeout=180)
        return extract_json_object(raw), 'deepseek-web'
      except DeepSeekWebBridgeError as exc:
        raise UserAnswerGradingError(str(exc)) from exc
      except ProviderTransportError as exc:
        raise UserAnswerGradingError('DeepSeek 网页返回的批改结果格式无效，请重新批改。') from exc

    base_url, api_key, model = self._text_configuration(config)
    payload = self.text_client.complete_json(
      base_url=base_url,
      api_key=api_key,
      model=model,
      messages=[
        {
          'role': 'system',
          'content': self._grading_system_prompt(
            'The student answer has already been reconstructed. Grade only that reconstruction against the reference.',
          ),
        },
        {
          'role': 'user',
          'content': json.dumps(self._grading_context(context) | {
            'reconstructed_student_answer': understanding.model_dump(),
          }, ensure_ascii=False),
        },
      ],
      schema=self._grading_schema(),
      schema_name='user_answer_grading',
      timeout=180,
      allow_plain_fallback=True,
    )
    return payload, model

  @staticmethod
  def _text_configuration(config: dict[str, Any]) -> tuple[str, str, str]:
    values = (
      str(config.get('baseUrl') or '').strip(),
      str(config.get('apiKey') or '').strip(),
      str(config.get('model') or config.get('ocrModel') or '').strip(),
    )
    if not all(values):
      raise ProviderTransportError(
        'Text model configuration is required after answer reconstruction.',
        error_type='configuration_error',
      )
    return values

  @staticmethod
  def _reconstruction_system_prompt() -> str:
    return StudentAnswerReconstructionPrompt.system_instructions()

  @classmethod
  def _reconstruction_prompt(
    cls,
    context: dict[str, Any],
    mineru: StudentAnswerMineruResult,
    provider_ocr: str = '',
  ) -> str:
    return StudentAnswerReconstructionPrompt.input_payload(context, mineru, provider_ocr)

  @staticmethod
  def _normalize_reconstruction(
    payload: dict[str, Any],
    context: dict[str, Any],
    fallback_transcription: str = '',
  ) -> StudentAnswerReconstruction:
    if isinstance(payload.get('questions'), list):
      return StudentAnswerReconstruction.model_validate(payload)
    legacy = payload.get('understanding') if isinstance(payload.get('understanding'), dict) else None
    if legacy or fallback_transcription:
      source = legacy or {}
      question_id = str(context.get('question_id') or '')
      return StudentAnswerReconstruction(questions=[ReconstructedQuestionAnswer(
        question_id=question_id,
        transcription=fallback_transcription or str(source.get('transcription') or ''),
        steps=list(source.get('steps') or []),
        final_answer=str(source.get('final_answer') or ''),
        confidence=float(source.get('confidence') or (0.35 if fallback_transcription else 0.0)),
        uncertain_parts=list(source.get('uncertain_parts') or []),
      )])
    return StudentAnswerReconstruction()

  @classmethod
  def _parse_reconstruction(cls, raw: str, context: dict[str, Any]) -> StudentAnswerReconstruction:
    try:
      return cls._normalize_reconstruction(extract_json_object(raw), context, raw)
    except (ProviderTransportError, ValueError, TypeError):
      return cls._normalize_reconstruction({}, context, raw)

  @staticmethod
  def _understanding_for_question(
    reconstruction: StudentAnswerReconstruction,
    question_id: str,
  ) -> AnswerUnderstanding:
    answer = next((item for item in reconstruction.questions if item.question_id == question_id), None)
    if answer is None:
      return AnswerUnderstanding(
        transcription='[无法辨认]',
        uncertain_parts=['无法把上传内容可靠地关联到当前题目。'],
        confidence=0.0,
      )
    uncertainties = list(answer.uncertain_parts)
    confidence = answer.confidence
    if reconstruction.unassigned_blocks:
      uncertainties.append('页面中仍有无法关联到具体题目的内容。')
      confidence = min(confidence, 0.54)
    transcription = answer.transcription.strip()
    if not transcription:
      transcription = '\n'.join(item.strip() for item in answer.steps if item.strip())
    if not transcription and answer.final_answer.strip():
      transcription = answer.final_answer.strip()
    if not transcription:
      transcription = '\n'.join(
        block.text.strip() for block in answer.blocks if block.text.strip()
      )
    return AnswerUnderstanding(
      transcription=transcription,
      steps=answer.steps,
      final_answer=answer.final_answer,
      uncertain_parts=uncertainties,
      confidence=confidence,
    )

  def _grade_via_vision(
    self,
    context: dict[str, Any],
    question_images: list[tuple[Path, str]],
    answer_images: list[tuple[Path, str]],
    schema: dict[str, Any],
    base_url: str,
    api_key: str,
    model: str,
  ) -> dict[str, Any]:
    user_content: list[dict[str, Any]] = [{
      'type': 'text',
      'text': json.dumps(self._grading_context(context) | {
        'instruction': (
          'Question source images, if available, appear first. A separator then marks the student answer '
          'images, which are ordered by upload and PDF page.'
        ),
      }, ensure_ascii=False),
    }]
    remaining_bytes = MAX_PROVIDER_TOTAL_BYTES
    for question_image, content_type in question_images:
      url, byte_size = _data_url(question_image, content_type, remaining_bytes)
      remaining_bytes -= byte_size
      user_content.append({'type': 'image_url', 'image_url': {'url': url, 'detail': 'high'}})
    user_content.append({'type': 'text', 'text': 'Student answer images begin below.'})
    for path, content_type in answer_images:
      url, byte_size = _data_url(path, content_type, remaining_bytes)
      remaining_bytes -= byte_size
      user_content.append({'type': 'image_url', 'image_url': {'url': url, 'detail': 'high'}})
    return self.chat_client.complete_json(
      base_url=base_url,
      api_key=api_key,
      model=model,
      messages=[
        {'role': 'system', 'content': self._grading_system_prompt('Read all images in order.')},
        {'role': 'user', 'content': user_content},
      ],
      schema=schema,
      schema_name='user_answer_grading',
      timeout=240,
      allow_plain_fallback=True,
    )

  def _grade_via_ocr(
    self,
    config: dict[str, Any],
    context: dict[str, Any],
    question_images: list[tuple[Path, str]],
    answer_images: list[tuple[Path, str]],
    schema: dict[str, Any],
  ) -> tuple[dict[str, Any], str, str]:
    ocr_base_url = str(config.get('ocrBaseUrl') or config.get('baseUrl') or '').strip()
    ocr_api_key = str(config.get('ocrApiKey') or config.get('apiKey') or '').strip()
    ocr_model = str(config.get('ocrModel') or config.get('model') or '').strip()
    question_transcription, remaining_bytes = self._transcribe_images(
      question_images, ocr_base_url, ocr_api_key, ocr_model, 'Question source',
      MAX_PROVIDER_TOTAL_BYTES,
    )
    answer_transcription, _ = self._transcribe_images(
      answer_images, ocr_base_url, ocr_api_key, ocr_model, 'Student answer', remaining_bytes,
    )

    payload, grading_model = self._grade_transcription(
      config, context, schema, question_transcription, answer_transcription,
    )
    return payload, answer_transcription, grading_model

  def _grade_via_web_bridge(
    self,
    config: dict[str, Any],
    context: dict[str, Any],
    question_images: list[tuple[Path, str]],
    answer_images: list[tuple[Path, str]],
    schema: dict[str, Any],
  ) -> tuple[dict[str, Any], str, str]:
    bridge_url = str(config.get('deepseekWebBridgeUrl') or '').strip()
    question_transcription = ''
    if question_images:
      question_transcription = self.web_bridge_client.ocr(
        bridge_url,
        [path for path, _ in question_images],
        prompt=(
          '请忠实转写这些题目原图，保留题号、条件、图注与数学公式。'
          '不要解题，不要补充原图中不存在的内容。'
        ),
      )
    answer_transcription = self.web_bridge_client.ocr(
      bridge_url,
      [path for path, _ in answer_images],
    )
    payload, grading_model = self._grade_transcription(
      config, context, schema, question_transcription, answer_transcription,
    )
    return payload, answer_transcription, grading_model

  def _grade_transcription(
    self,
    config: dict[str, Any],
    context: dict[str, Any],
    schema: dict[str, Any],
    question_transcription: str,
    answer_transcription: str,
  ) -> tuple[dict[str, Any], str]:
    text_base_url = str(config.get('baseUrl') or '').strip()
    text_api_key = str(config.get('apiKey') or '').strip()
    text_model = str(config.get('model') or '').strip()
    if not text_base_url or not text_api_key or not text_model:
      raise ProviderTransportError(
        'Text model configuration is required after OCR transcription.',
        error_type='configuration_error',
      )
    payload = self.text_client.complete_json(
      base_url=text_base_url,
      api_key=text_api_key,
      model=text_model,
      messages=[
        {
          'role': 'system',
          'content': self._grading_system_prompt(
            'The images were transcribed by a separate OCR model. Grade only from the supplied text and '
            'preserve uncertainty when OCR may be incomplete.',
          ),
        },
        {
          'role': 'user',
          'content': json.dumps(self._grading_context(context) | {
            'question_source_ocr': question_transcription,
            'student_answer_ocr': answer_transcription,
          }, ensure_ascii=False),
        },
      ],
      schema=schema,
      schema_name='user_answer_grading',
      timeout=180,
      allow_plain_fallback=True,
    )
    return payload, text_model

  def _transcribe_images(
    self,
    images: list[tuple[Path, str]],
    base_url: str,
    api_key: str,
    model: str,
    label: str,
    remaining_bytes: int,
  ) -> tuple[str, int]:
    pages: list[str] = []
    for index, (path, content_type) in enumerate(images, start=1):
      url, byte_size = _data_url(path, content_type, remaining_bytes)
      remaining_bytes -= byte_size
      markdown = self.ocr_client.transcribe(
        base_url=base_url,
        api_key=api_key,
        model=model,
        image_url=url,
        timeout=240,
      )
      pages.append(f'## {label} {index}\n\n{markdown}')
    return '\n\n'.join(pages), remaining_bytes

  @staticmethod
  def _grading_context(context: dict[str, Any]) -> dict[str, Any]:
    return {
      'question': {'title': context['title'], 'content': context['content']},
      'question_analysis': context['analysis'],
      'reference_answer': context['reference_answer'],
      'reference_reliability': {
        'confidence': context['reference_confidence'],
        'needs_review': context['reference_needs_review'],
      },
    }

  @staticmethod
  def _grading_system_prompt(input_instruction: str) -> str:
    return (
      'You grade a student handwritten answer. '
      f'{input_instruction} Return only the requested structured JSON. '
      'Preserve uncertainty: if handwriting, OCR, or the reference answer is unreliable, set '
      'needs_review=true. Diagnose evidence, not personality. Scores are 0..1. Do not invent missing work. '
      'error_types must use the supplied enum. Write every mathematical expression as LaTeX enclosed in '
      '$...$ for inline math or $$...$$ for display math.'
    )

  @staticmethod
  def _validate_result(
    payload: dict[str, Any],
    context: dict[str, Any],
    fallback_transcription: str,
  ) -> tuple[AnswerUnderstanding, UserAnswerGrading]:
    understanding_payload = dict(payload.get('understanding') or {})
    if fallback_transcription:
      understanding_payload['transcription'] = fallback_transcription
    understanding = AnswerUnderstanding.model_validate(understanding_payload)
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
    return understanding, UserAnswerGrading.model_validate(grading_payload)

  @staticmethod
  def _validate_grading(
    payload: dict[str, Any],
    context: dict[str, Any],
    understanding: AnswerUnderstanding,
  ) -> UserAnswerGrading:
    grading_payload = dict(payload.get('grading') or payload)
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
    return UserAnswerGrading.model_validate(grading_payload)

  @staticmethod
  def _reconstruction_schema() -> dict[str, Any]:
    return StudentAnswerReconstructionPrompt.schema()

  @staticmethod
  def _grading_schema() -> dict[str, Any]:
    return UserAnswerGrading.model_json_schema()

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
      if not self.store.mark_stage(
        attempt.course_id, attempt.question_id, attempt.id, 'mineru_processing',
      ):
        return
      if not self.store.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
        return
      grade_document = getattr(self.service, 'grade_document', None)
      if not callable(grade_document):
        understanding, grading, model = self.service.grade(attempt)
        outcome = UserAnswerDocumentGrading(
          question_results=[UserAnswerQuestionResult(
            question_id=attempt.question_id,
            understanding=understanding,
            grading=grading,
          )],
          model=model,
        )
      else:
        outcome = grade_document(attempt)
      if not self.store.attempt_exists(attempt.course_id, attempt.question_id, attempt.id):
        return
      self.store.save_document_grading(
        attempt.course_id,
        attempt.question_id,
        attempt.id,
        question_results=outcome.question_results,
        model=outcome.model,
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
  'UserAnswerDocumentGrading',
  'UserAnswerGradingError',
  'UserAnswerGradingService',
]
