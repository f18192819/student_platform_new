import assert from 'node:assert/strict'
import test from 'node:test'

import {
  userAnswerGradingLabel,
  userAnswerPollDelay,
} from '../src/features/question-answer/questionAnswerState'

test('poll backoff is finite and capped', () => {
  assert.deepEqual(
    [0, 1, 2, 3, 8].map(userAnswerPollDelay),
    [1800, 3000, 5000, 8000, 8000],
  )
})

test('needs-review presentation takes priority over correct', () => {
  assert.equal(userAnswerGradingLabel({ correct: true, needs_review: true }), '需要人工确认')
  assert.equal(userAnswerGradingLabel({ correct: true, needs_review: false }), '基本正确')
  assert.equal(userAnswerGradingLabel({ correct: false, needs_review: false }), '仍需改进')
})
