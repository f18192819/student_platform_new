from __future__ import annotations

from typing import Any, Callable, Protocol

from .question_pipeline import question_image_attachments

SUPPORTED_SOURCE_TYPES = {
  'homework',
  'past-exam',
  'exercise-set',
  'lecture-example',
  'classroom-example',
}


class RelationQuestionQuery(Protocol):
  def lecture_document_questions(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> dict[str, Any]: ...

  def assessment_relation_targets(
    self,
    question_ids: set[str] | None = None,
  ) -> list[dict[str, Any]]: ...


class ReferenceAnswerLookup(Protocol):
  def saved_reference_answer(self, course_id: str, question_id: str): ...


class CandidateProvider(Protocol):
  def candidates(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> tuple[list[dict[str, Any]], int]: ...

  def assessment_targets(
    self,
    question_ids: set[str] | None = None,
  ) -> list[dict[str, Any]]: ...


class RelationCandidateProvider:
  """Translates stable relation queries into Adaptive Test candidates."""

  def __init__(
    self,
    relations: RelationQuestionQuery,
    reference_answers: ReferenceAnswerLookup,
    material_splitter: Callable[[dict[str, Any]], tuple[str, str, str]],
  ) -> None:
    self.relations = relations
    self.reference_answers = reference_answers
    self.material_splitter = material_splitter

  def assessment_targets(
    self,
    question_ids: set[str] | None = None,
  ) -> list[dict[str, Any]]:
    return self.relations.assessment_relation_targets(question_ids)

  def candidates(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> tuple[list[dict[str, Any]], int]:
    related = self.relations.lecture_document_questions(course_id, lecture_document_id)
    candidates: list[dict[str, Any]] = []
    skipped = 0
    for question in related.get('questions') or []:
      document_type = str(question.get('document_type') or '')
      if document_type not in SUPPORTED_SOURCE_TYPES:
        continue
      analysis = question.get('analysis') if isinstance(question.get('analysis'), dict) else {}
      concepts = list(dict.fromkeys(
        str(value or '').strip()
        for value in analysis.get('knowledge_points') or []
        if str(value or '').strip()
      ))
      difficulty_payload = analysis.get('difficulty') if isinstance(analysis.get('difficulty'), dict) else {}
      difficulty = max(1, min(5, int(difficulty_payload.get('level') or 1)))
      prompt, reference_answer, grading_method = self.material_splitter(question)
      saved_reference = self.reference_answers.saved_reference_answer(
        course_id,
        str(question.get('question_id') or ''),
      )
      if saved_reference:
        reference_answer = saved_reference.answer_text
        grading_method = 'llm_reference'
      if not prompt or not concepts:
        skipped += 1
        continue
      relations = []
      for relation in question.get('lecture_relations') or []:
        if not isinstance(relation, dict) or relation.get('relation_type') != 'question_to_lecture_page':
          continue
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        if str(target.get('document_id') or '') != lecture_document_id:
          continue
        if int(target.get('page_number') or 0) <= 0:
          continue
        target_course_id = str(target.get('course_id') or '').strip()
        if target_course_id and target_course_id != course_id:
          continue
        relations.append(relation)
      if not relations:
        skipped += 1
        continue
      candidates.append({
        **question,
        '_analysis': analysis,
        'prompt': prompt,
        'reference_answer': reference_answer,
        'grading_method': grading_method,
        'knowledge_points': concepts,
        'difficulty': difficulty,
        'source_type': (
          'lecture_example'
          if document_type in {'lecture-example', 'classroom-example'}
          else 'past-exam' if document_type == 'past-exam' else 'homework'
        ),
        'images': question_image_attachments(
          str(question.get('document_id') or ''),
          question,
          prompt,
        ),
        'lecture_relations': relations,
        'relation_score': max(
          (float(item.get('rerank_score') or item.get('vector_score') or 0.0) for item in relations),
          default=0.0,
        ),
      })
    return candidates, skipped
