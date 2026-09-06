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
from backend.user_answers import UserAnswerCorruptionError, UserAnswerNotFound, UserAnswerStore
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

  def test_legacy_attempt_numbers_migrate_once_and_deletion_keeps_gaps(self):
    first = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('first.png', 'image/png', PNG)],
    )
    second = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('second.png', 'image/png', PNG)],
    )
    third = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('third.png', 'image/png', PNG)],
    )
    record_path = self.store._record_path('course-1', 'q1')
    payload = json.loads(record_path.read_text(encoding='utf-8'))
    payload['schema_version'] = 3
    for attempt in payload['attempts']:
      attempt.pop('attempt_number', None)
    third_payload = payload['attempts'].pop()
    payload['current_attempt_id'] = second.id
    record_path.write_text(json.dumps(payload), encoding='utf-8')
    second_record_path = self.store._record_path('course-1', 'q2')
    (second_record_path.parent / 'attempts').mkdir(parents=True)
    (record_path.parent / 'attempts' / third.id).replace(
      second_record_path.parent / 'attempts' / third.id,
    )
    second_record_path.write_text(json.dumps({
      'schema_version': 3,
      'current_attempt_id': third.id,
      'attempts': [third_payload],
    }), encoding='utf-8')

    reloaded = UserAnswerStore(self.root, Resolver(self.identities))
    migrated = {item.id: item.attempt_number for item in reloaded.list_attempts(
      'course-1', 'homework-1', 'q2',
    )}
    self.assertEqual({first.id: 1, second.id: 2, third.id: 3}, migrated)
    self.assertEqual(migrated, {
      item.id: item.attempt_number for item in UserAnswerStore(
        self.root, Resolver(self.identities),
      ).list_attempts('course-1', 'homework-1', 'q1')
    })

    fourth = reloaded.replace(
      'course-1', 'homework-1', 'q2', 'homework', [upload('fourth.png', 'image/png', PNG)],
    )
    self.assertEqual(4, fourth.attempt_number)
    deleted, remaining = reloaded.delete_attempt(
      'course-1', 'homework-1', 'q2', second.id,
    )
    self.assertEqual(second.id, deleted.id)
    self.assertEqual(3, remaining)
    fifth = reloaded.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('fifth.png', 'image/png', PNG)],
    )
    self.assertEqual(5, fifth.attempt_number)
    self.assertEqual(
      [5, 4, 3, 1],
      [item.attempt_number for item in reloaded.list_attempts('course-1', 'homework-1', 'q1')],
    )
    self.assertNotIn(second.id, record_path.read_text(encoding='utf-8'))
    self.assertNotIn(second.id, record_path.with_name('record.json.bak').read_text(encoding='utf-8'))
    retained_dir = record_path.parent / 'attempts' / second.id
    self.assertTrue((retained_dir / 'assets').is_dir())
    self.assertTrue((retained_dir / '.retained-original.json').is_file())

  def test_delete_current_and_last_attempt_updates_or_removes_record(self):
    first = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('first.png', 'image/png', PNG)],
    )
    second = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('second.png', 'image/png', PNG)],
    )
    _, remaining = self.store.delete_attempt('course-1', 'homework-1', 'q1', second.id)
    record = self.store._read_record('course-1', 'q1')
    self.assertEqual(1, remaining)
    self.assertEqual(first.id, record.current_attempt_id)

    self.store.delete_attempt('course-1', 'homework-1', 'q1', first.id)
    self.assertFalse(self.store._question_dir('course-1', 'q1').exists())
    with self.assertRaises(UserAnswerNotFound):
      self.store.delete_attempt('course-1', 'homework-1', 'q1', first.id)

  def test_intermediate_delete_keeps_original_but_removes_attempt_projections(self):
    first = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('first.png', 'image/png', PNG)],
    )
    second = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('second.png', 'image/png', PNG)],
    )
    self.store.save_mineru_projection(
      'course-1', first.question_id, first.id,
      status='completed', markdown='recognized answer', layout={'pages': [1]},
    )
    record_path = self.store._record_path('course-1', 'q1')
    first_dir = record_path.parent / 'attempts' / first.id

    with patch('backend.user_answers.shutil.rmtree', side_effect=AssertionError('must retain assets')):
      deleted, remaining = self.store.delete_attempt(
        'course-1', 'homework-1', 'q1', first.id,
      )

    self.assertEqual(first.id, deleted.id)
    self.assertEqual(1, remaining)
    self.assertTrue((first_dir / 'assets').is_dir())
    self.assertTrue((first_dir / '.retained-original.json').is_file())
    self.assertNotIn(first.id, record_path.read_text(encoding='utf-8'))
    self.assertNotIn('recognized answer', record_path.read_text(encoding='utf-8'))

    self.store.delete_attempt('course-1', 'homework-1', 'q1', second.id)
    self.assertFalse(first_dir.exists())

  def test_windows_file_lock_is_retried_before_attempt_deletion_succeeds(self):
    answer = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('answer.png', 'image/png', PNG)],
    )
    real_replace = Path.replace
    attempts = 0

    def flaky_replace(path, target):
      nonlocal attempts
      if path.name == answer.id and attempts < 2:
        attempts += 1
        raise PermissionError('file is in use')
      return real_replace(path, target)

    with (
      patch('backend.user_answers.DELETE_RETRY_DELAYS_SECONDS', (0, 0, 0, 0)),
      patch.object(Path, 'replace', new=flaky_replace),
    ):
      deleted, remaining = self.store.delete_attempt(
        'course-1', 'homework-1', 'q1', answer.id,
      )

    self.assertEqual(2, attempts)
    self.assertEqual(answer.id, deleted.id)
    self.assertEqual(0, remaining)

  def test_stale_tombstone_cleanup_never_removes_an_active_attempt(self):
    answer = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('answer.png', 'image/png', PNG)],
    )
    question_dir = self.store._question_dir('course-1', 'q1')
    stale = question_dir / '.deleted-stale-attempt'
    stale.mkdir()
    (stale / 'asset').write_bytes(b'stale')
    active_tombstone = question_dir / f'.deleted-{answer.id}'
    active_tombstone.mkdir()

    removed = self.store.cleanup_deleted_attempt_dirs()

    self.assertEqual(1, removed)
    self.assertFalse(stale.exists())
    self.assertTrue(active_tombstone.exists())

  def test_startup_cleanup_restores_active_attempt_from_tombstone(self):
    answer = self.store.replace(
      'course-1', 'homework-1', 'q1', 'homework', [upload('answer.png', 'image/png', PNG)],
    )
    question_dir = self.store._question_dir('course-1', 'q1')
    attempt_dir = question_dir / 'attempts' / answer.id
    tombstone = question_dir / f'.deleted-{answer.id}'
    attempt_dir.replace(tombstone)

    removed = self.store.cleanup_deleted_attempt_dirs()

    self.assertEqual(0, removed)
    self.assertTrue(attempt_dir.is_dir())
    self.assertFalse(tombstone.exists())

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
    deletion = client.delete(f"{base}/attempts/{answer['id']}")
    self.assertEqual(200, deletion.status_code)
    self.assertEqual({
      'deleted': True, 'attempt_id': answer['id'], 'remaining_attempts': 0,
    }, deletion.json())
    self.assertEqual(404, client.delete(f"{base}/attempts/{answer['id']}").status_code)

    replacement = client.post(
      base,
      data={'source_type': 'homework'},
      files=[('files', ('replacement.png', PNG, 'image/png'))],
    ).json()['answer']
    self.assertEqual(1, replacement['attempt_number'])
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
