from __future__ import annotations

import unittest
from unittest.mock import patch

from backend.knowledge_router import KnowledgeLibraryService, create_knowledge_router


class FakeDocumentPipeline:
  def __init__(self, calls):
    self.calls = calls

  def cancel_and_wait(self, document_id):
    self.calls.append(('document.cancel_and_wait', document_id))


class FakeCoordinator:
  def __init__(self, calls):
    self.calls = calls

  def delete_document_with_relations(self, document_id):
    self.calls.append(('coordinator.delete_document', document_id))

  def delete_question_with_relations(self, document_id):
    self.calls.append(('coordinator.delete_question', document_id))

  def delete_course_artifacts(self, course_id):
    self.calls.append(('coordinator.delete_course', course_id))


class FakeRuntime:
  def __init__(self, calls=None):
    self.calls = calls if calls is not None else []
    self.documents = FakeDocumentPipeline(self.calls)
    self.coordinator = FakeCoordinator(self.calls)

  def require_document_pipeline(self):
    return self.documents

  def require_pipeline_coordinator(self):
    return self.coordinator


class KnowledgeRouterTest(unittest.TestCase):
  def test_router_keeps_library_and_asset_paths(self):
    router = create_knowledge_router(FakeRuntime())
    paths = {route.path for route in router.routes}

    self.assertIn('/api/knowledge/library', paths)
    self.assertIn('/api/knowledge/files/{file_id}', paths)
    self.assertIn('/api/knowledge/courses/{course_id}', paths)
    self.assertIn('/api/knowledge/pdf/{file_id}', paths)
    self.assertIn('/api/knowledge/homework-asset/{asset_id}', paths)

  @patch('backend.knowledge_router.mark_deleted_synced_courseware')
  @patch('backend.knowledge_router.delete_learning_document')
  @patch('backend.knowledge_router.mark_knowledge_file_deleted')
  @patch('backend.knowledge_router.read_knowledge_library')
  def test_file_deletion_runs_tombstone_pipeline_and_learning_cleanup(
    self,
    read_library,
    mark_deleted,
    delete_learning,
    mark_synced,
  ):
    calls = []
    runtime = FakeRuntime(calls)
    file_record = {'id': 'doc-1', 'courseId': 'course-1'}
    read_library.return_value = {'files': [file_record]}

    def delete_lecture(document_id, delete_document, delete_question):
      delete_document(document_id)
      delete_question(document_id)
      return {'deleted': True, 'fileId': document_id}

    with patch('backend.knowledge_router.delete_knowledge_lecture', side_effect=delete_lecture):
      result = KnowledgeLibraryService(runtime).delete_file('doc-1')

    self.assertTrue(result['deleted'])
    mark_deleted.assert_called_once_with('doc-1', file_record)
    self.assertEqual(
      [
        ('document.cancel_and_wait', 'doc-1'),
        ('coordinator.delete_document', 'doc-1'),
        ('coordinator.delete_question', 'doc-1'),
      ],
      calls,
    )
    delete_learning.assert_called_once_with('course-1', 'doc-1')
    mark_synced.assert_called_once_with(file_record)


if __name__ == '__main__':
  unittest.main()
