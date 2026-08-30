from __future__ import annotations

import unittest
from concurrent.futures import Future

from backend.pipeline_orchestration import PipelineCoordinator


class ImmediateExecutor:
  def submit(self, function, *args, **kwargs):
    future = Future()
    try:
      future.set_result(function(*args, **kwargs))
    except Exception as exc:  # pragma: no cover - mirrors Executor behavior.
      future.set_exception(exc)
    return future


class FakeDocuments:
  def __init__(self, state=None, calls=None):
    self.state = state or {'status': 'completed', 'document_type': 'lecture', 'course_id': 'c1'}
    self.calls = calls if calls is not None else []

  def run(self, document_id):
    self.calls.append(('document.run', document_id))
    return dict(self.state)

  def delete(self, document_id):
    self.calls.append(('document.delete', document_id))

  def delete_course(self, course_id):
    self.calls.append(('document.delete_course', course_id))


class FakeQuestions:
  def __init__(self, calls=None, fail_delete=False):
    self.calls = calls if calls is not None else []
    self.fail_delete = fail_delete

  def delete(self, document_id):
    self.calls.append(('question.delete', document_id))
    if self.fail_delete:
      raise RuntimeError('question cleanup failed')

  def delete_course(self, course_id):
    self.calls.append(('question.delete_course', course_id))

  def resume_pending(self):
    return 0


class FakeRelations:
  def __init__(self, calls=None, fail_link=False):
    self.calls = calls if calls is not None else []
    self.fail_link = fail_link

  def link_document(self, document_id):
    self.calls.append(('relations.link_document', document_id))
    return {'question_ids': ['q1']}

  def link_course(self, course_id):
    self.calls.append(('relations.link_course', course_id))
    if self.fail_link:
      raise RuntimeError('relation projection failed')
    return {'documents': [{'question_ids': ['q1', 'q2']}]}

  def missing_document_ids(self):
    return []

  def delete_question_document(self, document_id):
    self.calls.append(('relations.delete_question_document', document_id))

  def remove_target_document(self, document_id):
    self.calls.append(('relations.remove_target_document', document_id))


class PipelineCoordinatorTest(unittest.TestCase):
  def build(self, *, documents=None, questions=None, relations=None):
    queued = []
    coordinator = PipelineCoordinator(
      documents=documents or FakeDocuments(),
      questions=questions or FakeQuestions(),
      relations=relations or FakeRelations(),
      relation_executor=ImmediateExecutor(),
      queue_assessments=lambda ids: queued.append(set(ids or set())) or {'queued': len(ids or [])},
      resume_assessments=lambda: {'resumed': 0},
    )
    return coordinator, queued

  def test_completed_lecture_refreshes_relations_and_assessments(self):
    calls = []
    coordinator, queued = self.build(
      documents=FakeDocuments(calls=calls),
      relations=FakeRelations(calls=calls),
    )

    state = coordinator.run_document_with_relations('lecture-1')

    self.assertEqual('completed', state['status'])
    self.assertEqual(
      [('document.run', 'lecture-1'), ('relations.link_course', 'c1')],
      calls,
    )
    self.assertEqual([{'q1', 'q2'}], queued)

  def test_relation_projection_failure_does_not_fail_indexing(self):
    coordinator, queued = self.build(relations=FakeRelations(fail_link=True))

    state = coordinator.run_document_with_relations('lecture-1')

    self.assertEqual('completed', state['status'])
    self.assertIn('relation projection failed', state['relation_refresh_error'])
    self.assertEqual([], queued)

  def test_delete_all_artifacts_runs_every_cleanup_step(self):
    calls = []
    coordinator, _ = self.build(
      documents=FakeDocuments(calls=calls),
      questions=FakeQuestions(calls=calls),
      relations=FakeRelations(calls=calls),
    )

    coordinator.delete_all_document_artifacts('doc-1')

    self.assertEqual(
      [
        ('relations.delete_question_document', 'doc-1'),
        ('relations.remove_target_document', 'doc-1'),
        ('document.delete', 'doc-1'),
        ('question.delete', 'doc-1'),
      ],
      calls,
    )

  def test_delete_all_artifacts_reports_failure_after_other_cleanup(self):
    calls = []
    coordinator, _ = self.build(
      documents=FakeDocuments(calls=calls),
      questions=FakeQuestions(calls=calls, fail_delete=True),
      relations=FakeRelations(calls=calls),
    )

    with self.assertRaisesRegex(RuntimeError, 'question cleanup failed'):
      coordinator.delete_all_document_artifacts('doc-1')

    self.assertIn(('document.delete', 'doc-1'), calls)
    self.assertIn(('question.delete', 'doc-1'), calls)


if __name__ == '__main__':
  unittest.main()
