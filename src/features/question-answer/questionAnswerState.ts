import type { UserAnswerGrading } from '../../lib/userAnswers'

export const ACTIVE_USER_ANSWER_STATUSES = new Set(['pending', 'processing'])
export const USER_ANSWER_POLL_DELAYS_MS = [1800, 3000, 5000, 8000] as const

export function userAnswerPollDelay(failureCount: number) {
  return USER_ANSWER_POLL_DELAYS_MS[
    Math.min(Math.max(0, failureCount), USER_ANSWER_POLL_DELAYS_MS.length - 1)
  ]
}

export function userAnswerGradingLabel(grading: Pick<UserAnswerGrading, 'correct' | 'needs_review'>) {
  if (grading.needs_review) return '需要人工确认'
  return grading.correct ? '基本正确' : '仍需改进'
}
