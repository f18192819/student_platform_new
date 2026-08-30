from __future__ import annotations

from typing import Any

from .learning_state import (
  AdaptiveTestSession,
  LearningEvent,
  aggregate_mastery,
  project_concept_mastery,
)


class AdaptiveTestResultAssembler:
  """Builds the read model returned by the existing Adaptive Test API."""

  def assemble(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    session_events: list[LearningEvent],
    lecture_events: list[LearningEvent],
  ) -> dict[str, Any]:
    all_concepts = list(dict.fromkeys(
      concept for candidate in candidates for concept in candidate['knowledge_points']
    ))
    concepts = project_concept_mastery(lecture_events, all_concepts)
    overall, confidence = aggregate_mastery(concepts)
    weak = [
      concept for concept in concepts if concept.mastery < 0.7 or concept.evidence_count == 0
    ]
    candidate_by_id = {str(item['question_id']): item for item in candidates}
    wrong_questions = []
    for event in session_events:
      if event.correct:
        continue
      candidate = candidate_by_id.get(event.question_id)
      wrong_questions.append({
        'question_id': event.question_id,
        'source_type': event.source_type,
        'source_document_id': event.source_document_id,
        'title': str((candidate or {}).get('title') or ''),
        'page_number': (candidate or {}).get('page_number'),
        'score': event.score,
        'answer': event.response_text,
        'structured_responses': event.structured_responses,
        'part_grading_results': event.part_grading_results,
        'feedback': event.grading_feedback,
        'reference_answer': str((candidate or {}).get('reference_answer') or '')[:12000],
        'images': list((candidate or {}).get('images') or []),
      })
    return {
      'overall_mastery': overall,
      'confidence': confidence,
      'questions_answered': len(session_events),
      'questions_correct': sum(1 for event in session_events if event.correct),
      'concept_mastery': [item.model_dump() for item in concepts],
      'weak_concepts': [item.model_dump() for item in weak],
      'wrong_questions': wrong_questions,
      'recommended_pages': self.recommended_pages(candidates, weak),
      'mastery_scope': 'lecture_history',
    }

  @staticmethod
  def recommended_pages(
    candidates: list[dict[str, Any]],
    weak: list[Any],
  ) -> list[dict[str, Any]]:
    weak_by_name = {item.knowledge_point: item for item in weak}
    pages: dict[tuple[str, int], dict[str, Any]] = {}
    for candidate in candidates:
      matched = [concept for concept in candidate['knowledge_points'] if concept in weak_by_name]
      if not matched:
        continue
      for relation in candidate['lecture_relations']:
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        document_id = str(target.get('document_id') or '')
        page_number = int(target.get('page_number') or 0)
        if not document_id or page_number <= 0:
          continue
        score = float(relation.get('rerank_score') or relation.get('vector_score') or 0.0)
        existing = pages.setdefault((document_id, page_number), {
          'document_id': document_id,
          'document_name': str(target.get('document_name') or ''),
          'page_id': str(target.get('page_id') or ''),
          'page_number': page_number,
          'title': str(target.get('title') or ''),
          'knowledge_points': [],
          'relation_score': score,
        })
        existing['knowledge_points'] = list(dict.fromkeys(existing['knowledge_points'] + matched))
        existing['relation_score'] = max(existing['relation_score'], score)
    ranked = list(pages.values())
    ranked.sort(key=lambda item: (
      min(weak_by_name[name].mastery for name in item['knowledge_points']),
      -float(item['relation_score']),
      int(item['page_number']),
    ))
    return ranked[:10]
