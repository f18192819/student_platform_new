import { useCallback, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { loadApiConfig } from '../../lib/apiConfig'
import {
  buildClassroomSessionFromSequentialAlignment,
  transcribeAudioWithConfiguredAsr,
} from '../../lib/ai'
import {
  getKnowledgeFile,
  saveKnowledgeClassroomSession,
} from '../../lib/knowledgeBase'
import { emitLessonProcessingState } from '../pdf-workspace/utils'
import {
  appendLessonRecordingChunk,
  createLessonRecordingDraft,
  getLessonRecordingOwnerId,
  markLessonRecordingPending,
  readLessonRecordingDrafts,
  removeLessonRecordingDraft,
} from './recordingDraftStore'
import {
  LESSON_RECORDING_QUERY_EVENT,
  LESSON_RECORDING_TOGGLE_EVENT,
  publishLessonRecordingState,
  publishLessonRecordingUpdated,
} from './lessonRecordingState'

type RecordingContext = {
  courseId: string | null
  documentId: string | null
}

function contextFromLocation(search: string): RecordingContext {
  const params = new URLSearchParams(search)
  return {
    courseId: params.get('course')?.trim() || null,
    documentId: params.get('file')?.trim() || null,
  }
}

export function LessonRecordingController() {
  const location = useLocation()
  const routeContextRef = useRef<RecordingContext>(contextFromLocation(location.search))
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const chunkOrderRef = useRef(0)
  const chunkWritesRef = useRef<Promise<void>>(Promise.resolve())
  const chunkWriteFailedRef = useRef(false)
  const activeDraftIdsRef = useRef<Set<string>>(new Set())
  const recoveryInFlightRef = useRef(false)
  const recoveryScanRef = useRef<Promise<void>>(Promise.resolve())
  const startingRef = useRef(false)

  useEffect(() => {
    routeContextRef.current = contextFromLocation(location.search)
  }, [location.search])

  const processRecording = useCallback(async (
    audioBlob: Blob,
    context: RecordingContext,
    sourceLabel: string,
  ) => {
    if (!audioBlob.size) return false

    let recordingPersisted = false
    try {
      emitLessonProcessingState('ASR 转写中')
      const config = loadApiConfig()
      const transcript = await transcribeAudioWithConfiguredAsr(
        audioBlob,
        config,
        context.courseId
          ? { courseId: context.courseId, documentId: context.documentId }
          : undefined,
      )
      recordingPersisted = Boolean(transcript.recording)

      const targetDocument = context.documentId ? getKnowledgeFile(context.documentId) : null
      if (
        transcript.recording
        && context.courseId
        && context.documentId
        && targetDocument?.pipelineStatus === 'completed'
      ) {
        emitLessonProcessingState('课堂整理/映射中')
        const session = await buildClassroomSessionFromSequentialAlignment(
          transcript,
          context.courseId,
          context.documentId,
        )
        saveKnowledgeClassroomSession(context.documentId, session)
        emitLessonProcessingState('已完成')
      } else {
        emitLessonProcessingState(
          context.courseId ? '等待上传讲义' : '等待选择课程或上传讲义',
        )
      }
      publishLessonRecordingUpdated()
      return recordingPersisted
    } catch (error) {
      console.warn(`${sourceLabel} processing failed:`, error)
      emitLessonProcessingState(recordingPersisted ? '课堂映射失败，录音与 ASR 已保存' : '处理失败')
      if (recordingPersisted) publishLessonRecordingUpdated()
      return recordingPersisted
    } finally {
      window.setTimeout(() => emitLessonProcessingState(''), 1800)
    }
  }, [])

  const finalizeRecording = useCallback(async (
    recorder: MediaRecorder,
    draftId: string | null,
    context: RecordingContext,
  ) => {
    publishLessonRecordingState(false)
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    mediaRecorderRef.current = null

    await chunkWritesRef.current
    let audioBlob = new Blob(chunksRef.current, {
      type: recorder.mimeType || 'audio/webm',
    })
    chunksRef.current = []

    if (draftId) {
      try {
        await markLessonRecordingPending(draftId)
        const recovered = (await readLessonRecordingDrafts(getLessonRecordingOwnerId()))
          .find((item) => item.draft.id === draftId)
        if (!chunkWriteFailedRef.current && recovered?.blob.size === audioBlob.size) {
          audioBlob = recovered.blob
        }
      } catch (error) {
        console.warn('Failed to finalize the persistent recording draft:', error)
      }
    }

    const saved = await processRecording(audioBlob, context, '课堂录音')
    if (saved && draftId) {
      await removeLessonRecordingDraft(draftId).catch((error) => {
        console.warn('Failed to remove a submitted recording draft:', error)
      })
    }
    if (draftId) activeDraftIdsRef.current.delete(draftId)
  }, [processRecording])

  const startRecording = useCallback(async () => {
    if (startingRef.current || mediaRecorderRef.current?.state === 'recording') return
    startingRef.current = true
    let stream: MediaStream | null = null
    let draftId: string | null = null
    let draftCreationAttempted = false

    try {
      const context = { ...routeContextRef.current }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      await recoveryScanRef.current
      draftCreationAttempted = true
      const draft = await createLessonRecordingDraft({
        ownerId: getLessonRecordingOwnerId(),
        courseId: context.courseId,
        documentId: context.documentId,
        mimeType: recorder.mimeType || 'audio/webm',
      })
      draftId = draft.id
      const createdDraftId = draft.id

      chunksRef.current = []
      chunkOrderRef.current = 0
      chunkWritesRef.current = Promise.resolve()
      chunkWriteFailedRef.current = false
      activeDraftIdsRef.current.add(createdDraftId)
      streamRef.current = stream
      mediaRecorderRef.current = recorder

      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size) return
        chunksRef.current.push(event.data)
        const order = chunkOrderRef.current++
        chunkWritesRef.current = chunkWritesRef.current
          .then(() => appendLessonRecordingChunk(createdDraftId, order, event.data))
          .catch((error) => {
            chunkWriteFailedRef.current = true
            console.warn('Failed to persist a classroom recording chunk:', error)
            emitLessonProcessingState('录音暂未完整保存，请正常结束录音并等待上传')
          })
      })
      recorder.addEventListener(
        'stop',
        () => void finalizeRecording(recorder, createdDraftId, context),
        { once: true },
      )

      recorder.start(1000)
      publishLessonRecordingState(true)
      emitLessonProcessingState('录音中 · 已开启防丢保护')
    } catch (error) {
      console.warn('Unable to start classroom recording:', error)
      stream?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      mediaRecorderRef.current = null
      if (draftId) {
        activeDraftIdsRef.current.delete(draftId)
        await removeLessonRecordingDraft(draftId).catch((cleanupError) => {
          console.warn('Failed to remove an unstarted recording draft:', cleanupError)
        })
      }
      publishLessonRecordingState(false)
      emitLessonProcessingState(
        draftCreationAttempted ? '录音未开始：本地保存不可用' : stream ? '录音器启动失败' : '麦克风启动失败',
      )
      window.setTimeout(() => emitLessonProcessingState(''), 3000)
    } finally {
      startingRef.current = false
    }
  }, [finalizeRecording])

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    recorder.stop()
  }, [])

  useEffect(() => {
    const recoverInterruptedRecordings = async () => {
      if (recoveryInFlightRef.current) return
      recoveryInFlightRef.current = true
      let finishScan: () => void = () => {}
      recoveryScanRef.current = new Promise<void>((resolve) => { finishScan = resolve })
      try {
        const drafts = await readLessonRecordingDrafts(getLessonRecordingOwnerId(), true)
        const recoverable = drafts.filter((item) =>
          item.blob.size > 0 && !activeDraftIdsRef.current.has(item.draft.id),
        )
        finishScan()
        if (!recoverable.length) return
        emitLessonProcessingState(`正在恢复 ${recoverable.length} 段未提交录音`)
        for (const item of recoverable) {
          await markLessonRecordingPending(item.draft.id)
          const saved = await processRecording(item.blob, {
            courseId: item.draft.courseId,
            documentId: item.draft.documentId,
          }, '刷新前的课堂录音')
          if (saved) await removeLessonRecordingDraft(item.draft.id)
        }
      } catch (error) {
        console.warn('Interrupted classroom recording recovery failed:', error)
        emitLessonProcessingState('录音恢复失败，可刷新重试')
      } finally {
        finishScan()
        recoveryInFlightRef.current = false
      }
    }

    void recoverInterruptedRecordings()
    window.addEventListener('online', recoverInterruptedRecordings)
    return () => window.removeEventListener('online', recoverInterruptedRecordings)
  }, [processRecording])

  useEffect(() => {
    const handleToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ nextRecording?: boolean; action?: 'toggle' }>).detail
      const isRecording = mediaRecorderRef.current?.state === 'recording'
      const shouldRecord = detail?.action === 'toggle'
        ? !isRecording
        : Boolean(detail?.nextRecording)
      if (shouldRecord) void startRecording()
      else stopRecording()
    }
    const handleStateQuery = () => {
      publishLessonRecordingState(mediaRecorderRef.current?.state === 'recording')
    }
    const persistLatestSlice = () => {
      const recorder = mediaRecorderRef.current
      if (recorder?.state !== 'recording') return
      try {
        recorder.requestData()
      } catch (error) {
        console.warn('Unable to flush the latest recording slice:', error)
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persistLatestSlice()
    }

    window.addEventListener(LESSON_RECORDING_TOGGLE_EVENT, handleToggle)
    window.addEventListener(LESSON_RECORDING_QUERY_EVENT, handleStateQuery)
    window.addEventListener('pagehide', persistLatestSlice)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.removeEventListener(LESSON_RECORDING_TOGGLE_EVENT, handleToggle)
      window.removeEventListener(LESSON_RECORDING_QUERY_EVENT, handleStateQuery)
      window.removeEventListener('pagehide', persistLatestSlice)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      persistLatestSlice()
    }
  }, [startRecording, stopRecording])

  return null
}
