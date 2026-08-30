from __future__ import annotations

from concurrent.futures import Executor
from typing import Any, Callable, Protocol


class DocumentPipelinePort(Protocol):
  def run(self, document_id: str) -> dict[str, Any]: ...
  def delete(self, document_id: str) -> None: ...
  def delete_course(self, course_id: str) -> None: ...


class QuestionPipelinePort(Protocol):
  def delete(self, document_id: str) -> None: ...
  def delete_course(self, course_id: str) -> None: ...
  def resume_pending(self) -> int: ...


class QuestionRelationBuilderPort(Protocol):
  def link_document(self, document_id: str) -> dict[str, Any]: ...
  def link_course(self, course_id: str) -> dict[str, Any]: ...
  def missing_document_ids(self) -> list[str]: ...
  def delete_question_document(self, document_id: str) -> None: ...
  def remove_target_document(self, document_id: str) -> None: ...


class PipelineCoordinator:
  """Coordinates pipeline stages without owning HTTP or storage details."""

  def __init__(
    self,
    *,
    documents: DocumentPipelinePort,
    questions: QuestionPipelinePort,
    relations: QuestionRelationBuilderPort,
    relation_executor: Executor,
    queue_assessments: Callable[[set[str] | None], dict[str, int]],
    resume_assessments: Callable[[], dict[str, int]],
  ) -> None:
    self.documents = documents
    self.questions = questions
    self.relations = relations
    self.relation_executor = relation_executor
    self.queue_assessments = queue_assessments
    self.resume_assessments = resume_assessments

  @staticmethod
  def _relation_question_ids(result: dict[str, Any]) -> set[str]:
    return {
      str(question_id)
      for document in result.get('documents') or []
      for question_id in document.get('question_ids') or []
      if str(question_id or '').strip()
    }

  def run_document_with_relations(self, document_id: str) -> dict[str, Any]:
    state = self.documents.run(document_id)
    if state.get('status') != 'completed' or state.get('document_type') != 'lecture':
      return state
    try:
      result = self.relations.link_course(str(state.get('course_id') or ''))
      self.queue_assessments(self._relation_question_ids(result))
    except Exception as exc:  # Relation refresh is an optional projection.
      state['relation_refresh_error'] = str(getattr(exc, 'detail', exc))
    return state

  def refresh_question_document_relations(self, document_id: str) -> str:
    try:
      result = self.relations.link_document(document_id)
      question_ids = {
        str(value) for value in result.get('question_ids') or [] if str(value or '').strip()
      }
      self.queue_assessments(question_ids)
    except Exception as exc:
      return str(getattr(exc, 'detail', exc))
    return ''

  def refresh_course_relations(self, course_id: str) -> str:
    try:
      result = self.relations.link_course(course_id)
      self.queue_assessments(self._relation_question_ids(result))
    except Exception as exc:
      return str(getattr(exc, 'detail', exc))
    return ''

  def queue_question_relation_refresh(self, document_id: str) -> None:
    future = self.relation_executor.submit(self.refresh_question_document_relations, document_id)

    def report_failure(completed_future) -> None:
      try:
        error = str(completed_future.result() or '')
      except Exception as exc:
        error = str(exc)
      if error:
        print(f'Question relation refresh failed for {document_id}: {error}')

    future.add_done_callback(report_failure)

  def queue_missing_question_relation_refreshes(self) -> None:
    for document_id in self.relations.missing_document_ids():
      self.queue_question_relation_refresh(document_id)

  def queue_assessment_preparation_resume(self) -> None:
    future = self.relation_executor.submit(self.resume_assessments)

    def report_failure(completed_future) -> None:
      try:
        completed_future.result()
      except Exception as exc:
        print(f'Assessment preparation resume failed: {exc}')

    future.add_done_callback(report_failure)

  def queue_assessment_preparations(self, question_ids: set[str] | None) -> dict[str, int]:
    """Expose assessment preparation through the coordinator boundary."""
    return self.queue_assessments(question_ids)

  def delete_relations(self, document_id: str) -> None:
    self.relations.delete_question_document(document_id)
    self.relations.remove_target_document(document_id)

  def delete_all_document_artifacts(self, document_id: str) -> None:
    normalized = str(document_id or '').strip()
    if not normalized:
      return
    cleanup_steps = (
      ('question relation records', lambda: self.delete_relations(normalized)),
      ('lecture pipeline', lambda: self.documents.delete(normalized)),
      ('question pipeline', lambda: self.questions.delete(normalized)),
    )
    errors: list[str] = []
    for label, cleanup in cleanup_steps:
      try:
        cleanup()
      except Exception as exc:
        errors.append(f'{label}: {getattr(exc, "detail", exc)}')
    if errors:
      raise RuntimeError(
        f'Unable to completely delete document {normalized}: {"; ".join(errors)}'
      )

  def delete_document_with_relations(self, document_id: str) -> None:
    normalized = str(document_id or '').strip()
    if not normalized:
      return
    self.delete_relations(normalized)
    self.documents.delete(normalized)

  def delete_question_with_relations(self, document_id: str) -> None:
    normalized = str(document_id or '').strip()
    if not normalized:
      return
    self.delete_relations(normalized)
    self.questions.delete(normalized)

  def delete_course_artifacts(self, course_id: str) -> None:
    normalized = str(course_id or '').strip()
    if not normalized:
      return
    self.questions.delete_course(normalized)
    self.documents.delete_course(normalized)
