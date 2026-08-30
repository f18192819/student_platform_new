from __future__ import annotations

from collections import Counter
from typing import Any, Protocol

from .learning_state import AdaptiveTestSession, LearningEvent, project_concept_mastery


class QuestionSelectionStrategy(Protocol):
  def rank(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    lecture_events: list[LearningEvent],
    session_events: list[LearningEvent],
  ) -> list[dict[str, Any]]: ...


class RuleBasedQuestionSelectionStrategy:
  """Preserves the V1 adaptive rules while making the strategy replaceable."""

  def rank(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    lecture_events: list[LearningEvent],
    session_events: list[LearningEvent],
  ) -> list[dict[str, Any]]:
    asked = set(session.asked_question_ids)
    remaining = [
      item for item in candidates if str(item.get('question_id') or '') not in asked
    ]
    if not remaining:
      return []
    all_concepts = [
      concept for candidate in candidates for concept in candidate['knowledge_points']
    ]
    projections = {
      item.knowledge_point: item
      for item in project_concept_mastery(lecture_events, list(dict.fromkeys(all_concepts)))
    }
    covered = Counter(concept for event in session_events for concept in event.knowledge_points)
    wrong = Counter(
      concept for event in session_events if not event.correct for concept in event.knowledge_points
    )
    used_difficulties = Counter(event.difficulty for event in session_events)

    def priority(candidate: dict[str, Any]) -> tuple[float, str]:
      concepts = candidate['knowledge_points']
      uncovered_ratio = sum(covered[concept] == 0 for concept in concepts) / len(concepts)
      wrong_ratio = sum(wrong[concept] for concept in concepts) / len(concepts)
      mastery_gap = sum(1.0 - projections[concept].mastery for concept in concepts) / len(concepts)
      confident_streak = sum(
        projections[concept].correct_streak >= 2 and projections[concept].confidence >= 0.45
        for concept in concepts
      ) / len(concepts)
      difficulty_bonus = 0.6 if used_difficulties[int(candidate['difficulty'])] == 0 else 0.0
      breadth_bonus = min(len(concepts), 6) * 0.05
      relation_bonus = min(max(float(candidate['relation_score']), 0.0), 1.0) * 0.25
      score = (
        (4.0 * uncovered_ratio)
        + (3.0 * wrong_ratio)
        + (2.0 * mastery_gap)
        + difficulty_bonus
        + breadth_bonus
        + relation_bonus
        - (1.5 * confident_streak)
      )
      return score, str(candidate['question_id'])

    return sorted(remaining, key=priority, reverse=True)
