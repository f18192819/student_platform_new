from __future__ import annotations

import unittest

from backend.pipeline_router import create_pipeline_router


class StubRuntime:
  """Router construction must not initialize storage or external providers."""


class PipelineRouterContractTest(unittest.TestCase):
  def test_legacy_pipeline_paths_remain_registered(self):
    router = create_pipeline_router(StubRuntime())
    operations = {
      (route.path, method)
      for route in router.routes
      for method in route.methods
    }
    expected = {
      ('/api/documents/process', 'POST'),
      ('/api/documents/{document_id}/status', 'GET'),
      ('/api/documents/{document_id}/retry', 'POST'),
      ('/api/documents/{document_id}/reindex', 'POST'),
      ('/api/documents/{document_id}/move-course', 'POST'),
      ('/api/documents/retrieve', 'POST'),
      ('/api/chat/retrieve-context', 'POST'),
      ('/api/vector-store/storage', 'GET'),
      ('/api/questions/process', 'POST'),
      ('/api/questions/resume-pending', 'POST'),
      ('/api/questions/{document_id}/retry', 'POST'),
      ('/api/questions/{document_id}/reextract', 'POST'),
      ('/api/questions/{document_id}/status', 'GET'),
      ('/api/questions/{document_id}', 'DELETE'),
      ('/api/question-relations/config', 'GET'),
      ('/api/question-relations/config', 'PUT'),
      ('/api/question-relations/documents/{document_id}/run', 'POST'),
      (
        '/api/question-relations/documents/{document_id}/questions/{question_id}/run',
        'POST',
      ),
      ('/api/question-relations/courses/{course_id}/run', 'POST'),
      ('/api/question-relations/questions/{question_id}', 'GET'),
      ('/api/question-relations/rebuild-page-indexes', 'POST'),
      (
        '/api/question-relations/courses/{course_id}/lectures/{document_id}/pages/{page_number}',
        'GET',
      ),
      ('/api/knowledge/courses/{course_id}/homework-documents/{document_id}', 'DELETE'),
    }

    self.assertTrue(expected.issubset(operations))


if __name__ == '__main__':
  unittest.main()
