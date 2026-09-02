import { useEffect, useState } from 'react'
import {
  deleteUserQuestionAnswer,
  loadUserQuestionAnswerAttempts,
  retryUserAnswerGrading,
  uploadUserQuestionAnswer,
  type QuestionAnswerIdentity,
  type UserQuestionAnswer,
} from '../../lib/userAnswers'

const ACTIVE_STATUSES = new Set(['pending', 'processing'])

export function useQuestionAnswer({ enabled, identity, sourceType }: {
  enabled: boolean
  identity: QuestionAnswerIdentity
  sourceType: 'homework' | 'past-exam'
}) {
  const [attempts, setAttempts] = useState<UserQuestionAnswer[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)
  const { courseId, sourceDocumentId, questionId } = identity

  useEffect(() => {
    setAttempts([])
    setError(null)
    if (!enabled) return
    const controller = new AbortController()
    let timer: number | undefined
    const refresh = async (initial = false) => {
      if (initial) setIsLoading(true)
      try {
        const next = await loadUserQuestionAnswerAttempts(
          { courseId, sourceDocumentId, questionId }, controller.signal,
        )
        if (controller.signal.aborted) return
        setAttempts(next)
        setError(null)
        if (next.some((attempt) => ACTIVE_STATUSES.has(attempt.processing_status))) {
          timer = window.setTimeout(() => void refresh(), 1800)
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '读取我的答案失败。')
        }
      } finally {
        if (initial && !controller.signal.aborted) setIsLoading(false)
      }
    }
    void refresh(true)
    return () => {
      controller.abort()
      if (timer) window.clearTimeout(timer)
    }
  }, [enabled, courseId, sourceDocumentId, questionId, refreshTick])

  const upload = async (files: File[]) => {
    setIsSaving(true)
    setError(null)
    try {
      const next = await uploadUserQuestionAnswer(
        { courseId, sourceDocumentId, questionId }, sourceType, files,
      )
      setAttempts((current) => [next, ...current])
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
        attempt.id === attemptId ? { ...attempt, processing_status: 'pending', grading_error: '' } : attempt
      )))
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
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除答案失败。')
      return false
    } finally {
      setIsSaving(false)
    }
  }

  return { attempts, answer: attempts[0] ?? null, isLoading, isSaving, error, upload, retry, remove }
}
