from __future__ import annotations

import math
from collections import defaultdict
from typing import Iterable

from pydantic import BaseModel, ConfigDict, Field

from .learning_state import LearningEvent


class QuestionMastery(BaseModel):
  """Read-only question practice projection built from effective events."""

  model_config = ConfigDict(extra='forbid')
  question_id: str
  attempts: int = Field(ge=0)
  correct_count: int = Field(ge=0)
  average_score: float = Field(ge=0.0, le=1.0)
  mastery: float = Field(ge=0.0, le=1.0)
  confidence: float = Field(ge=0.0, le=1.0)
  last_answered_at: str | None = None
  last_score: float | None = Field(default=None, ge=0.0, le=1.0)
  consecutive_correct: int = Field(ge=0)


def project_question_mastery(
  events: Iterable[LearningEvent],
  question_ids: Iterable[str] | None = None,
) -> list[QuestionMastery]:
  """Project question history without changing append-only LearningEvents."""
  grouped: dict[str, list[LearningEvent]] = defaultdict(list)
  for question_id in question_ids or []:
    normalized = str(question_id or '').strip()
    if normalized:
      grouped.setdefault(normalized, [])
  for event in events:
    question_id = str(event.question_id or '').strip()
    if question_id:
      grouped[question_id].append(event)

  projections: list[QuestionMastery] = []
  for question_id, question_events in grouped.items():
    ordered = sorted(question_events, key=lambda item: (item.created_at, item.id))
    attempts = len(ordered)
    correct_count = sum(1 for event in ordered if event.correct)
    average_score = sum(event.score for event in ordered) / attempts if attempts else 0.0
    average_confidence = (
      sum(event.grading_confidence for event in ordered) / attempts if attempts else 0.0
    )
    confidence = (1.0 - math.exp(-attempts / 3.0)) * average_confidence if attempts else 0.0
    streak = 0
    for event in reversed(ordered):
      if not event.correct:
        break
      streak += 1
    latest = ordered[-1] if ordered else None
    projections.append(QuestionMastery(
      question_id=question_id,
      attempts=attempts,
      correct_count=correct_count,
      average_score=round(average_score, 4),
      mastery=round(average_score, 4) if attempts else 0.5,
      confidence=round(confidence, 4),
      last_answered_at=latest.created_at if latest else None,
      last_score=round(latest.score, 4) if latest else None,
      consecutive_correct=streak,
    ))
  projections.sort(key=lambda item: item.question_id)
  return projections


def question_retry_bonus(
  events: Iterable[LearningEvent],
  *,
  maximum: float = 2.4,
  decay_after_correct: int = 3,
) -> float:
  """Return an explainable retry bonus that fades after consecutive success."""
  ordered = sorted(events, key=lambda item: (item.created_at, item.id))
  if not ordered or all(event.correct for event in ordered):
    return 0.0
  correct_streak = 0
  for event in reversed(ordered):
    if not event.correct:
      break
    correct_streak += 1
  remaining = max(0.0, 1.0 - (correct_streak / max(1, decay_after_correct)))
  return round(maximum * remaining, 4)
