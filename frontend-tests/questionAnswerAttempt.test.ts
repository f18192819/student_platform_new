import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { deleteUserQuestionAnswerAttempt } from '../src/lib/userAnswers'

test('single Attempt deletion uses its UUID endpoint', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/questions\/question-1\/attempts\/attempt-uuid$/)
    assert.equal(init?.method, 'DELETE')
    return new Response(JSON.stringify({
      deleted: true,
      attempt_id: 'attempt-uuid',
      remaining_attempts: 2,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const result = await deleteUserQuestionAnswerAttempt({
      courseId: 'course-1',
      sourceDocumentId: 'document-1',
      questionId: 'question-1',
    }, 'attempt-uuid')
    assert.equal(result.remaining_attempts, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('single Attempt deletion exposes structured backend detail', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    detail: { message: '该作答文件暂时正在被使用，请稍后再次删除。' },
  }), { status: 409, headers: { 'Content-Type': 'application/json' } })
  try {
    await assert.rejects(
      deleteUserQuestionAnswerAttempt({
        courseId: 'course-1',
        sourceDocumentId: 'document-1',
        questionId: 'question-1',
      }, 'attempt-uuid'),
      /暂时正在被使用/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Attempt card delete control is separate and stops card selection', () => {
  const component = readFileSync(
    'src/features/question-answer/QuestionAnswerViewer.tsx', 'utf8',
  )
  assert.match(component, /className="question-answer-history__delete"/)
  assert.match(component, /event\.stopPropagation\(\)/)
  assert.match(component, /原始答案文件将保留/)
  assert.match(component, /attemptDeletionMessage\(attempt\.attempt_number, attempts\.length\)/)
  assert.match(component, /此操作不可恢复/)

  const hook = readFileSync('src/features/question-answer/useQuestionAnswer.ts', 'utf8')
  assert.match(hook, /deletedAttemptIdsRef\.current\.has\(attemptId\)/)
})
