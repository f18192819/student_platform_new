import { useEffect, useState } from 'react'
import {
  deleteUserQuestionAnswer,
  loadUserQuestionAnswer,
  uploadUserQuestionAnswer,
  type QuestionAnswerIdentity,
  type UserQuestionAnswer,
} from '../../lib/userAnswers'

export function useQuestionAnswer({
  enabled,
  identity,
  sourceType,
}: {
  enabled: boolean
  identity: QuestionAnswerIdentity
  sourceType: 'homework' | 'past-exam'
}) {
  const [answer, setAnswer] = useState<UserQuestionAnswer | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { courseId, sourceDocumentId, questionId } = identity

  useEffect(() => {
    setAnswer(null)
    setError(null)
    if (!enabled) return
    const controller = new AbortController()
    setIsLoading(true)
    void loadUserQuestionAnswer({ courseId, sourceDocumentId, questionId }, controller.signal)
      .then(setAnswer)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : '读取我的答案失败。')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false)
      })
    return () => controller.abort()
  }, [enabled, courseId, sourceDocumentId, questionId])

  const upload = async (files: File[]) => {
    setIsSaving(true)
    setError(null)
    try {
      const next = await uploadUserQuestionAnswer(
        { courseId, sourceDocumentId, questionId }, sourceType, files,
      )
      setAnswer(next)
      return next
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传答案失败。')
      return null
    } finally {
      setIsSaving(false)
    }
  }

  const remove = async () => {
    setIsSaving(true)
    setError(null)
    try {
      await deleteUserQuestionAnswer({ courseId, sourceDocumentId, questionId })
      setAnswer(null)
      return true
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除答案失败。')
      return false
    } finally {
      setIsSaving(false)
    }
  }

  return { answer, isLoading, isSaving, error, upload, remove }
}
