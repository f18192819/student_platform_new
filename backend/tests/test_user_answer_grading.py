from __future__ import annotations

import io
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import fitz

from backend.user_answer_grading import (
  UserAnswerGradingCoordinator,
  UserAnswerGradingService,
)
from backend.user_answers import UserAnswerStore


PNG = b'\x89PNG\r\n\x1a\n' + b'handwritten-answer'


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


if __name__ == '__main__':
  unittest.main()
