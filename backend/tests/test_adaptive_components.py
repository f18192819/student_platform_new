from __future__ import annotations

import tempfile
import unittest
import random
from pathlib import Path

from fastapi import HTTPException

from backend.adaptive_grading import GradingResult, StructuredPartGrader
from backend.adaptive_results import AdaptiveTestResultAssembler
from backend.adaptive_selection import RuleBasedQuestionSelectionStrategy
from backend.adaptive_testing import AdaptiveTestingService
from backend.assessment_planner import AssessmentOption, AssessmentPart, AssessmentSpec
from backend.learning_projections import (
  QuestionMastery,
  project_question_mastery,
  question_retry_bonus,
)
from backend.learning_state import AdaptiveTestSession, LearningEvent, LearningStateStore


def event(*, question_id='q0', concepts=None, correct=False, score=0.0, difficulty=2,
          test_session_id='session-1', created_at=None, course_id='c1'):
  return LearningEvent(
    course_id=course_id,
    lecture_document_id='lecture-1',
    test_session_id=test_session_id,
    question_id=question_id,
    source_type='homework',
    source_document_id='homework-1',
    knowledge_points=concepts or ['concept-a'],
    difficulty=difficulty,
    correct=correct,
    score=score,
    grading_method='test',
    created_at=created_at or LearningEvent.model_fields['created_at'].default_factory(),
  )


def candidate(question_id: str) -> dict:
  return {
    'question_id': question_id,
    'knowledge_points': ['concept-a'],
    'difficulty': 2,
    'relation_score': 0.5,
  }


class FakeSubjectiveGrader:
  def __init__(self):
    self.text_calls = 0

  def grade(self, _candidate, answer):
    return GradingResult(
      score=1.0 if answer == 'legacy' else 0.0,
      correct=answer == 'legacy',
      confidence=1.0,
      feedback='legacy',
      method='legacy',
    )

  def grade_text(self, _prompt, _reference, answer):
    self.text_calls += 1
    return GradingResult(
      score=0.8 if answer else 0.0,
      correct=bool(answer),
      confidence=0.7,
      feedback='text graded',
      method='llm_reference',
    )


class AdaptiveComponentTest(unittest.TestCase):
  def test_selection_prioritizes_wrong_concept_and_skips_asked_question(self):
    session = AdaptiveTestSession(
      id='session-1',
      course_id='c1',
      lecture_document_id='lecture-1',
      target_question_count=3,
      asked_question_ids=['asked'],
    )
    candidates = [
      {'question_id': 'asked', 'knowledge_points': ['concept-a'], 'difficulty': 2, 'relation_score': 1.0},
      {'question_id': 'weak', 'knowledge_points': ['concept-a'], 'difficulty': 2, 'relation_score': 0.5},
      {'question_id': 'new', 'knowledge_points': ['concept-b'], 'difficulty': 2, 'relation_score': 0.5},
    ]
    wrong = event(concepts=['concept-a'], correct=False, score=0.0)

    ranked = RuleBasedQuestionSelectionStrategy().rank(
      session,
      candidates,
      [wrong],
      [wrong],
    )

    self.assertEqual(['weak', 'new'], [item['question_id'] for item in ranked])

  def test_objective_parts_do_not_call_subjective_grader(self):
    subjective = FakeSubjectiveGrader()
    grader = StructuredPartGrader(subjective)
    spec = AssessmentSpec(
      question_id='q1',
      source_fingerprint='fp',
      parts=[
        AssessmentPart(
          id='choice', type='choice', prompt='Choose', weight=0.5,
          options=[AssessmentOption(id='A', content='1'), AssessmentOption(id='B', content='2')],
          correct_option_id='B', reference_answer='2',
        ),
        AssessmentPart(
          id='numeric', type='numeric', prompt='Value', weight=0.5,
          expected_value='1/2', tolerance=0.001, reference_answer='1/2',
        ),
      ],
    )

    result, responses, _ = grader.grade(
      {'prompt': 'Question'},
      spec,
      [{'part_id': 'choice', 'value': 'B'}, {'part_id': 'numeric', 'value': '0.5'}],
      '',
    )

    self.assertEqual(1.0, result.score)
    self.assertEqual(0, subjective.text_calls)
    self.assertEqual(2, len(responses))

  def test_unknown_part_returns_a_stable_conflict_code(self):
    grader = StructuredPartGrader(FakeSubjectiveGrader())
    spec = AssessmentSpec(
      question_id='q1',
      source_fingerprint='fp',
      parts=[AssessmentPart(
        id='expected-part', type='text', prompt='Explain', weight=1, reference_answer='answer',
      )],
    )

    with self.assertRaises(HTTPException) as raised:
      grader.grade(
        {'prompt': 'Question'},
        spec,
        [{'part_id': 'stale-part', 'value': 'answer'}],
        '',
      )

    self.assertEqual(409, raised.exception.status_code)
    self.assertEqual('assessment_spec_conflict', raised.exception.headers['X-Error-Code'])

  def test_result_recommendations_only_use_real_relation_pages(self):
    session = AdaptiveTestSession(
      id='session-1', course_id='c1', lecture_document_id='lecture-1', target_question_count=1
    )
    candidate = {
      'question_id': 'q1', 'knowledge_points': ['concept-a'], 'title': 'Q1',
      'page_number': 2, 'reference_answer': 'answer', 'images': [],
      'lecture_relations': [
        {
          'rerank_score': 0.9,
          'target': {
            'document_id': 'lecture-1', 'document_name': 'Lecture',
            'page_id': 'page-7', 'page_number': 7, 'title': 'Real page',
          },
        },
        {'rerank_score': 1.0, 'target': {'document_id': 'lecture-1', 'page_number': 0}},
      ],
    }
    wrong = event(question_id='q1', concepts=['concept-a'], correct=False, score=0.0)

    result = AdaptiveTestResultAssembler().assemble(session, [candidate], [wrong], [wrong])

    self.assertEqual([7], [item['page_number'] for item in result['recommended_pages']])
    self.assertEqual(1, result['questions_answered'])
    self.assertEqual(0.0, result['overall_mastery'])
    self.assertEqual(1, result['question_mastery'][0]['attempts'])

  def test_session_keeps_the_assessment_spec_that_was_shown(self):
    with tempfile.TemporaryDirectory() as temporary_directory:
      store = LearningStateStore(Path(temporary_directory))
      session = AdaptiveTestSession(
        id='session-bound-spec',
        course_id='c1',
        lecture_document_id='lecture-1',
        target_question_count=1,
      )
      store.create_session(session)
      service = AdaptiveTestingService.__new__(AdaptiveTestingService)
      service.store = store
      candidate = {'question_id': 'q1'}
      shown = AssessmentSpec(
        question_id='q1',
        source_fingerprint='shown',
        parts=[AssessmentPart(
          id='shown-part', type='text', prompt='Shown', weight=1, reference_answer='answer',
        )],
      )
      regenerated = AssessmentSpec(
        question_id='q1',
        source_fingerprint='regenerated',
        parts=[AssessmentPart(
          id='new-part', type='text', prompt='New', weight=1, reference_answer='answer',
        )],
      )

      first = service._session_assessment_spec(session, candidate, preferred=shown)
      second = service._session_assessment_spec(session, candidate, preferred=regenerated)

      self.assertEqual('shown-part', first.parts[0].id)
      self.assertEqual('shown-part', second.parts[0].id)
      persisted = store.get_session_assessment_spec('c1', session.id, 'q1')
      self.assertEqual('shown-part', persisted['parts'][0]['id'])

  def test_user_corrected_reference_can_replace_a_bound_spec(self):
    with tempfile.TemporaryDirectory() as temporary_directory:
      store = LearningStateStore(Path(temporary_directory))
      session = AdaptiveTestSession(
        id='session-corrected-spec',
        course_id='c1',
        lecture_document_id='lecture-1',
        target_question_count=1,
      )
      store.create_session(session)
      service = AdaptiveTestingService.__new__(AdaptiveTestingService)
      service.store = store
      candidate = {'question_id': 'q1'}
      original = AssessmentSpec(
        question_id='q1',
        source_fingerprint='original',
        reference_answer_updated_at='2026-01-01T00:00:00Z',
        parts=[AssessmentPart(
          id='original-part', type='text', prompt='Original', weight=1, reference_answer='old',
        )],
      )
      corrected = AssessmentSpec(
        question_id='q1',
        source_fingerprint='corrected',
        reference_answer_updated_at='2026-01-02T00:00:00Z',
        parts=[AssessmentPart(
          id='corrected-part', type='text', prompt='Corrected', weight=1, reference_answer='new',
        )],
      )

      service._session_assessment_spec(session, candidate, preferred=original)
      replaced = service._session_assessment_spec(session, candidate, preferred=corrected)

      self.assertEqual('corrected-part', replaced.parts[0].id)

  def test_question_mastery_is_projected_from_effective_events(self):
    events = [
      event(question_id='q1', correct=False, score=0.0, created_at='2026-01-01T00:00:00Z'),
      event(question_id='q1', correct=True, score=1.0, created_at='2026-01-02T00:00:00Z'),
      event(question_id='q2', correct=True, score=1.0, created_at='2026-01-03T00:00:00Z'),
    ]

    projections = project_question_mastery(events, ['q1', 'q2', 'unseen'])
    by_id = {item.question_id: item for item in projections}

    self.assertIsInstance(by_id['q1'], QuestionMastery)
    self.assertEqual(2, by_id['q1'].attempts)
    self.assertEqual(1, by_id['q1'].correct_count)
    self.assertEqual(1, by_id['q1'].consecutive_correct)
    self.assertEqual(1, by_id['q2'].attempts)
    self.assertEqual(0, by_id['unseen'].attempts)
    self.assertEqual(0.0, by_id['unseen'].confidence)

  def test_low_exposure_questions_beat_high_exposure_at_equal_mastery(self):
    strategy = RuleBasedQuestionSelectionStrategy(rng=random.Random(1))
    session = AdaptiveTestSession(
      id='new-session', course_id='c1', lecture_document_id='lecture-1', target_question_count=3,
    )
    history = {
      'q1': [event(
        question_id='q1', correct=True, score=1.0, test_session_id='old-1',
        created_at='2026-01-01T00:00:00Z',
      )],
      'q2': [event(
        question_id='q2', correct=True, score=1.0, test_session_id='old-2',
        created_at='2026-01-01T00:00:00Z',
      )],
      'q3': [event(
        question_id='q3', correct=True, score=1.0, test_session_id=f'old-{i}',
        created_at='2026-01-01T00:00:00Z',
      ) for i in range(6)],
      # Keep recent-exposure logic out of this exposure-only assertion.
      'unrelated': [event(
        question_id='unrelated', correct=True, score=1.0, test_session_id='latest-session',
        created_at='2026-01-02T00:00:00Z',
      )],
    }

    ranked = strategy.rank(
      session, [candidate('q1'), candidate('q2'), candidate('q3')],
      [item for events in history.values() for item in events], [], history,
    )

    self.assertNotEqual('q3', ranked[0]['question_id'])
    self.assertNotEqual('q3', ranked[1]['question_id'])

  def test_wrong_question_stays_prioritized_even_when_exposure_is_high(self):
    strategy = RuleBasedQuestionSelectionStrategy(rng=random.Random(2))
    session = AdaptiveTestSession(
      id='new-session', course_id='c1', lecture_document_id='lecture-1', target_question_count=2,
    )
    history = {
      'stable': [event(question_id='stable', correct=True, score=1.0, test_session_id='old') for _ in range(3)],
      'wrong': [event(question_id='wrong', correct=False, score=0.0, test_session_id='old') for _ in range(6)],
    }
    ranked = strategy.rank(
      session, [candidate('stable'), candidate('wrong')],
      [item for events in history.values() for item in events], [], history,
    )

    self.assertEqual('wrong', ranked[0]['question_id'])

  def test_wrong_question_bonus_fades_after_consecutive_correct_answers(self):
    wrong = event(
      question_id='q1', correct=False, score=0.0, created_at='2026-01-01T00:00:00Z',
    )
    correct = [
      event(
        question_id='q1', correct=True, score=1.0,
        test_session_id=f'correct-{index}', created_at=f'2026-01-0{index + 2}T00:00:00Z',
      )
      for index in range(3)
    ]

    bonuses = [question_retry_bonus([wrong, *correct[:count]]) for count in range(4)]

    self.assertEqual([2.4, 1.6, 0.8, 0.0], bonuses)

  def test_equal_priority_questions_use_controlled_randomness(self):
    strategy = RuleBasedQuestionSelectionStrategy(rng=random.Random(4))
    session = AdaptiveTestSession(
      id='new-session', course_id='c1', lecture_document_id='lecture-1', target_question_count=2,
    )
    candidates = [candidate('q1'), candidate('q2'), candidate('q3')]

    orderings = {
      tuple(item['question_id'] for item in strategy.rank(session, candidates, [], []))
      for _ in range(12)
    }

    self.assertGreater(len(orderings), 1)

  def test_questions_from_previous_session_receive_recent_exposure_penalty(self):
    strategy = RuleBasedQuestionSelectionStrategy(rng=random.Random(6))
    session = AdaptiveTestSession(
      id='new-session', course_id='c1', lecture_document_id='lecture-1', target_question_count=2,
    )
    history = {
      'recent': [event(
        question_id='recent', correct=True, score=1.0, test_session_id='latest-session',
        created_at='2026-01-03T00:00:00Z',
      )],
      'older': [event(
        question_id='older', correct=True, score=1.0, test_session_id='older-session',
        created_at='2026-01-01T00:00:00Z',
      )],
    }

    ranked = strategy.rank(
      session, [candidate('recent'), candidate('older')],
      [item for events in history.values() for item in events], [], history,
    )

    self.assertEqual('older', ranked[0]['question_id'])

  def test_revision_events_are_not_counted_twice_by_projection(self):
    original = event(question_id='q1', correct=False, score=0.0, created_at='2026-01-01T00:00:00Z')
    revision = event(
      question_id='q1', correct=True, score=1.0, created_at='2026-01-02T00:00:00Z',
    ).model_copy(update={
      'test_session_id': original.test_session_id,
      'revision': 2,
      'supersedes_event_id': original.id,
    })
    effective = LearningStateStore._latest_revisions([original, revision])

    projection = project_question_mastery(effective, ['q1'])[0]

    self.assertEqual(1, projection.attempts)
    self.assertEqual(1, projection.correct_count)

  def test_question_history_repository_is_course_and_lecture_scoped(self):
    with tempfile.TemporaryDirectory() as temporary_directory:
      store = LearningStateStore(Path(temporary_directory))
      first = AdaptiveTestSession(
        id='s1', course_id='c1', lecture_document_id='lecture-1', target_question_count=1,
      )
      second = AdaptiveTestSession(
        id='s2', course_id='c2', lecture_document_id='lecture-1', target_question_count=1,
      )
      store.create_session(first)
      store.create_session(second)
      store.record_answer(event(question_id='q1', test_session_id='s1'), first)
      store.record_answer(event(question_id='q2', test_session_id='s2', course_id='c2'), second)
      from backend.learning_repositories import StoreEventRepository

      history = StoreEventRepository(store).question_history_for_lecture('c1', 'lecture-1')

      self.assertEqual(['q1'], list(history))


if __name__ == '__main__':
  unittest.main()
