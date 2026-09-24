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
  readRecoverableLessonRecordingDrafts,
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

type ActiveRecordingSession = {
  recorder: MediaRecorder
  stream: MediaStream
  chunks: Blob[]
  chunkOrder: number
  chunkWrites: Promise<void>
  draftId: string | null
  context: RecordingContext
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
  const activeSessionRef = useRef<ActiveRecordingSession | null>(null)
  const recoveryStartedRef = useRef(false)
  const startingRef = useRef(false)

  useEffect(() => {
    routeContextRef.current = contextFromLocation(location.search)
  }, [location.search])

  const processRecording = useCallback(async (
    audioBlob: Blob,
    context: RecordingContext,
    sourceLabel: string,
    clientRecordingId?: string | null,
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
          ? {
              courseId: context.courseId,
              documentId: context.documentId,
              clientRecordingId,
            }
          : clientRecordingId
            ? { courseId: '', documentId: null, clientRecordingId }
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
      // The backend now persists the raw recording before ASR, so a failed
      // transcription may still have a durable history entry.
      publishLessonRecordingUpdated()
      return recordingPersisted
    } finally {
      window.setTimeout(() => emitLessonProcessingState(''), 1800)
    }
  }, [])

  const finalizeRecording = useCallback(async (session: ActiveRecordingSession) => {
    if (activeSessionRef.current === session) {
      activeSessionRef.current = null
      publishLessonRecordingState(false)
    }
    session.stream.getTracks().forEach((track) => track.stop())

    await session.chunkWrites
    let audioBlob = new Blob(session.chunks, {
      type: session.recorder.mimeType || 'audio/webm',
    })

    if (session.draftId) {
      try {
        await markLessonRecordingPending(session.draftId)
        const recovered = (await readLessonRecordingDrafts(getLessonRecordingOwnerId()))
          .find((item) => item.draft.id === session.draftId)
        if (recovered?.blob.size) audioBlob = recovered.blob
      } catch (error) {
        console.warn('Failed to finalize the persistent recording draft:', error)
      }
    }

    const saved = await processRecording(
      audioBlob,
      session.context,
      '课堂录音',
      session.draftId,
    )
    if (saved && session.draftId) {
      await removeLessonRecordingDraft(session.draftId).catch((error) => {
        console.warn('Failed to remove a submitted recording draft:', error)
      })
    }
  }, [processRecording])

  const startRecording = useCallback(async () => {
    if (startingRef.current || activeSessionRef.current) return
    startingRef.current = true

    try {
      const context = { ...routeContextRef.current }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      let draftId: string | null = null
      try {
        const draft = await createLessonRecordingDraft({
          ownerId: getLessonRecordingOwnerId(),
          courseId: context.courseId,
          documentId: context.documentId,
          mimeType: recorder.mimeType || 'audio/webm',
        })
        draftId = draft.id
      } catch (error) {
        console.warn('Recording draft persistence is unavailable:', error)
      }

      const session: ActiveRecordingSession = {
        recorder,
        stream,
        chunks: [],
        chunkOrder: 0,
        chunkWrites: Promise.resolve(),
        draftId,
        context,
      }
      activeSessionRef.current = session

      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data.size) return
        session.chunks.push(event.data)
        if (!session.draftId) return
        const order = session.chunkOrder++
        session.chunkWrites = session.chunkWrites
          .then(() => appendLessonRecordingChunk(session.draftId!, order, event.data))
          .catch((error) => console.warn('Failed to persist a classroom recording chunk:', error))
      })
      recorder.addEventListener(
        'stop',
        () => void finalizeRecording(session),
        { once: true },
      )

      recorder.start(1000)
      publishLessonRecordingState(true)
      emitLessonProcessingState(draftId ? '录音中 · 已开启防丢保护' : '录音中 · 本地保护不可用')
    } catch (error) {
      console.warn('Unable to start classroom recording:', error)
      publishLessonRecordingState(false)
      emitLessonProcessingState('麦克风启动失败')
      window.setTimeout(() => emitLessonProcessingState(''), 3000)
    } finally {
      startingRef.current = false
    }
  }, [finalizeRecording])

  const stopRecording = useCallback(() => {
    const session = activeSessionRef.current
    if (!session || session.recorder.state === 'inactive') return
    session.recorder.stop()
  }, [])

  useEffect(() => {
    if (recoveryStartedRef.current) return
    recoveryStartedRef.current = true

    const recoverInterruptedRecordings = async () => {
      try {
        const drafts = await readRecoverableLessonRecordingDrafts()
        const recoverable = drafts.filter((item) => item.blob.size > 0)
        if (!recoverable.length) return
        emitLessonProcessingState(`正在恢复 ${recoverable.length} 段未提交录音`)
        for (const item of recoverable) {
          await markLessonRecordingPending(item.draft.id)
          const saved = await processRecording(item.blob, {
            courseId: item.draft.courseId,
            documentId: item.draft.documentId,
          }, '刷新前的课堂录音', item.draft.id)
          if (saved) await removeLessonRecordingDraft(item.draft.id)
        }
      } catch (error) {
        console.warn('Interrupted classroom recording recovery failed:', error)
        emitLessonProcessingState('录音恢复失败，可刷新重试')
      }
    }

    void recoverInterruptedRecordings()
  }, [processRecording])

  useEffect(() => {
    const handleToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ nextRecording?: boolean; action?: 'toggle' }>).detail
      const isRecording = activeSessionRef.current?.recorder.state === 'recording'
      const shouldRecord = detail?.action === 'toggle'
        ? !isRecording
        : Boolean(detail?.nextRecording)
      if (shouldRecord) void startRecording()
      else stopRecording()
    }
    const handleStateQuery = () => {
      publishLessonRecordingState(activeSessionRef.current?.recorder.state === 'recording')
    }
    const persistLatestSlice = () => {
      const recorder = activeSessionRef.current?.recorder
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
