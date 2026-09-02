from __future__ import annotations

import io
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import fitz
from PIL import Image

from backend.user_answer_grading import (
  AnswerVisualRenderer,
  KnowledgeQuestionContextProvider,
  UserAnswerGradingCoordinator,
  UserAnswerGradingError,
  UserAnswerGradingService,
)
from backend.user_answers import UserAnswerStore


def image_bytes(image_format: str = 'PNG') -> bytes:
  output = io.BytesIO()
  Image.new('RGB', (120, 80), 'white').save(output, format=image_format)
  return output.getvalue()


PNG = image_bytes()


class Resolver:
  def source_type(self, _course_id, _source_document_id, _question_id):
    return 'homework'


class ContextProvider:
  def resolve(self, _course_id, _source_document_id, _question_id):
    return {
      'title': 'Question 1',
      'content': 'Calculate the result.',
      'analysis': {'knowledge_points': ['algebra'], 'difficulty': {'level': 2}},
      'reference_answer': '42',
      'reference_confidence': 1.0,
      'reference_needs_review': False,
    }


class ChatClient:
  def __init__(self):
    self.calls = []

  def complete_json(self, **kwargs):
    self.calls.append(kwargs)
    return {
      'understanding': {
        'transcription': '42',
        'steps': ['calculation'],
        'final_answer': '42',
        'uncertain_parts': [],
        'confidence': 0.96,
      },
      'grading': {
        'score': 1.0,
        'correct': True,
        'confidence': 0.95,
        'needs_review': False,
        'summary': 'Correct.',
        'feedback': 'Well done.',
        'error_types': ['no_error'],
        'errors': [],
        'knowledge_points': [{'name': 'algebra', 'status': 'strong', 'evidence': 'Correct result'}],
        'correct_parts': ['Final value'],
        'improvement_suggestions': [],
        'is_wrong': False,
      },
    }


def upload(filename: str, content_type: str, data: bytes):
  return SimpleNamespace(filename=filename, content_type=content_type, file=io.BytesIO(data))


class UserAnswerGradingTest(unittest.TestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.store = UserAnswerStore(Path(self.temporary.name) / 'courses', Resolver())

  def tearDown(self):
    self.temporary.cleanup()

  def _answer(self, filename='answer.png', content_type='image/png', data=PNG):
    return self.store.replace(
      'course-1', 'document-1', 'question-1', 'homework',
      [upload(filename, content_type, data)],
    )

  @patch('backend.user_answer_grading.load_api_config')
  def test_image_grading_persists_structured_projection_and_uses_ocr_model(self, load_config):
    load_config.return_value = {
      'baseUrl': 'https://provider.example/v1',
      'apiKey': 'secret',
      'model': 'text-model',
      'ocrBaseUrl': 'https://vision.example/v1',
      'ocrApiKey': 'vision-secret',
      'ocrModel': 'vision-model',
    }
    answer = self._answer()
    client = ChatClient()
    service = UserAnswerGradingService(self.store, ContextProvider(), client)

    understanding, grading, model = service.grade(answer)
    saved = self.store.save_grading(
      answer.course_id, answer.question_id, answer.id,
      understanding=understanding, grading=grading, model=model, version='v1',
    )

    self.assertEqual('vision-model', client.calls[0]['model'])
    self.assertEqual('https://vision.example/v1', client.calls[0]['base_url'])
    self.assertEqual('vision-secret', client.calls[0]['api_key'])
    self.assertTrue(any(
      item.get('type') == 'image_url'
      for item in client.calls[0]['messages'][1]['content']
    ))
    self.assertEqual('completed', saved.processing_status)
    self.assertEqual(1.0, saved.grading.score)
    self.assertEqual(1, len(saved.grading_revisions))

  @patch('backend.user_answer_grading.load_api_config')
  def test_pdf_is_rendered_as_images_for_multimodal_grading(self, load_config):
    load_config.return_value = {
      'baseUrl': 'https://provider.example/v1', 'apiKey': 'secret', 'ocrModel': 'vision-model',
    }
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), '42')
    pdf = document.tobytes()
    document.close()
    answer = self._answer('answer.pdf', 'application/pdf', pdf)
    client = ChatClient()

    UserAnswerGradingService(self.store, ContextProvider(), client).grade(answer)

    image_items = [
      item for item in client.calls[0]['messages'][1]['content']
      if item.get('type') == 'image_url'
    ]
    self.assertEqual(1, len(image_items))
    self.assertTrue(image_items[0]['image_url']['url'].startswith('data:image/png;base64,'))

  def test_pdf_over_page_limit_fails_attempt_instead_of_silently_truncating(self):
    document = fitz.open()
    for _ in range(17):
      document.new_page()
    answer = self._answer('long.pdf', 'application/pdf', document.tobytes())
    document.close()
    coordinator = UserAnswerGradingCoordinator(
      self.store,
      UserAnswerGradingService(self.store, ContextProvider(), ChatClient()),
      max_workers=1,
    )
    try:
      self.assertTrue(coordinator.queue(answer))
      deadline = time.time() + 3
      current = answer
      while time.time() < deadline:
        current = self.store.get_attempt('course-1', 'document-1', 'question-1', answer.id)
        if current.processing_status == 'failed':
          break
        time.sleep(0.02)
      self.assertEqual('failed', current.processing_status)
      self.assertIn('最多支持 16 页答案', current.grading_error)
    finally:
      coordinator.shutdown()

  def test_supported_question_image_formats_use_safe_derivatives_and_unknown_fails(self):
    renderer = AnswerVisualRenderer()
    with tempfile.TemporaryDirectory() as temporary:
      root = Path(temporary)
      sources = []
      for suffix, image_format in (('.png', 'PNG'), ('.jpg', 'JPEG'), ('.webp', 'WEBP'), ('.gif', 'GIF')):
        path = root / f'source{suffix}'
        path.write_bytes(image_bytes(image_format))
        sources.append(path)
      originals = {path: path.read_bytes() for path in sources}
      rendered = renderer.render_paths(sources, root / 'prepared')

      self.assertEqual(4, len(rendered))
      self.assertEqual(
        ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
        [content_type for _, content_type in rendered],
      )
      self.assertTrue(all(path.parent == root / 'prepared' for path, _ in rendered))
      self.assertEqual(originals, {path: path.read_bytes() for path in sources})
      unsupported = root / 'source.bmp'
      unsupported.write_bytes(image_bytes('BMP'))
      with self.assertRaises(UserAnswerGradingError):
        renderer.render_paths([unsupported], root / 'unknown')

  @patch('backend.user_answer_grading.load_api_config')
  def test_provider_image_budget_fails_without_calling_provider_and_cleans_temp(self, load_config):
    load_config.return_value = {'baseUrl': 'https://provider.example/v1', 'apiKey': 'x', 'ocrModel': 'm'}
    answer = self._answer()
    client = ChatClient()
    created = []
    original_mkdtemp = tempfile.mkdtemp

    def tracked_mkdtemp(*args, **kwargs):
      path = original_mkdtemp(*args, dir=self.temporary.name, **kwargs)
      created.append(Path(path))
      return path

    with (
      patch('backend.user_answer_grading.MAX_PROVIDER_TOTAL_BYTES', 1),
      patch('backend.user_answer_grading.tempfile.mkdtemp', side_effect=tracked_mkdtemp),
    ):
      with self.assertRaises(UserAnswerGradingError):
        UserAnswerGradingService(self.store, ContextProvider(), client).grade(answer)

    self.assertEqual([], client.calls)
    self.assertTrue(created)
    self.assertTrue(all(not path.exists() for path in created))

  def test_multiple_attempts_and_grading_revisions_are_not_overwritten(self):
    first = self._answer()
    second = self._answer()
    understanding = ChatClient().complete_json()['understanding']
    grading = ChatClient().complete_json()['grading']
    from backend.user_answers import AnswerUnderstanding, UserAnswerGrading
    self.store.save_grading(
      'course-1', 'question-1', first.id,
      understanding=AnswerUnderstanding.model_validate(understanding),
      grading=UserAnswerGrading.model_validate(grading), model='m1', version='v1',
    )
    self.store.save_grading(
      'course-1', 'question-1', first.id,
      understanding=AnswerUnderstanding.model_validate(understanding),
      grading=UserAnswerGrading.model_validate(grading), model='m2', version='v2',
    )

    attempts = self.store.list_attempts('course-1', 'document-1', 'question-1')
    reloaded_first = self.store.get_attempt('course-1', 'document-1', 'question-1', first.id)
    self.assertEqual([second.id, first.id], [item.id for item in attempts])
    self.assertEqual(2, len(reloaded_first.grading_revisions))
    self.assertEqual('m1', reloaded_first.grading_revisions[0].model)

  @patch('backend.user_answer_grading.load_api_config')
  def test_unreliable_reference_is_persisted_as_needs_review_not_wrong(self, load_config):
    load_config.return_value = {
      'baseUrl': 'https://provider.example/v1', 'apiKey': 'secret', 'ocrModel': 'vision-model',
    }

    class UncertainContext(ContextProvider):
      def resolve(self, *args):
        context = super().resolve(*args)
        context['reference_needs_review'] = True
        return context

    answer = self._answer()
    understanding, grading, model = UserAnswerGradingService(
      self.store, UncertainContext(), ChatClient(),
    ).grade(answer)
    saved = self.store.save_grading(
      answer.course_id, answer.question_id, answer.id,
      understanding=understanding, grading=grading, model=model, version='v1',
    )

    self.assertEqual('needs_review', saved.processing_status)
    self.assertTrue(saved.grading.needs_review)
    self.assertFalse(saved.grading.is_wrong)

  def test_provider_failure_keeps_assets_and_can_be_retried(self):
    answer = self._answer()

    class FailingService:
      def grade(self, _attempt):
        raise RuntimeError('provider unavailable')

    coordinator = UserAnswerGradingCoordinator(self.store, FailingService(), max_workers=1)
    try:
      self.assertTrue(coordinator.queue(answer))
      self.assertFalse(coordinator.queue(answer))
      deadline = time.time() + 2
      while time.time() < deadline:
        current = self.store.get_attempt('course-1', 'document-1', 'question-1', answer.id)
        if current.processing_status == 'failed':
          break
        time.sleep(0.02)
      self.assertEqual('failed', current.processing_status)
      path, _ = self.store.asset('course-1', 'document-1', 'question-1', answer.assets[0].id, answer.id)
      self.assertTrue(path.is_file())
      self.assertTrue(coordinator.queue(current))
    finally:
      coordinator.shutdown()

  def test_restart_recovers_processing_attempt_and_deletion_prevents_worker_writeback(self):
    answer = self._answer()
    self.assertTrue(self.store.mark_processing(answer.course_id, answer.question_id, answer.id))
    recovered = self.store.pending_attempts()
    self.assertEqual([answer.id], [item.id for item in recovered])
    self.assertEqual('pending', recovered[0].processing_status)

    started = threading.Event()
    release = threading.Event()

    class BlockingService:
      def grade(self, _attempt):
        started.set()
        release.wait(2)
        payload = ChatClient().complete_json()
        from backend.user_answers import AnswerUnderstanding, UserAnswerGrading
        return (
          AnswerUnderstanding.model_validate(payload['understanding']),
          UserAnswerGrading.model_validate(payload['grading']),
          'model',
        )

    coordinator = UserAnswerGradingCoordinator(self.store, BlockingService(), max_workers=1)
    try:
      self.assertTrue(coordinator.queue(recovered[0]))
      self.assertTrue(started.wait(1))
      self.assertTrue(self.store.delete('course-1', 'document-1', 'question-1'))
      release.set()
      coordinator.shutdown()
      self.assertFalse(self.store._question_dir('course-1', 'question-1').exists())
    finally:
      release.set()
      coordinator.shutdown()

  @patch('backend.user_answer_grading.question_image_attachments', return_value=[])
  @patch('backend.user_answer_grading.load_question_record')
  @patch('backend.user_answer_grading.read_knowledge_library')
  def test_reference_reliability_tracks_source_saved_and_missing(
    self, read_library, load_record, _attachments,
  ):
    read_library.return_value = {'courses': [{
      'id': 'course-1',
      'homeworkFolders': [{'homeworkDocuments': [{
        'id': 'document-1',
        'questions': [{'id': 'question-1', 'title': 'Q', 'content': 'Prompt'}],
      }]}],
    }]}

    class References:
      saved = None

      def get_question_reference_answer(self, _course_id, _question_id):
        return self.saved

    references = References()
    provider = KnowledgeQuestionContextProvider(references)
    load_record.return_value = {'id': 'question-1', 'content': 'Prompt', 'reference_answer': '42'}
    source = provider.resolve('course-1', 'document-1', 'question-1')
    self.assertEqual((1.0, False, 'source'), (
      source['reference_confidence'], source['reference_needs_review'], source['reference_source'],
    ))

    references.saved = SimpleNamespace(
      answer_text='AI answer', confidence=0.61, needs_review=True, answer_source='ai_generated',
    )
    saved = provider.resolve('course-1', 'document-1', 'question-1')
    self.assertEqual((0.61, True, 'ai_generated'), (
      saved['reference_confidence'], saved['reference_needs_review'], saved['reference_source'],
    ))

    references.saved = None
    load_record.return_value = {'id': 'question-1', 'content': 'Prompt'}
    missing = provider.resolve('course-1', 'document-1', 'question-1')
    self.assertEqual((0.0, True, 'missing'), (
      missing['reference_confidence'], missing['reference_needs_review'], missing['reference_source'],
    ))


if __name__ == '__main__':
  unittest.main()
