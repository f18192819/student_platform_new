from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from backend.student_answer_reconstruction import (
  StudentAnswerMineruPreprocessor,
  StudentAnswerMineruResult,
)
from backend.user_answer_grading import UserAnswerGradingService
from backend.user_answers import (
  ReconstructedAnswerBlock,
  ReconstructedQuestionAnswer,
  StudentAnswerReconstruction,
  UserAnswerStore,
)


class Resolver:
  def source_type(self, *_args):
    return 'homework'


def image_bytes() -> bytes:
  output = io.BytesIO()
  Image.new('RGB', (20, 20), 'white').save(output, format='PNG')
  return output.getvalue()


def upload(name: str, data: bytes | None = None):
  if data is None:
    data = image_bytes()
  return SimpleNamespace(filename=name, content_type='image/png', file=io.BytesIO(data))


def mineru_archive(text: str, left: float) -> bytes:
  middle = {
    'pdf_info': [{
      'page_idx': 0,
      'para_blocks': [{
        'type': 'text',
        'bbox': [left, 10, left + 100, 80],
        'text': text,
      }],
    }],
  }
  output = io.BytesIO()
  with zipfile.ZipFile(output, 'w') as package:
    package.writestr('full.md', text)
    package.writestr('middle.json', json.dumps(middle))
  return output.getvalue()


class Parser:
  def __init__(self):
    self.calls = 0

  def parse(self, _path):
    self.calls += 1
    return {'archive': mineru_archive(f'page {self.calls}', self.calls * 10)}


class FailingParser:
  def parse(self, _path):
    raise RuntimeError('mineru unavailable')


class RecordingGrader:
  def __init__(self):
    self.calls = []

  def complete_json(self, **kwargs):
    self.calls.append(kwargs)
    return {
      'score': 1,
      'correct': True,
      'confidence': 1,
      'needs_review': False,
      'error_types': ['no_error'],
      'is_wrong': False,
    }


class StudentAnswerReconstructionTest(unittest.TestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.root = Path(self.temporary.name)
    self.store = UserAnswerStore(self.root / 'courses', Resolver())

  def tearDown(self):
    self.temporary.cleanup()

  def test_multiple_assets_keep_upload_and_page_order(self):
    attempt = self.store.replace(
      'course-1', 'document-1', 'question-1', 'homework',
      [upload('left.png'), upload('right.png')],
    )
    result = StudentAnswerMineruPreprocessor(Parser()).process(
      self.store, attempt, self.root / 'result',
    )

    self.assertTrue(result.mineru_available)
    self.assertEqual([1, 2], [page['page'] for page in result.pages])
    self.assertEqual(['page 1', 'page 2'], [block['text'] for block in result.blocks])
    self.assertEqual(2, result.raw_layout['page_count'])

  def test_mineru_failure_returns_image_only_fallback_state(self):
    attempt = self.store.replace(
      'course-1', 'document-1', 'question-1', 'homework', [upload('answer.png')],
    )
    result = StudentAnswerMineruPreprocessor(FailingParser()).process(
      self.store, attempt, self.root / 'result',
    )

    self.assertFalse(result.mineru_available)
    self.assertIn('mineru unavailable', result.error)

  def test_reconstruction_prompt_excludes_reference_and_defines_evidence_priority(self):
    context = {
      'reference_answer': 'SECRET REFERENCE',
      'all_questions': [
        {'question_id': 'q1', 'index': 1, 'title': 'Q1', 'content': 'first'},
        {'question_id': 'q2', 'index': 2, 'title': 'Q2', 'content': 'second'},
      ],
    }
    mineru = StudentAnswerMineruResult(
      markdown='rough OCR', pages=[{'page': 1, 'blocks': []}], mineru_available=True,
    )

    prompt = UserAnswerGradingService._reconstruction_prompt(context, mineru)
    system = UserAnswerGradingService._reconstruction_system_prompt()

    self.assertNotIn('SECRET REFERENCE', prompt)
    self.assertNotIn('reference_answer', prompt)
    self.assertIn('q1', prompt)
    self.assertIn('q2', prompt)
    self.assertIn('original page images are the strongest evidence', system)
    self.assertIn('Do not assume top-to-bottom reading order', system)
    self.assertIn('exactly one questions item for every supplied question_id', prompt)
    self.assertIn('same order', prompt)
    self.assertIn('confidence=0', prompt)

  def test_question_mapping_and_unassigned_content_are_preserved(self):
    reconstruction = StudentAnswerReconstruction(
      questions=[
        ReconstructedQuestionAnswer(question_id='q1', transcription='left then right', confidence=0.9),
        ReconstructedQuestionAnswer(question_id='q2', transcription='lower region', confidence=0.8),
      ],
      unassigned_blocks=[ReconstructedAnswerBlock(page=1, text='scratch', role='scratch')],
    )

    understanding = UserAnswerGradingService._understanding_for_question(reconstruction, 'q1')

    self.assertEqual('left then right', understanding.transcription)
    self.assertTrue(any('无法关联' in item for item in understanding.uncertain_parts))

  def test_empty_transcription_uses_returned_steps_without_inventing_content(self):
    reconstruction = StudentAnswerReconstruction(questions=[
      ReconstructedQuestionAnswer(
        question_id='q1',
        steps=['first recovered line', 'second recovered line'],
        final_answer='result',
        confidence=0.8,
      ),
    ])

    understanding = UserAnswerGradingService._understanding_for_question(reconstruction, 'q1')

    self.assertEqual('first recovered line\nsecond recovered line', understanding.transcription)

  def test_reference_answer_is_added_only_during_grading(self):
    grader = RecordingGrader()
    service = UserAnswerGradingService.__new__(UserAnswerGradingService)
    service.text_client = grader
    context = {
      'title': 'Q1',
      'content': 'Prompt',
      'analysis': {},
      'reference_answer': 'REFERENCE ONLY FOR GRADING',
      'reference_confidence': 1,
      'reference_needs_review': False,
    }
    service._grade_reconstruction(
      {'baseUrl': 'https://example.test/v1', 'apiKey': 'key', 'model': 'grader'},
      context,
      UserAnswerGradingService._understanding_for_question(
        StudentAnswerReconstruction(questions=[
          ReconstructedQuestionAnswer(question_id='q1', transcription='student work', confidence=0.9),
        ]),
        'q1',
      ),
    )

    grading_input = grader.calls[0]['messages'][1]['content']
    self.assertIn('REFERENCE ONLY FOR GRADING', grading_input)
    self.assertIn('student work', grading_input)

  def test_stage_projections_survive_store_reload(self):
    attempt = self.store.replace(
      'course-1', 'document-1', 'question-1', 'homework', [upload('answer.png')],
    )
    self.store.mark_stage('course-1', 'question-1', attempt.id, 'mineru_processing')
    self.store.save_mineru_projection(
      'course-1', 'question-1', attempt.id,
      status='completed', markdown='recognized', layout={'page_count': 1},
    )
    reconstruction = StudentAnswerReconstruction(questions=[
      ReconstructedQuestionAnswer(question_id='question-1', transcription='answer', confidence=0.8),
    ])
    self.store.save_reconstruction(
      'course-1', 'question-1', attempt.id,
      reconstruction=reconstruction, model='model', version='v1',
    )

    reloaded = UserAnswerStore(self.root / 'courses', Resolver()).get_attempt(
      'course-1', 'document-1', 'question-1', attempt.id,
    )
    self.assertEqual('completed', reloaded.mineru_status)
    self.assertEqual('recognized', reloaded.mineru_markdown)
    self.assertEqual('answer', reloaded.reconstruction.questions[0].transcription)


if __name__ == '__main__':
  unittest.main()
