from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.user_answer_router import create_user_answer_router
from backend.user_answers import UserAnswerCorruptionError, UserAnswerStore
from backend.pipeline_router import PipelineApiService


PNG = b'\x89PNG\r\n\x1a\n' + b'image-one'
JPEG = b'\xff\xd8\xff' + b'image-two'
PDF = b'%PDF-1.4\nanswer pdf'


class Resolver:
  def __init__(self, values):
    self.values = values

  def source_type(self, course_id, source_document_id, question_id):
    return self.values[(course_id, source_document_id, question_id)]


def upload(filename: str, content_type: str, content: bytes):
  return SimpleNamespace(filename=filename, content_type=content_type, file=io.BytesIO(content))


class UserAnswerStoreTest(unittest.TestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    self.root = Path(self.temporary.name) / 'courses'
    self.identities = {
      ('course-1', 'homework-1', 'q1'): 'homework',
      ('course-1', 'homework-1', 'q2'): 'homework',
      ('course-1', 'exam-1', 'q3'): 'past-exam',
      ('course-2', 'homework-2', 'q1'): 'homework',
    }
    self.store = UserAnswerStore(self.root, Resolver(self.identities))

  def tearDown(self):
    self.temporary.cleanup()

  def test_homework_multi_image_order_persists_across_store_instances(self):
    answer = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('page-2.jpg', 'image/jpeg', JPEG), upload('page-1.png', 'image/png', PNG)],
    )

    reloaded = UserAnswerStore(self.root, Resolver(self.identities)).get(
      'course-1', 'homework-1', 'q1',
    )

    self.assertIsNotNone(reloaded)
    self.assertEqual(['page-2.jpg', 'page-1.png'], [item.filename for item in reloaded.assets])
    self.assertEqual([0, 1], [item.order for item in reloaded.assets])
    self.assertEqual(answer.id, reloaded.id)

  def test_past_exam_pdf_can_be_saved_and_read_back(self):
    answer = self.store.replace(
      'course-1', 'exam-1', 'q3', 'past-exam',
      [upload('solution.pdf', 'application/pdf', PDF)],
    )
    path, asset = self.store.asset('course-1', 'exam-1', 'q3', answer.assets[0].id)

    self.assertEqual('pdf', asset.kind)
    self.assertEqual(PDF, path.read_bytes())

  def test_document_answer_is_shared_by_questions_but_courses_remain_isolated(self):
    self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('q1.png', 'image/png', PNG)],
    )
    self.store.replace(
      'course-2', 'homework-2', 'q1', 'homework',
      [upload('course-2.jpg', 'image/jpeg', JPEG)],
    )

    self.assertEqual('q1', self.store.get('course-1', 'homework-1', 'q2').question_id)
    self.assertEqual(
      'q1.png', self.store.get('course-1', 'homework-1', 'q1').assets[0].filename,
    )
    self.assertEqual(
      'course-2.jpg', self.store.get('course-2', 'homework-2', 'q1').assets[0].filename,
    )

  def test_replace_keeps_attempt_ready_history_and_delete_removes_answer(self):
    first = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('first.png', 'image/png', PNG)],
    )
    second = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('second.jpg', 'image/jpeg', JPEG)],
    )
    record = self.store._read_record('course-1', 'q1')

    self.assertEqual(2, second.attempt_number)
    self.assertEqual([first.id, second.id], [item.id for item in record.attempts])
    self.assertTrue(self.store.delete('course-1', 'homework-1', 'q1'))
    self.assertIsNone(self.store.get('course-1', 'homework-1', 'q1'))

  def test_missing_record_is_empty_but_corrupt_record_blocks_reads_and_reupload(self):
    self.assertIsNone(self.store.get('course-1', 'homework-1', 'q1'))
    record_path = self.store._record_path('course-1', 'q1')
    record_path.parent.mkdir(parents=True)
    damaged = b'{not-valid-json'
    record_path.write_bytes(damaged)

    with self.assertRaises(UserAnswerCorruptionError):
      self.store.get('course-1', 'homework-1', 'q1')
    with self.assertRaises(UserAnswerCorruptionError):
      self.store.replace(
        'course-1', 'homework-1', 'q1', 'homework',
        [upload('replacement.png', 'image/png', PNG)],
      )

    self.assertEqual(damaged, record_path.read_bytes())
    self.assertFalse((record_path.parent / 'attempts').exists())

  def test_record_writes_are_atomic_and_keep_last_valid_backup(self):
    first = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('first.png', 'image/png', PNG)],
    )
    self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('second.png', 'image/png', PNG)],
    )
    record_path = self.store._record_path('course-1', 'q1')
    backup = json.loads(record_path.with_name('record.json.bak').read_text(encoding='utf-8'))

    self.assertEqual(first.id, backup['current_attempt_id'])
    self.assertFalse(any(record_path.parent.glob('*.tmp')))

  def test_failed_metadata_commit_removes_staged_attempt_and_preserves_record(self):
    first = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('first.png', 'image/png', PNG)],
    )
    record_path = self.store._record_path('course-1', 'q1')
    original = record_path.read_bytes()
    real_write = __import__('backend.user_answers', fromlist=['write_json_atomic']).write_json_atomic

    def fail_main(path, value):
      if path == record_path:
        raise OSError('disk full')
      return real_write(path, value)

    with patch('backend.user_answers.write_json_atomic', side_effect=fail_main):
      with self.assertRaises(OSError):
        self.store.replace(
          'course-1', 'homework-1', 'q1', 'homework',
          [upload('second.png', 'image/png', PNG)],
        )

    self.assertEqual(original, record_path.read_bytes())
    attempt_dirs = [item.name for item in (record_path.parent / 'attempts').iterdir()]
    self.assertEqual([first.id], attempt_dirs)

  def test_source_document_and_course_cleanup_remove_assets(self):
    self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework',
      [upload('q1.png', 'image/png', PNG)],
    )
    self.store.replace(
      'course-1', 'homework-1', 'q2', 'homework',
      [upload('q2.jpg', 'image/jpeg', JPEG)],
    )
    self.store.replace(
      'course-2', 'homework-2', 'q1', 'homework',
      [upload('other.png', 'image/png', PNG)],
    )

    self.assertEqual(2, self.store.delete_document('course-1', 'homework-1'))
    self.assertIsNone(self.store.get('course-1', 'homework-1', 'q1'))
    self.assertIsNotNone(self.store.get('course-2', 'homework-2', 'q1'))
    self.assertTrue(self.store.delete_course('course-2'))
    self.assertFalse((self.root / 'course-2').exists())

  def test_router_exposes_upload_read_asset_and_delete_contract(self):
    queued = []
    grading = SimpleNamespace(queue=lambda answer: queued.append(answer.id) or True)
    app = FastAPI()
    app.include_router(create_user_answer_router(self.store, grading))
    client = TestClient(app)
    base = '/api/user-answers/courses/course-1/documents/homework-1/questions/q1'

    response = client.post(
      base,
      data={'source_type': 'homework'},
      files=[
        ('files', ('one.png', PNG, 'image/png')),
        ('files', ('two.jpg', JPEG, 'image/jpeg')),
      ],
    )
    self.assertEqual(200, response.status_code)
    answer = response.json()['answer']
    self.assertEqual(['one.png', 'two.jpg'], [item['filename'] for item in answer['assets']])
    self.assertEqual([answer['id']], queued)
    self.assertEqual(answer['id'], client.get(base).json()['answer']['id'])
    self.assertEqual(answer['id'], client.get(f'{base}/attempts').json()['attempts'][0]['id'])
    summary = client.get(f'{base}/attempts').json()['attempts'][0]
    self.assertEqual(2, summary['asset_count'])
    self.assertNotIn('assets', summary)
    detail = client.get(f"{base}/attempts/{answer['id']}").json()['answer']
    self.assertEqual(2, len(detail['assets']))

    asset_response = client.get(f"{base}/assets/{answer['assets'][0]['id']}")
    self.assertEqual(PNG, asset_response.content)
    historical_asset = client.get(
      f"{base}/attempts/{answer['id']}/assets/{answer['assets'][0]['id']}"
    )
    self.assertEqual(PNG, historical_asset.content)
    self.assertTrue(client.post(f"{base}/attempts/{answer['id']}/grade").json()['queued'])
    self.assertTrue(client.delete(base).json()['deleted'])
    self.assertIsNone(client.get(base).json()['answer'])


class SourceDocumentCleanupIntegrationTest(unittest.IsolatedAsyncioTestCase):
  async def test_pipeline_document_delete_cleans_bound_user_answers(self):
    calls = []

    class Runtime:
      async def run_pipeline_task(self, function, *args):
        return function(*args)

      def require_pipeline_coordinator(self):
        return SimpleNamespace(delete_question_with_relations=lambda _document_id: None)

      def require_user_answer_store(self):
        return SimpleNamespace(
          delete_document=lambda course_id, document_id: calls.append((course_id, document_id)),
        )

    with (
      patch(
        'backend.pipeline_router.delete_knowledge_homework_document',
        return_value={'deleted': True},
      ),
      patch('backend.pipeline_router.delete_learning_document'),
    ):
      await PipelineApiService(Runtime()).delete_homework_document('course-1', 'homework-1')

    self.assertEqual([('course-1', 'homework-1')], calls)


if __name__ == '__main__':
  unittest.main()
