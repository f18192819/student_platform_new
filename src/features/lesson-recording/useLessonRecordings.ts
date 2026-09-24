import { useCallback, useEffect, useState } from 'react'
import { fetchLectureRecordings, type LectureRecordingView } from './lessonRecordingApi'
import { LESSON_RECORDING_UPDATED_EVENT } from './lessonRecordingState'

export function useLessonRecordings(courseId: string | null, enabled = true) {
  const [records, setRecords] = useState<LectureRecordingView[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return
    setIsLoading(true)
    try {
      const next = await fetchLectureRecordings(courseId, signal)
      setRecords(next)
      setError('')
    } catch (reason) {
      if (signal?.aborted) return
      setError(reason instanceof Error ? reason.message : '课堂录音读取失败')
    } finally {
      if (!signal?.aborted) setIsLoading(false)
    }
  }, [courseId, enabled])

  useEffect(() => {
    if (!enabled) {
      setRecords([])
      return
    }
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [enabled, refresh])

  useEffect(() => {
    if (!enabled) return
    const handleUpdated = () => void refresh()
    window.addEventListener(LESSON_RECORDING_UPDATED_EVENT, handleUpdated)
    return () => window.removeEventListener(LESSON_RECORDING_UPDATED_EVENT, handleUpdated)
  }, [enabled, refresh])

  useEffect(() => {
    if (!enabled || !records.some((item) => item.status === 'transcribing' || item.status === 'transcribed' || item.status === 'aligning')) {
      return
    }
    const timer = window.setTimeout(() => void refresh(), 2500)
    return () => window.clearTimeout(timer)
  }, [enabled, records, refresh])

  return { records, isLoading, error, refresh }
}
