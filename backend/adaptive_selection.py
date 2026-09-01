from __future__ import annotations

from collections import Counter
import math
import random
from typing import Any, Protocol

from .learning_projections import project_question_mastery, question_retry_bonus
from .learning_state import AdaptiveTestSession, LearningEvent, project_concept_mastery


class QuestionSelectionStrategy(Protocol):
  def rank(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    lecture_events: list[LearningEvent],
    session_events: list[LearningEvent],
    question_history: dict[str, list[LearningEvent]] | None = None,
  ) -> list[dict[str, Any]]: ...


class RuleBasedQuestionSelectionStrategy:
  """Preserves the V1 adaptive rules while making the strategy replaceable."""

  def __init__(self, rng: random.Random | None = None) -> None:
    self._rng = rng or random.Random()

  def rank(
    self,
    session: AdaptiveTestSession,
    candidates: list[dict[str, Any]],
    lecture_events: list[LearningEvent],
    session_events: list[LearningEvent],
    question_history: dict[str, list[LearningEvent]] | None = None,
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
    history = question_history or {}
    latest_events = [
      event
      for events in history.values()
      for event in events
      if event.test_session_id != session.id
    ]
    latest_session_id = max(
      latest_events,
      key=lambda event: (event.created_at, event.id),
    ).test_session_id if latest_events else None
    question_projections = {
      item.question_id: item
      for item in project_question_mastery(
        latest_events,
        [str(candidate.get('question_id') or '') for candidate in candidates],
      )
    }

    def priority(candidate: dict[str, Any]) -> tuple[float, float, str]:
      question_id = str(candidate.get('question_id') or '')
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
      question_events = sorted(
        history.get(question_id, []),
        key=lambda event: (event.created_at, event.id),
      )
      attempts = len(question_events)
      question_projection = question_projections[question_id]
      question_mastery = question_projection.mastery
      last_event = question_events[-1] if question_events else None
      low_exposure_bonus = 2.6 / math.sqrt(attempts + 1)
      question_mastery_gap_bonus = 2.0 * (1.0 - question_mastery)
      wrong_question_bonus = question_retry_bonus(question_events)
      recent_exposure_penalty = (
        1.4 if last_event is not None and last_event.test_session_id == latest_session_id else 0.0
      )
      # Equal-score candidates receive a small jitter so sessions are not fixed
      # to the same question-id order, while meaningful bonuses remain dominant.
      controlled_jitter = self._rng.random() * 0.2
      score = (
        (4.0 * uncovered_ratio)
        + (4.0 * wrong_ratio)
        + (2.0 * mastery_gap)
        + difficulty_bonus
        + breadth_bonus
        + relation_bonus
        + low_exposure_bonus
        + question_mastery_gap_bonus
        + wrong_question_bonus
        - (1.5 * confident_streak)
        - recent_exposure_penalty
      )
      return score + controlled_jitter, controlled_jitter, question_id

    return sorted(remaining, key=priority, reverse=True)
