from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from backend.learning_state import LearningStateStore
from backend.user_answer_review import (
  ReviewErrorInput,
  SaveQuestionReviewRequest,
  UserAnswerReviewService,
)
from backend.user_answers import (
  AnswerUnderstanding,
  ErrorAnalysis,
  UserAnswerConflictError,
  UserAnswerGrading,
  UserAnswerQuestionResult,
  UserAnswerStore,
  normalize_error_deductions,
)


PNG = b'\x89PNG\r\n\x1a\nreview-answer'


class Resolver:
  def source_type(self, *_args):
    return 'homework'


class Contexts:
  def resolve(self, *_args):
    return {
      'analysis': {
        'knowledge_points': ['Gauss theorem', 'Gauss theorem', 'Electric flux'],
        'difficulty': {'level': 4},
      },
    }


def upload():
  return SimpleNamespace(filename='answer.png', content_type='image/png', file=io.BytesIO(PNG))


def grading(score: float = 0.7) -> UserAnswerGrading:
  return UserAnswerGrading(
    score=score,
    correct=False,
    confidence=0.9,
    errors=[
      ErrorAnalysis(type='formula_error', problem='Formula', severity='high', deduction=0.2),
      ErrorAnalysis(type='calculation_error', problem='Sign', severity='low', deduction=0.1),
    ] if score < 1 else [],
  )


class UserAnswerReviewTest(unittest.TestCase):
  def setUp(self):
    self.temporary = tempfile.TemporaryDirectory()
    root = Path(self.temporary.name)
    self.answers = UserAnswerStore(root / 'answers', Resolver())
    self.learning = LearningStateStore(root / 'learning')
    self.service = UserAnswerReviewService(self.answers, self.learning, Contexts())
    self.attempt = self.answers.replace(
      'course-1', 'document-1', 'route-question', 'homework', [upload()],
    )
    self.answers.save_document_grading(
      'course-1', self.attempt.question_id, self.attempt.id,
      question_results=[UserAnswerQuestionResult(
        question_id='q1',
        question_index=1,
        understanding=AnswerUnderstanding(transcription='student answer'),
        grading=grading(),
      )],
      model='grader',
      version='v1',
    )

  def tearDown(self):
    self.temporary.cleanup()

  def request(self, *, accept_first=True, accept_second=True):
    return SaveQuestionReviewRequest(
      base_grading_revision=1,
      errors=[
        ReviewErrorInput(id='ai-error-1', source='ai', accepted=accept_first),
        ReviewErrorInput(id='ai-error-2', source='ai', accepted=accept_second),
      ],
    )

  def test_error_deductions_are_stable_and_sum_to_score_gap(self):
    normalized = normalize_error_deductions(grading())

    self.assertEqual(['ai-error-1', 'ai-error-2'], [item.id for item in normalized.errors])
    self.assertAlmostEqual(0.3, sum(item.deduction for item in normalized.errors))
    self.assertAlmostEqual(0.2, normalized.errors[0].deduction)
    self.assertAlmostEqual(0.1, normalized.errors[1].deduction)

    fallback = normalize_error_deductions(UserAnswerGrading(
      score=0.6, correct=False, confidence=0.8, errors=[],
    ))
    self.assertEqual('uncertain', fallback.errors[0].type)
    self.assertAlmostEqual(0.4, fallback.errors[0].deduction)

  def test_review_is_idempotent_and_revisions_learning_evidence(self):
    attempt, first = self.service.save(
      'course-1', 'document-1', 'route-question', self.attempt.id, 'q1', self.request(),
    )
    self.assertAlmostEqual(0.7, first.final_score)
    self.assertEqual(1, len(attempt.manual_review_revisions))
    events = self.learning.effective_course_events('course-1')
    self.assertEqual(1, len(events))
    self.assertEqual('self-submitted-homework', events[0].source_type)
    self.assertEqual(['Gauss theorem', 'Electric flux'], events[0].knowledge_points)
    self.assertEqual(4, events[0].difficulty)
    self.assertEqual(2, len(events[0].error_evidence))
    summary = self.answers.list_attempt_summaries('course-1', 'document-1', 'route-question')[0]
    self.assertAlmostEqual(0.7, summary.score)
    self.assertFalse(summary.needs_review)

    repeated_attempt, repeated = self.service.save(
      'course-1', 'document-1', 'route-question', self.attempt.id, 'q1', self.request(),
    )
    self.assertEqual(first.revision, repeated.revision)
    self.assertEqual(1, len(repeated_attempt.manual_review_revisions))
    self.assertEqual(1, len(self.learning.course_events('course-1')))

    revised_attempt, revised = self.service.save(
      'course-1', 'document-1', 'route-question', self.attempt.id, 'q1',
      self.request(accept_second=False),
    )
    self.assertAlmostEqual(0.8, revised.final_score)
    self.assertEqual(2, len(revised_attempt.manual_review_revisions))
    all_events = self.learning.course_events('course-1')
    self.assertEqual(2, len(all_events))
    self.assertEqual(2, all_events[-1].revision)
    self.assertEqual(all_events[0].id, all_events[-1].supersedes_event_id)
    self.assertEqual(1, len(self.learning.effective_course_events('course-1')))
    self.assertEqual(1, len(all_events[-1].error_evidence))

  def test_user_error_reduces_score_and_obsolete_grading_conflicts(self):
    request = SaveQuestionReviewRequest(
      base_grading_revision=1,
      errors=[
        ReviewErrorInput(id='ai-error-1', source='ai', accepted=False),
        ReviewErrorInput(id='ai-error-2', source='ai', accepted=False),
        ReviewErrorInput(
          id='manual-1', source='user', accepted=True, type='calculation_error',
          problem='Final sign is wrong.', correction='Check the sign.', deduction=0.15,
        ),
      ],
    )
    _, review = self.service.save(
      'course-1', 'document-1', 'route-question', self.attempt.id, 'q1', request,
    )
    self.assertAlmostEqual(0.85, review.final_score)

    current = self.answers.get_attempt('course-1', 'document-1', 'route-question', self.attempt.id)
    self.answers.save_document_grading(
      'course-1', current.question_id, current.id,
      question_results=current.question_results, model='grader', version='v2',
    )
    with self.assertRaises(UserAnswerConflictError):
      self.service.save(
        'course-1', 'document-1', 'route-question', self.attempt.id, 'q1', request,
      )
    summary = self.answers.list_attempt_summaries('course-1', 'document-1', 'route-question')[0]
    self.assertAlmostEqual(0.7, summary.score)

  def test_targeted_answer_deletion_removes_only_its_learning_events(self):
    self.service.save(
      'course-1', 'document-1', 'route-question', self.attempt.id, 'q1', self.request(),
    )
    self.assertEqual(1, self.service.delete_attempt_evidence('course-1', [self.attempt.id]))
    self.assertEqual([], self.learning.course_events('course-1'))


if __name__ == '__main__':
  unittest.main()
