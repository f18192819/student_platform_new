import { useEffect, useRef, useState } from 'react'
import {
  deleteUserQuestionAnswer,
  loadUserQuestionAnswerAttempt,
  loadUserQuestionAnswerAttempts,
  retryUserAnswerGrading,
  uploadUserQuestionAnswer,
  type QuestionAnswerIdentity,
  type UserAnswerAttemptSummary,
  type UserQuestionAnswer,
} from '../../lib/userAnswers'
import {
  ACTIVE_USER_ANSWER_STATUSES,
  USER_ANSWER_POLL_DELAYS_MS,
  userAnswerPollDelay,
} from './questionAnswerState'

export { USER_ANSWER_POLL_DELAYS_MS } from './questionAnswerState'

function summaryOf(attempt: UserQuestionAnswer): UserAnswerAttemptSummary {
  return {
    id: attempt.id,
    attempt_number: attempt.attempt_number,
    created_at: attempt.created_at,
    updated_at: attempt.updated_at,
    processing_status: attempt.processing_status,
    score: attempt.grading?.score ?? null,
    correct: attempt.grading?.correct ?? null,
    needs_review: attempt.grading?.needs_review ?? attempt.processing_status === 'needs_review',
    asset_count: attempt.assets.length,
    grading_model: attempt.grading_model,
  }
}

export function useQuestionAnswer({ enabled, identity, sourceType }: {
  enabled: boolean
  identity: QuestionAnswerIdentity
  sourceType: 'homework' | 'past-exam'
}) {
  const [attempts, setAttempts] = useState<UserAnswerAttemptSummary[]>([])
  const [details, setDetails] = useState<Record<string, UserQuestionAnswer>>({})
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const identityKey = `${identity.courseId}:${identity.sourceDocumentId}:${identity.questionId}`
  const identityKeyRef = useRef(identityKey)
  identityKeyRef.current = identityKey
  const { courseId, sourceDocumentId, questionId } = identity

  useEffect(() => {
    setAttempts([])
    setDetails({})
    setError(null)
    if (!enabled) return
    const controller = new AbortController()
    let timer: number | undefined
    let retryIndex = 0
    let requestRunning = false

    const schedule = (delay: number) => {
      if (!controller.signal.aborted) timer = window.setTimeout(() => void refresh(), delay)
    }
    const refresh = async (initial = false) => {
      if (requestRunning || controller.signal.aborted) return
      requestRunning = true
      if (initial) setIsLoading(true)
      try {
        const next = await loadUserQuestionAnswerAttempts(
          { courseId, sourceDocumentId, questionId }, controller.signal,
        )
        if (controller.signal.aborted) return
        setAttempts(next)
        setError(null)
        retryIndex = 0
        if (next.some((attempt) => ACTIVE_USER_ANSWER_STATUSES.has(attempt.processing_status))) {
          schedule(USER_ANSWER_POLL_DELAYS_MS[0])
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '读取我的答案失败。')
          const delay = userAnswerPollDelay(retryIndex)
          retryIndex += 1
          schedule(delay)
        }
      } finally {
        requestRunning = false
        if (initial && !controller.signal.aborted) setIsLoading(false)
      }
    }
    void refresh(true)
    return () => {
      controller.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [enabled, courseId, sourceDocumentId, questionId, refreshTick])

  const loadAttempt = async (attemptId: string, force = false) => {
    if (!enabled || (!force && details[attemptId])) return details[attemptId] ?? null
    const requestedIdentity = identityKey
    try {
      const detail = await loadUserQuestionAnswerAttempt(
        { courseId, sourceDocumentId, questionId }, attemptId,
      )
      if (identityKeyRef.current !== requestedIdentity) return null
      setDetails((current) => ({ ...current, [attemptId]: detail }))
      return detail
    } catch (reason) {
      if (identityKeyRef.current === requestedIdentity) {
        setError(reason instanceof Error ? reason.message : '读取作答详情失败。')
      }
      return null
    }
  }

  const upload = async (files: File[]) => {
    setIsSaving(true)
    setError(null)
    try {
      const next = await uploadUserQuestionAnswer(
        { courseId, sourceDocumentId, questionId }, sourceType, files,
      )
      setAttempts((current) => [summaryOf(next), ...current])
      setDetails((current) => ({ ...current, [next.id]: next }))
      setRefreshTick((current) => current + 1)
      return next
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传答案失败。')
      return null
    } finally {
      setIsSaving(false)
    }
  }

  const retry = async (attemptId: string) => {
    setError(null)
    try {
      await retryUserAnswerGrading({ courseId, sourceDocumentId, questionId }, attemptId)
      setAttempts((current) => current.map((attempt) => (
        attempt.id === attemptId ? { ...attempt, processing_status: 'pending' } : attempt
      )))
      setDetails((current) => {
        const detail = current[attemptId]
        return detail ? {
          ...current,
          [attemptId]: { ...detail, processing_status: 'pending', grading_error: '' },
        } : current
      })
      setRefreshTick((current) => current + 1)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重新批改失败。')
      return false
    }
  }

  const remove = async () => {
    setIsSaving(true)
    setError(null)
    try {
      await deleteUserQuestionAnswer({ courseId, sourceDocumentId, questionId })
      setAttempts([])
      setDetails({})
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除答案失败。')
      return false
    } finally {
      setIsSaving(false)
    }
  }

  return { attempts, details, isLoading, isSaving, error, loadAttempt, upload, retry, remove }
}
