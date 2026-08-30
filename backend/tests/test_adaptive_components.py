from __future__ import annotations

import unittest

from backend.adaptive_grading import GradingResult, StructuredPartGrader
from backend.adaptive_results import AdaptiveTestResultAssembler
from backend.adaptive_selection import RuleBasedQuestionSelectionStrategy
from backend.assessment_planner import AssessmentOption, AssessmentPart, AssessmentSpec
from backend.learning_state import AdaptiveTestSession, LearningEvent


def event(*, question_id='q0', concepts=None, correct=False, score=0.0, difficulty=2):
  return LearningEvent(
    course_id='c1',
    lecture_document_id='lecture-1',
    test_session_id='session-1',
    question_id=question_id,
    source_type='homework',
    source_document_id='homework-1',
    knowledge_points=concepts or ['concept-a'],
    difficulty=difficulty,
    correct=correct,
    score=score,
    grading_method='test',
  )


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


if __name__ == '__main__':
  unittest.main()
