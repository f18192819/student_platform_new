import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  effectiveQuestionReview,
  effectiveQuestionScore,
  type UserAnswerQuestionResult,
  type UserQuestionAnswer,
} from '../src/lib/userAnswers'

const result = {
  question_id: 'question-1',
  grading: { score: 0.4 },
} as UserAnswerQuestionResult

test('only a review for the current grading revision changes the effective score', () => {
  const attempt = {
    grading_revisions: [{ revision: 1 }],
    manual_review_revisions: [{
      revision: 1,
      question_id: 'question-1',
      base_grading_revision: 1,
      final_score: 0.8,
    }],
  } as UserQuestionAnswer

  assert.equal(effectiveQuestionScore(attempt, result), 0.8)
  assert.equal(effectiveQuestionReview(attempt, 'question-1')?.revision, 1)

  attempt.grading_revisions.push({ revision: 2 })
  assert.equal(effectiveQuestionReview(attempt, 'question-1'), null)
  assert.equal(effectiveQuestionScore(attempt, result), 0.4)
})

test('grading list styles do not target KaTeX internal spans', () => {
  const css = readFileSync('src/App.css', 'utf8')
  const component = readFileSync('src/features/question-answer/QuestionAnswerViewer.tsx', 'utf8')

  assert.doesNotMatch(css, /\.question-answer-grading\s+li\s+span\s*\{/)
  assert.match(css, /\.question-answer-grading__knowledge-status\s*\{/)
  assert.match(component, /className="question-answer-grading__knowledge-status"/)
})
