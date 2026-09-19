import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { PdfPreviewCanvas } from '../components/PdfPreviewCanvas'
import { ChatPanel } from '../features/pdf-workspace/components/ChatPanel'
import { PageLecturePlayer } from '../features/pdf-workspace/components/PageLecturePlayer'
import { RelatedMaterialsPanel } from '../features/pdf-workspace/components/RelatedMaterialsPanel'
import { LectureMasteryTest } from '../features/mastery-test/LectureMasteryTest'
import { LessonRecordingPanel } from '../features/lesson-recording/LessonRecordingPanel'
import { ClassroomToolsPanel } from '../features/pdf-annotations/ClassroomToolsPanel'
import { usePdfAnnotations } from '../features/pdf-annotations/usePdfAnnotations'
import {
  isLessonRecordingActive,
  LESSON_RECORDING_STATE_EVENT,
} from '../features/lesson-recording/lessonRecordingState'
import { useLessonRecordings } from '../features/lesson-recording/useLessonRecordings'
import { QuestionAnswerViewer } from '../features/question-answer/QuestionAnswerViewer'
import { usePageLecturePlayback } from '../features/pdf-workspace/hooks/usePageLecturePlayback'
import { useRelatedMaterials } from '../features/pdf-workspace/hooks/useRelatedMaterials'
import type {
  ComposerAttachment,
  HomeworkFocus,
  RelatedMaterialCard,
  ViewerSource,
} from '../features/pdf-workspace/types'
import {
  buildHomeworkContextMarkdown,
  buildLectureConversation,
  buildStructuredPageContext,
  createMessage,
  DEFAULT_DOCUMENT_NAME,
  emitLessonProcessingState,
  ensureActiveModel,
  groupHomeworkLinksByLecturePage,
  groupLectureSegmentsByPage,
  readFileAsDataUrl,
  updateMessageContent,
} from '../features/pdf-workspace/utils'
import {
  loadApiConfig,
  loadApiConfigFromServer,
  saveApiConfig,
} from '../lib/apiConfig'
import {
  buildClassroomSessionWithApi,
  buildClassroomSessionFromSequentialAlignment,
  loadCourseLectureRecordings,
  queuePendingCourseLectureRecordings,
  askWithConfiguredVisionApi,
  loadLatestDebugClassroomSession,
  summarizeChatMemoryWithConfiguredApi,
  transcribeAudioWithConfiguredAsr,
  type AsrTranscriptionResult,
} from '../lib/ai'
import {
  addKnowledgeHomeworkDocument,
  ensureKnowledgeLibraryLoaded,
  getKnowledgeFile,
  getKnowledgeHomeworkDocumentsByCourseFolder,
  loadKnowledgeHomeworkAsset,
  loadKnowledgePdfSource,
  resolveKnowledgePdfSourceUrl,
  resolveKnowledgePdfPageImageUrl,
  saveKnowledgeClassroomSession,
  saveKnowledgeHomeworkDocuments,
  saveKnowledgeHomeworkReaderChatState,
  saveKnowledgeReaderChatState,
  getKnowledgeCourse,
  touchKnowledgeFile,
  upsertKnowledgeFile,
} from '../lib/knowledgeBase'
import {
  appendReaderChatMessages,
  buildReaderChatContext,
  commitReaderChatSummary,
  createReaderChatSession,
  deriveReaderChatTitle,
  migrateReaderChatSessions,
  shouldCompactReaderChatSession,
} from '../lib/chatMemory'
import { createChatStreamBatcher, type ChatStreamBatcher } from '../lib/chatStreaming'
import { retrieveChatContext } from '../lib/chatRetrieval'
import type { PromptSourceSection } from '../lib/contextBudget'
import {
  buildFailedHomeworkDocument,
  buildPendingHomeworkDocument,
  getMineruUploadError,
  getMineruUploadKind,
  getLectureDocumentProcessingStatus,
  processHomeworkDocumentWithPipeline,
  readHomeworkAssetPayload,
  submitLectureDocumentForProcessing,
  type DocumentPipelineStatus,
} from '../lib/mineru'
import {
  extractPdfPreview,
  openPdfPreviewFromBuffer,
  openPdfPreviewFromUrlWithFallback,
} from '../lib/pdf'
import {
  clearPdfPreviewCache,
  disposePdfController,
  setBoundedPdfPreview,
} from '../lib/pdf-core/disposableCache'
import { useMineruHydrationGate } from '../lib/pdf-core/useMineruHydrationGate'
import { getPdfControllerId, pdfDiagnostic } from '../lib/pdf-core/performance'
import type {
  ApiConfig,
  ChatMessage,
  ChatReference,
  ClassroomSession,
  HomeworkDocument,
  KnowledgeHomeworkFolderType,
  PdfController,
  ReaderChatSession,
  StructuredDocumentBlock,
} from '../types'

export function PdfWorkspacePage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const initialFileId = searchParams.get('file')
  const initialHomeworkId = searchParams.get('homework')
  const initialHomeworkQuestionId = searchParams.get('question')
  const initialPageNumber = Math.max(1, Number(searchParams.get('page')) || 1)
  const currentCourseId = searchParams.get('course')
  const currentFolderType =
    searchParams.get('folder') === 'past-exam' ? 'past-exam' : ('homework' as KnowledgeHomeworkFolderType)
  const [questionInput, setQuestionInput] = useState('')
  const [documentText, setDocumentText] = useState('')
  const [documentName, setDocumentName] = useState(DEFAULT_DOCUMENT_NAME)
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null)
  const [pdfController, setPdfController] = useState<PdfController | null>(null)
  const [lectureDocumentName, setLectureDocumentName] = useState(DEFAULT_DOCUMENT_NAME)
  const [lectureDocumentText, setLectureDocumentText] = useState('')
  const [lecturePdfPageCount, setLecturePdfPageCount] = useState<number | null>(null)
  const [lecturePdfController, setLecturePdfController] = useState<PdfController | null>(null)
  const [lectureLayoutBlocks, setLectureLayoutBlocks] = useState<StructuredDocumentBlock[]>([])
  const [homeworkPreviewName, setHomeworkPreviewName] = useState('练习预览')
  const [homeworkPreviewController, setHomeworkPreviewController] = useState<PdfController | null>(null)
  const [homeworkPreviewPageCount, setHomeworkPreviewPageCount] = useState<number | null>(null)
  const [homeworkPreviewImageUrl, setHomeworkPreviewImageUrl] = useState<string | null>(null)
  const [homeworkPreviewLayoutBlocks, setHomeworkPreviewLayoutBlocks] = useState<
    StructuredDocumentBlock[]
  >([])
  const [viewerSource, setViewerSource] = useState<ViewerSource>({ kind: 'lecture' })
  const [forcedHomeworkPreviewPage, setForcedHomeworkPreviewPage] = useState<number | null>(null)
  const [knowledgeFileId, setKnowledgeFileId] = useState<string | null>(initialFileId)
  const [knowledgeCourseId, setKnowledgeCourseId] = useState<string | null>(currentCourseId)
  const [currentPage, setCurrentPage] = useState(initialPageNumber)
  const [readerVisualReady, setReaderVisualReady] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [apiConfig, setApiConfig] = useState<ApiConfig>(loadApiConfig())
  const pageLecturePlayback = usePageLecturePlayback()
  const stopPageLecturePlayback = pageLecturePlayback.stop
  const [isAsking, setIsAsking] = useState(false)
  const [_isRestoringFile, setIsRestoringFile] = useState(false)
  const [homeworkDocuments, setHomeworkDocuments] = useState<HomeworkDocument[]>([])
  const [homeworkFocus, setHomeworkFocus] = useState<HomeworkFocus | null>(null)
  const [, setIsExtractingHomework] = useState(false)
  const [_isProcessingLesson, setIsProcessingLesson] = useState(false)
  const [isLessonRecording, setIsLessonRecording] = useState(isLessonRecordingActive)
  const [pageLectureFilter, setPageLectureFilter] = useState<number | null>(null)
  const [isCaptureMode, setIsCaptureMode] = useState(false)
  const [classroomSessions, setClassroomSessions] = useState<ClassroomSession[]>([])
  const [readerChatSessions, setReaderChatSessions] = useState<ReaderChatSession[]>(() => {
    const now = new Date().toISOString()
    return [{
      id: 'reader-chat-default',
      title: '新对话',
      messages: [],
      compactionPoints: [],
      createdAt: now,
      updatedAt: now,
    }]
  })
  const [activeChatSessionId, setActiveChatSessionId] = useState('reader-chat-default')
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const readerChatSessionsRef = useRef(readerChatSessions)
  const activeChatSessionIdRef = useRef(activeChatSessionId)
  const loadedChatDocumentKeyRef = useRef<string | null>(null)
  const activeRequestRef = useRef<{
    controller: AbortController
    sessionId: string
    assistantMessageId: string
    documentKey: string
    batcher: ChatStreamBatcher
    persist: () => void
  } | null>(null)
  const saveChatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pdfInputRef = useRef<HTMLInputElement | null>(null)
  const chatUploadInputRef = useRef<HTMLInputElement | null>(null)
  const homeworkUploadInputRef = useRef<HTMLInputElement | null>(null)
  const lessonAudioUploadInputRef = useRef<HTMLInputElement | null>(null)
  const lessonTranscriptUploadInputRef = useRef<HTMLInputElement | null>(null)
  const lectureMineruInFlightRef = useRef<Set<string>>(new Set())
  const lectureMineruFailedRef = useRef<Set<string>>(new Set())
  const ownedPdfControllersRef = useRef(new Set<PdfController>())

  const interruptActiveRequest = useCallback((reason: string, updateUi = true) => {
    const request = activeRequestRef.current
    if (!request) return
    request.batcher.flush()
    request.persist()
    request.controller.abort(reason)
    if (updateUi) setIsAsking(false)
  }, [])

  const homeworkPreviewCacheRef = useRef<
    Map<
      string,
      {
        controller: PdfController | null
        imageUrl: string | null
        pageCount: number | null
        pageTexts: string[]
      }
    >
  >(new Map())
  const cacheHomeworkPreview = (
    documentId: string,
    preview: {
      controller: PdfController | null
      imageUrl: string | null
      pageCount: number | null
      pageTexts: string[]
    },
  ) => {
    // PDF.js page controllers retain render resources. Keep recently viewed
    // exercises available without allowing an unbounded cache in long sessions.
    setBoundedPdfPreview(homeworkPreviewCacheRef.current, documentId, preview, 4, {
      // A cache entry can still be mounted while React switches documents.
      // The workspace owns accepted controllers and disposes them on unmount.
      disposeRemoved: false,
    })
  }

  useEffect(() => () => {
    interruptActiveRequest('workspace-unmount', false)
    activeRequestRef.current?.batcher.dispose()
    if (saveChatTimerRef.current !== null) {
      clearTimeout(saveChatTimerRef.current)
    }
    clearPdfPreviewCache(homeworkPreviewCacheRef.current, { disposeRemoved: false })
    for (const controller of ownedPdfControllersRef.current) {
      void disposePdfController(controller, 'workspace-unmount')
    }
    ownedPdfControllersRef.current.clear()
  }, [interruptActiveRequest])
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([])
  const activeChatSession = useMemo(
    () => readerChatSessions.find((session) => session.id === activeChatSessionId) ?? readerChatSessions[0],
    [activeChatSessionId, readerChatSessions],
  )
  const chatMessages = activeChatSession?.messages ?? []
  const updateReaderChatSession = useCallback((
    sessionId: string,
    updater: (session: ReaderChatSession) => ReaderChatSession,
  ) => {
    const next = readerChatSessionsRef.current.map((session) =>
      session.id === sessionId ? updater(session) : session,
    )
    readerChatSessionsRef.current = next
    setReaderChatSessions(next)
    return next
  }, [])
  const setChatMessages = useCallback((updater: SetStateAction<ChatMessage[]>) => {
    const sessionId = activeChatSessionIdRef.current
    updateReaderChatSession(sessionId, (session) => {
      const nextMessages = typeof updater === 'function' ? updater(session.messages) : updater
      return { ...session, messages: nextMessages, updatedAt: new Date().toISOString() }
    })
  }, [updateReaderChatSession])

  useEffect(() => {
    readerChatSessionsRef.current = readerChatSessions
    activeChatSessionIdRef.current = activeChatSessionId
  }, [activeChatSessionId, readerChatSessions])

  const availableModels = useMemo(
    () => Array.from(new Set(apiConfig.models.map((model) => model.trim()).filter(Boolean))),
    [apiConfig.models],
  )
  const availableDoubtModels = useMemo(
    () => Array.from(new Set(apiConfig.doubtModels.map((model) => model.trim()).filter(Boolean))),
    [apiConfig.doubtModels],
  )
  const selectedHomework =
    homeworkDocuments.find((document) => document.id === homeworkFocus?.documentId) ??
    homeworkDocuments[0] ??
    null
  const activeReaderDocumentId = viewerSource.kind === 'homework'
    ? selectedHomework?.id ?? null
    : knowledgeFileId
  const activeReaderDocumentKey = activeReaderDocumentId
    ? `${viewerSource.kind}:${activeReaderDocumentId}`
    : null
  const activeKnowledgeCourseId = currentCourseId ?? knowledgeCourseId
  const activeKnowledgeCourseIdRef = useRef(activeKnowledgeCourseId)
  const knowledgeFileIdRef = useRef(knowledgeFileId)
  useEffect(() => {
    activeKnowledgeCourseIdRef.current = activeKnowledgeCourseId
    knowledgeFileIdRef.current = knowledgeFileId
  }, [activeKnowledgeCourseId, knowledgeFileId])
  useEffect(() => {
    if (!knowledgeCourseId) return
    const fileCourseMismatch = Boolean(
      knowledgeFileId && currentCourseId && currentCourseId !== knowledgeCourseId,
    )
    if (currentCourseId && !fileCourseMismatch) return
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set('course', knowledgeCourseId)
      return next
    }, { replace: true })
  }, [currentCourseId, knowledgeCourseId, knowledgeFileId, setSearchParams])
  const selectedHomeworkQuestion =
    selectedHomework?.questions.find((question) => question.id === homeworkFocus?.questionId) ?? null
  const allHomeworkKnowledgeLinks = useMemo(
    () => homeworkDocuments.flatMap((document) => document.knowledgeLinks ?? []),
    [homeworkDocuments],
  )
  const lecturePageQuestionLinks = useMemo(
    () => groupHomeworkLinksByLecturePage(allHomeworkKnowledgeLinks),
    [allHomeworkKnowledgeLinks],
  )
  const lectureSegmentsByPage = useMemo(
    () => groupLectureSegmentsByPage(classroomSessions),
    [classroomSessions],
  )
  const activeHomeworkContextMarkdown = useMemo(
    () =>
      viewerSource.kind === 'homework'
        ? buildHomeworkContextMarkdown(selectedHomework, selectedHomeworkQuestion, false)
        : '',
    [selectedHomework, selectedHomeworkQuestion, viewerSource.kind],
  )
  const {
    relatedMaterialCards,
    isLoadingRelatedMaterials,
    removeRelatedMaterial,
  } = useRelatedMaterials({
    courseId: activeKnowledgeCourseId,
    sourceKind: viewerSource.kind,
    questionId: selectedHomeworkQuestion?.id ?? null,
    lectureDocumentId: knowledgeFileId,
    pageNumber: currentPage,
  })

  const visibleConversationMessages = useMemo<ChatMessage[]>(() => {
    if (pageLectureFilter !== null) {
      const lectureMessages = buildLectureConversation(pageLectureFilter, lectureSegmentsByPage)
      if (lectureMessages.length) {
        return lectureMessages
      }

      return [
        createMessage(
          'system',
          `第 ${pageLectureFilter} 页暂时还没有可展示的课堂讲解。`,
        ),
      ]
    }

    return chatMessages.filter((message) => !message.isSummary)
  }, [
    chatMessages,
    lectureSegmentsByPage,
    pageLectureFilter,
  ])

  const currentViewerName =
    viewerSource.kind === 'homework' ? homeworkPreviewName : documentName
  const currentViewerController =
    viewerSource.kind === 'homework' ? homeworkPreviewController : pdfController
  const currentViewerPageCount =
    viewerSource.kind === 'homework' ? homeworkPreviewPageCount : pdfPageCount
  const currentViewerImageUrl =
    viewerSource.kind === 'homework' ? homeworkPreviewImageUrl : null
  const currentViewerStructuredBlocks =
    viewerSource.kind === 'homework' ? homeworkPreviewLayoutBlocks : lectureLayoutBlocks
  const mineruHydrationAllowed = useMineruHydrationGate(
    knowledgeFileId,
    lecturePdfController,
    readerVisualReady,
  )
  const annotationDocumentId = viewerSource.kind === 'homework'
    ? selectedHomework?.id ?? null
    : knowledgeFileId
  const annotationDocumentKey = activeKnowledgeCourseId && annotationDocumentId
    ? `${activeKnowledgeCourseId}:${viewerSource.kind}:${annotationDocumentId}`
    : ''
  const pdfAnnotations = usePdfAnnotations(annotationDocumentKey)
  const currentPageAnnotationCount = pdfAnnotations.annotations.filter(
    (annotation) => annotation.pageNumber === currentPage,
  ).length
  const isLectureViewer = viewerSource.kind === 'lecture'
  const resolveLecturePageImage = useCallback(
    (pageNumber: number) =>
      isLectureViewer && knowledgeFileId
        ? resolveKnowledgePdfPageImageUrl(knowledgeFileId, pageNumber, getKnowledgeFile(knowledgeFileId)?.updatedAt)
        : null,
    [isLectureViewer, knowledgeFileId],
  )
  const {
    records: lessonRecordingRecords,
    isLoading: isLoadingLessonRecordings,
    error: lessonRecordingsError,
    refresh: refreshLessonRecordings,
  } = useLessonRecordings(activeKnowledgeCourseId, isLectureViewer)
  const activeHomeworkDocumentId =
    viewerSource.kind === 'homework' ? viewerSource.documentId : null

  useEffect(() => {
    if (isLectureViewer) {
      return
    }

    stopPageLecturePlayback()
  }, [isLectureViewer, stopPageLecturePlayback])
  const referencedBlockIds = useMemo(() => {
    const next = new Set<string>()
    for (const attachment of composerAttachments) {
      const reference = attachment.blockReference
      if (!reference?.blockId) {
        continue
      }
      if (viewerSource.kind === 'lecture' && reference.viewer === 'lecture') {
        next.add(reference.blockId)
        continue
      }
      if (
        viewerSource.kind === 'homework' &&
        reference.viewer === 'homework' &&
        reference.documentId === viewerSource.documentId
      ) {
        next.add(reference.blockId)
      }
    }
    return next
  }, [composerAttachments, viewerSource])

  const persistReaderChatStateNow = useCallback((
    sessions = readerChatSessionsRef.current,
    sessionId = activeChatSessionIdRef.current,
  ) => {
    if (viewerSource.kind === 'homework' && selectedHomework && activeKnowledgeCourseId) {
      saveKnowledgeHomeworkReaderChatState(
        activeKnowledgeCourseId,
        currentFolderType,
        selectedHomework.id,
        sessions,
        sessionId,
      )
      setHomeworkDocuments((current) => current.map((document) => document.id === selectedHomework.id
        ? { ...document, readerChatSessions: sessions, activeChatSessionId: sessionId }
        : document))
    } else if (knowledgeFileId) {
      saveKnowledgeReaderChatState(knowledgeFileId, sessions, sessionId)
    }
  }, [activeKnowledgeCourseId, currentFolderType, knowledgeFileId, selectedHomework, viewerSource.kind])

  const handleSessionChange = useCallback((sessionId: string) => {
    if (isAsking || !readerChatSessionsRef.current.some((session) => session.id === sessionId)) return
    activeChatSessionIdRef.current = sessionId
    setActiveChatSessionId(sessionId)
    setPageLectureFilter(null)
    persistReaderChatStateNow(readerChatSessionsRef.current, sessionId)
  }, [isAsking, persistReaderChatStateNow])

  const handleNewChat = useCallback(() => {
    if (isAsking) return
    const documentId = viewerSource.kind === 'homework' ? selectedHomework?.id : knowledgeFileId
    if (!documentId) return
    const session = createReaderChatSession(documentId)
    const next = [session, ...readerChatSessionsRef.current]
    readerChatSessionsRef.current = next
    activeChatSessionIdRef.current = session.id
    setReaderChatSessions(next)
    setActiveChatSessionId(session.id)
    setQuestionInput('')
    setPageLectureFilter(null)
    persistReaderChatStateNow(next, session.id)
  }, [isAsking, knowledgeFileId, persistReaderChatStateNow, selectedHomework?.id, viewerSource.kind])

  const handleStopGeneration = useCallback(() => {
    interruptActiveRequest('user-stop')
  }, [interruptActiveRequest])

  useEffect(() => {
    let cancelled = false
    const syncConfig = () => setApiConfig(loadApiConfig())
    const syncServerConfig = async () => {
      try {
        const config = await loadApiConfigFromServer()
        if (!cancelled && config) {
          setApiConfig(config)
        }
      } catch (error) {
        console.warn('Unable to load server API configuration:', error)
      }
    }

    void syncServerConfig()
    window.addEventListener('focus', syncConfig)
    window.addEventListener('storage', syncConfig)
    return () => {
      cancelled = true
      window.removeEventListener('focus', syncConfig)
      window.removeEventListener('storage', syncConfig)
    }
  }, [])

  useEffect(() => {
    const nextConfig = ensureActiveModel(apiConfig)
    if (nextConfig) {
      setApiConfig(nextConfig)
      saveApiConfig(nextConfig)
    }
  }, [apiConfig, availableModels])

  useEffect(() => {
    if (pdfController) {
      return
    }

    setIsCaptureMode(false)
  }, [pdfController])

  useEffect(() => {
    let cancelled = false

    const loadHomeworkPreview = async () => {
      if (viewerSource.kind !== 'homework') {
        setDocumentName(lectureDocumentName)
        setDocumentText(lectureDocumentText)
        setPdfPageCount(lecturePdfPageCount)
        setPdfController(lecturePdfController)
        setHomeworkPreviewController(null)
        setHomeworkPreviewPageCount(null)
        setHomeworkPreviewImageUrl(null)
        setHomeworkPreviewLayoutBlocks([])
        return
      }

      const targetDocument =
        homeworkDocuments.find((document) => document.id === activeHomeworkDocumentId) ?? null
      if (!targetDocument?.assetId) {
        if (!cancelled) {
          setHomeworkPreviewName(targetDocument?.fileName ?? '练习预览')
          setHomeworkPreviewController(null)
          setHomeworkPreviewPageCount(null)
          setHomeworkPreviewImageUrl(null)
          setHomeworkPreviewLayoutBlocks(targetDocument?.layoutBlocks ?? [])
        }
        return
      }

      try {
        const memoryPreview = homeworkPreviewCacheRef.current.get(targetDocument.id)
        if (memoryPreview) {
          cacheHomeworkPreview(targetDocument.id, memoryPreview)
          setHomeworkPreviewName(targetDocument.fileName)
          setHomeworkPreviewController(memoryPreview.controller)
          setHomeworkPreviewImageUrl(memoryPreview.imageUrl)
          setHomeworkPreviewPageCount(memoryPreview.pageCount)
          setHomeworkPreviewLayoutBlocks(targetDocument.layoutBlocks ?? [])
          return
        }
        const payload = await loadKnowledgeHomeworkAsset(targetDocument.assetId)
        if (cancelled) {
          return
        }

        setHomeworkPreviewName(targetDocument.fileName)

        if (typeof payload === 'string') {
          cacheHomeworkPreview(targetDocument.id, {
            controller: null,
            imageUrl: payload,
            pageCount: 1,
            pageTexts: [],
          })
          setHomeworkPreviewImageUrl(payload)
          setHomeworkPreviewController(null)
          setHomeworkPreviewPageCount(1)
          setHomeworkPreviewLayoutBlocks(targetDocument.layoutBlocks ?? [])
          setCurrentPage(forcedHomeworkPreviewPage ?? 1)
          return
        }

        if (payload instanceof ArrayBuffer) {
          const cachedPreview = homeworkPreviewCacheRef.current.get(targetDocument.id)
          const extracted =
            cachedPreview?.controller || cachedPreview?.imageUrl
              ? {
                  controller: cachedPreview.controller,
                  previewUrl: cachedPreview.imageUrl,
                  pageCount: cachedPreview.pageCount ?? 1,
                  pageTexts: cachedPreview.pageTexts,
                }
              : await openPdfPreviewFromBuffer(payload)
          if (cancelled) {
            if (!cachedPreview) void disposePdfController(extracted.controller, 'homework-load-cancelled')
            return
          }

          if (!cachedPreview) {
            if (extracted.controller) {
              ownedPdfControllersRef.current.add(extracted.controller)
            }
            cacheHomeworkPreview(targetDocument.id, {
              controller: extracted.controller,
              imageUrl: extracted.previewUrl,
              pageCount: extracted.pageCount,
              pageTexts: extracted.pageTexts ?? [],
            })
          }

          setHomeworkPreviewImageUrl(null)
          setHomeworkPreviewController(extracted.controller)
          setHomeworkPreviewPageCount(extracted.pageCount)
          setHomeworkPreviewLayoutBlocks(targetDocument.layoutBlocks ?? [])
          return
        }

        setHomeworkPreviewController(null)
        setHomeworkPreviewPageCount(null)
        setHomeworkPreviewImageUrl(null)
        setHomeworkPreviewLayoutBlocks(targetDocument.layoutBlocks ?? [])
      } catch (error) {
        console.error('loadHomeworkPreview failed:', error)
        if (!cancelled) {
          setHomeworkPreviewController(null)
          setHomeworkPreviewPageCount(null)
          setHomeworkPreviewImageUrl(null)
          setHomeworkPreviewLayoutBlocks(targetDocument.layoutBlocks ?? [])
        }
      }
    }

    void loadHomeworkPreview()

    return () => {
      cancelled = true
    }
  }, [
    activeHomeworkDocumentId,
    forcedHomeworkPreviewPage,
    homeworkDocuments,
    knowledgeFileId,
    lectureDocumentName,
    lectureDocumentText,
    lecturePdfController,
    lecturePdfPageCount,
    viewerSource.kind,
  ])

  useEffect(() => {
    const container = messagesContainerRef.current
    if (!container) {
      return
    }

    const distanceToBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    const shouldStickToBottom = distanceToBottom < 120 || isAsking

    if (shouldStickToBottom) {
      container.scrollTop = container.scrollHeight
    }
  }, [chatMessages, isAsking])

  useEffect(() => {
    if (!initialFileId) {
      return
    }
    // A freshly uploaded controller is already visible; changing its route
    // must not fetch and initialize the same document a second time.
    if (initialFileId === knowledgeFileId && lecturePdfController) return

    let cancelled = false

    const restoreFile = async () => {
      try {
        await ensureKnowledgeLibraryLoaded()
        const storedFile = getKnowledgeFile(initialFileId)
        if (!storedFile) {
          return
        }

        setIsRestoringFile(true)
        setReaderVisualReady(false)

        if (cancelled) {
          return
        }

        const storedHomeworkDocuments = getKnowledgeHomeworkDocumentsByCourseFolder(
          storedFile.courseId,
          currentFolderType,
        )
        const initialHomeworkDocument =
          storedHomeworkDocuments.find((document) => document.id === initialHomeworkId) ?? null
        const initialHomeworkQuestion =
          initialHomeworkDocument?.questions.find(
            (question) => question.id === initialHomeworkQuestionId,
          ) ??
          initialHomeworkDocument?.questions[0] ??
          null

        setKnowledgeFileId(storedFile.id)
        setKnowledgeCourseId(storedFile.courseId)
        setDocumentName(storedFile.fileName)
        setDocumentText(storedFile.markdown || '')
        setPdfPageCount(storedFile.pageCount || null)
        setPdfController(null)
        setLectureDocumentName(storedFile.fileName)
        setLectureDocumentText(storedFile.markdown || '')
        setLecturePdfPageCount(
          storedFile.pageCount || null,
        )
        setLecturePdfController(null)
        setLectureLayoutBlocks(storedFile.layoutBlocks ?? [])
        setViewerSource(
          initialHomeworkDocument
            ? { kind: 'homework', documentId: initialHomeworkDocument.id }
            : { kind: 'lecture' },
        )
        setHomeworkPreviewName('练习预览')
        setHomeworkPreviewController(null)
        setHomeworkPreviewPageCount(null)
        setHomeworkPreviewImageUrl(null)
        setHomeworkDocuments(storedHomeworkDocuments)
        setClassroomSessions(storedFile.classroomSessions)
        setHomeworkFocus(
          initialHomeworkDocument
            ? {
                documentId: initialHomeworkDocument.id,
                questionId: initialHomeworkQuestion?.id ?? null,
              }
            : storedHomeworkDocuments[0]
            ? {
                documentId: storedHomeworkDocuments[0].id,
                questionId: storedHomeworkDocuments[0].questions[0]?.id ?? null,
              }
            : null,
        )
        setForcedHomeworkPreviewPage(initialHomeworkQuestion?.pageNumber ?? null)
        setCurrentPage(initialHomeworkQuestion?.pageNumber ?? initialPageNumber)
        setZoom(1)
        touchKnowledgeFile(storedFile.id)
        // Shell, name, annotations and structure are available before PDF I/O.
        const extracted = storedFile.hasPdfSource
          ? await openPdfPreviewFromUrlWithFallback(
              resolveKnowledgePdfSourceUrl(storedFile.id),
              () => loadKnowledgePdfSource(storedFile.id),
              {
                initialPage: initialPageNumber,
                pageSizes: storedFile.pageSizes,
              },
            )
          : null
        if (cancelled) {
          void disposePdfController(extracted?.controller, 'lecture-restore-cancelled')
          return
        }
        if (extracted?.controller) {
          ownedPdfControllersRef.current.add(extracted.controller)
        }
        pdfDiagnostic('controller activate', {
          controllerId: getPdfControllerId(extracted?.controller),
          documentId: storedFile.id,
          initialPage: initialPageNumber,
        })
        setPdfController(extracted?.controller ?? null)
        setLecturePdfController(extracted?.controller ?? null)
        if (extracted) {
          setPdfPageCount(extracted.pageCount)
          setLecturePdfPageCount(extracted.pageCount)
        }
      } catch (error) {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : '恢复失败'
        setChatMessages((current) => [
          ...current,
          createMessage('system', `恢复历史文件失败：${message}`),
        ])
      } finally {
        if (!cancelled) {
          setIsRestoringFile(false)
        }
      }
    }

    void restoreFile()

    return () => {
      cancelled = true
    }
  }, [
    currentFolderType,
    initialFileId,
    initialHomeworkId,
    initialHomeworkQuestionId,
    initialPageNumber,
    knowledgeFileId,
    lecturePdfController,
  ])

  useEffect(() => {
    if (initialFileId || !activeKnowledgeCourseId) {
      return
    }

    let cancelled = false

    const restoreFolder = async () => {
      try {
        await ensureKnowledgeLibraryLoaded()
        const course = getKnowledgeCourse(activeKnowledgeCourseId)
        if (!course) {
          return
        }

        const storedHomeworkDocuments = getKnowledgeHomeworkDocumentsByCourseFolder(
          course.id,
          currentFolderType,
        )
        const initialHomeworkDocument =
          storedHomeworkDocuments.find((document) => document.id === initialHomeworkId) ??
          storedHomeworkDocuments[0] ??
          null
        const initialHomeworkQuestion =
          initialHomeworkDocument?.questions.find(
            (question) => question.id === initialHomeworkQuestionId,
          ) ??
          initialHomeworkDocument?.questions.find(
            (question) => question.pageNumber === initialPageNumber,
          ) ??
          initialHomeworkDocument?.questions[0] ??
          null
        if (cancelled) {
          return
        }

        setKnowledgeFileId(null)
        setKnowledgeCourseId(course.id)
        setDocumentName(DEFAULT_DOCUMENT_NAME)
        setDocumentText('')
        setPdfPageCount(null)
        setPdfController(null)
        setLectureDocumentName(DEFAULT_DOCUMENT_NAME)
        setLectureDocumentText('')
        setLecturePdfPageCount(null)
        setLecturePdfController(null)
        setLectureLayoutBlocks([])
        setViewerSource(
          initialHomeworkDocument
            ? { kind: 'homework', documentId: initialHomeworkDocument.id }
            : { kind: 'lecture' },
        )
        setHomeworkPreviewName('练习预览')
        setHomeworkPreviewController(null)
        setHomeworkPreviewPageCount(null)
        setHomeworkPreviewImageUrl(null)
        setHomeworkPreviewLayoutBlocks([])
        setHomeworkDocuments(storedHomeworkDocuments)
        setClassroomSessions([])
        setHomeworkFocus(
          initialHomeworkDocument
            ? {
                documentId: initialHomeworkDocument.id,
                questionId: initialHomeworkQuestion?.id ?? null,
              }
            : null,
        )
        setForcedHomeworkPreviewPage(initialHomeworkQuestion?.pageNumber ?? null)
        setCurrentPage(initialHomeworkQuestion?.pageNumber ?? initialPageNumber)
        setZoom(1)
      } catch (error) {
        if (cancelled) {
          return
        }

        const message = error instanceof Error ? error.message : '恢复题目文件夹失败'
        setChatMessages((current) => [
          ...current,
          createMessage('system', `恢复题目文件夹失败：${message}`),
        ])
      }
    }

    void restoreFolder()

    return () => {
      cancelled = true
    }
  }, [
    activeKnowledgeCourseId,
    currentFolderType,
    initialFileId,
    initialHomeworkId,
    initialHomeworkQuestionId,
    initialPageNumber,
  ])

  useEffect(() => {
    const request = activeRequestRef.current
    if (!request || request.documentKey === activeReaderDocumentKey) return
    interruptActiveRequest('document-switch')
  }, [activeReaderDocumentKey, interruptActiveRequest])

  useEffect(() => {
    const documentId = activeReaderDocumentId
    if (!documentId || !activeReaderDocumentKey) {
      loadedChatDocumentKeyRef.current = null
      return
    }
    if (loadedChatDocumentKeyRef.current === activeReaderDocumentKey) return

    const storedFile = viewerSource.kind === 'lecture' && knowledgeFileId
      ? getKnowledgeFile(knowledgeFileId)
      : null
    const source = viewerSource.kind === 'homework' ? selectedHomework : storedFile
    if (!source) return
    const migrated = migrateReaderChatSessions({
      documentId,
      sessions: source.readerChatSessions,
      activeSessionId: source.activeChatSessionId,
      annotations: source.annotations,
      legacyMessages: viewerSource.kind === 'lecture' ? storedFile?.chatMessages ?? [] : [],
    })
    loadedChatDocumentKeyRef.current = activeReaderDocumentKey
    readerChatSessionsRef.current = migrated.sessions
    activeChatSessionIdRef.current = migrated.activeSessionId
    setReaderChatSessions(migrated.sessions)
    setActiveChatSessionId(migrated.activeSessionId)
  }, [activeReaderDocumentId, activeReaderDocumentKey, knowledgeFileId, selectedHomework, viewerSource.kind])

  useEffect(() => {
    if (
      !activeReaderDocumentKey ||
      loadedChatDocumentKeyRef.current !== activeReaderDocumentKey ||
      readerChatSessionsRef.current !== readerChatSessions ||
      activeChatSessionIdRef.current !== activeChatSessionId
    ) return

    if (saveChatTimerRef.current !== null) {
      clearTimeout(saveChatTimerRef.current)
    }

    saveChatTimerRef.current = setTimeout(() => {
      try {
        persistReaderChatStateNow(readerChatSessions, activeChatSessionId)
      } catch (error) {
        console.error('saveReaderChatState failed:', error)
      } finally {
        saveChatTimerRef.current = null
      }
    }, 400)

    return () => {
      if (saveChatTimerRef.current !== null) {
        clearTimeout(saveChatTimerRef.current)
        saveChatTimerRef.current = null
      }
    }
  }, [activeChatSessionId, activeReaderDocumentKey, persistReaderChatStateNow, readerChatSessions])

  useEffect(() => {
    if (!knowledgeFileId || classroomSessions.length || !documentText.trim()) {
      return
    }

    let cancelled = false

    const tryHydrateDebugSession = async () => {
      try {
        const debugPayload = await loadLatestDebugClassroomSession()
        if (cancelled || !debugPayload.session.segments.length) {
          return
        }

        const currentText = documentText.replace(/\s+/g, ' ').trim()
        const debugText = debugPayload.lectureMarkdown.replace(/\s+/g, ' ').trim()
        if (!currentText || !debugText) {
          return
        }

        const sameDocument =
          currentText.slice(0, 4000) === debugText.slice(0, 4000) ||
          currentText.includes(debugText.slice(0, 1200)) ||
          debugText.includes(currentText.slice(0, 1200))

        if (!sameDocument) {
          return
        }

        const storedSession = saveKnowledgeClassroomSession(knowledgeFileId, debugPayload.session)
        if (cancelled) {
          return
        }

        setClassroomSessions((current) => {
          if (current.some((session) => session.id === storedSession.id)) {
            return current
          }
          return [storedSession, ...current]
        })
        setChatMessages((current) => {
          if (
            current.some(
              (message) =>
                message.role === 'system' &&
                message.content.includes('已导入调试课堂讲解映射结果'),
            )
          ) {
            return current
          }
          return [
            ...current,
            createMessage('system', '已导入调试课堂讲解映射结果，你现在可以点击“查看课堂讲解”查看。'),
          ]
        })
      } catch {
        return
      }
    }

    void tryHydrateDebugSession()

    return () => {
      cancelled = true
    }
  }, [classroomSessions.length, documentText, knowledgeFileId])

  useEffect(() => {
    if (!knowledgeFileId) {
      return
    }

    if (!mineruHydrationAllowed) return
    const storedFile = getKnowledgeFile(knowledgeFileId)
    if (!storedFile?.hasPdfSource) {
      return
    }
    let cancelled = false

    const hasStructuredLecture =
      Boolean(storedFile.markdown.trim()) && storedFile.layoutBlocks.length > 0
    if (hasStructuredLecture && storedFile.pipelineStatus === 'completed') {
      const needsCoordinateUpgrade = !storedFile.layoutBlocks.some(
        (block) => block.coordinateSpace === 'pdf-page',
      )
      if (needsCoordinateUpgrade) {
        void getLectureDocumentProcessingStatus(storedFile.id)
          .then(async (payload) => {
            const layoutBlocks = Array.isArray(payload.layout_blocks)
              ? payload.layout_blocks as typeof storedFile.layoutBlocks
              : storedFile.layoutBlocks
            const refreshedFile = await upsertKnowledgeFile({
              fileId: storedFile.id,
              sourceKey: storedFile.sourceKey,
              fileName: storedFile.fileName,
              pageCount: Number(payload.page_count || storedFile.pageCount),
              byteSize: storedFile.byteSize,
              markdown: String(payload.markdown || storedFile.markdown),
              layoutBlocks,
              courseId: storedFile.courseId,
            })
            if (!cancelled) {
              setLectureLayoutBlocks(refreshedFile.layoutBlocks)
            }
          })
          .catch((error) => console.warn('layout coordinate upgrade failed:', error))
      }
      lectureMineruFailedRef.current.delete(storedFile.id)
      return () => {
        cancelled = true
      }
    }

    if (storedFile.libraryFolder === 'other') {
      return
    }

    if (storedFile.pipelineStatus?.endsWith('_failed')) {
      return
    }

    if (
      lectureMineruInFlightRef.current.has(storedFile.id) ||
      lectureMineruFailedRef.current.has(storedFile.id)
    ) {
      return
    }

    lectureMineruInFlightRef.current.add(storedFile.id)

    setChatMessages((current) => {
      if (
        current.some((message) =>
          message.content.includes('正在后台用 MinerU 补全讲义结构'),
        )
      ) {
        return current
      }

      return [
        ...current,
        createMessage(
          'system',
          `已打开 ${storedFile.fileName}，正在后台用 MinerU 补全讲义结构。`,
        ),
      ]
    })

    const hydrateLectureStructure = async () => {
      try {
        const persistPipelineStatus = async (payload: DocumentPipelineStatus) => {
          const isComplete = payload.status === 'completed'
          const layoutBlocks = isComplete && Array.isArray(payload.layout_blocks)
            ? payload.layout_blocks as StructuredDocumentBlock[]
            : storedFile.layoutBlocks
          return upsertKnowledgeFile({
            fileId: storedFile.id,
            sourceKey: storedFile.sourceKey,
            fileName: storedFile.fileName,
            pageCount: Number(payload.page_count || storedFile.pageCount),
            byteSize: storedFile.byteSize,
            markdown: isComplete ? String(payload.markdown || storedFile.markdown) : storedFile.markdown,
            layoutBlocks,
            courseId: storedFile.courseId,
            pipelineStatus: payload.status,
            mineruStatus: payload.mineru_status,
            embeddingStatus: payload.embedding_status,
            vectorStatus: payload.vector_status,
            pipelineError: payload.error || null,
            chunkCount: Number(payload.chunk_count || 0) || null,
            indexedChunkCount: Number(payload.vector_completed_chunks || payload.embedding_completed_chunks || 0) || null,
          })
        }

        const hydrateCompletedLecture = (refreshedFile: Awaited<ReturnType<typeof persistPipelineStatus>>) => {
          const canonicalMarkdown = refreshedFile.markdown.trim()
          if (!canonicalMarkdown) {
            throw new Error('MinerU 未返回可用的讲义 Markdown。')
          }
          lectureMineruFailedRef.current.delete(storedFile.id)
          startTransition(() => {
            setDocumentText(canonicalMarkdown)
            setLectureDocumentText(canonicalMarkdown)
            setLectureLayoutBlocks(refreshedFile.layoutBlocks)
            setHomeworkDocuments(refreshedFile.homeworkDocuments)
            setClassroomSessions(refreshedFile.classroomSessions)
            setChatMessages((current) => current.some((message) =>
              message.content.includes('讲义结构补全完成，现在可以按区块引用和提问了。'),
            ) ? current : [
              ...current,
              createMessage('assistant', `${storedFile.fileName} 的讲义结构补全完成，现在可以按区块引用和提问了。`),
            ])
          })
        }

        let status: DocumentPipelineStatus | null = null
        if (storedFile.pipelineStatus) {
          try {
            status = await getLectureDocumentProcessingStatus(storedFile.id)
          } catch {
            // A legacy local record may not have a server-side job yet. Re-submit
            // its saved PDF below so opening the document repairs that gap.
            status = null
          }
        }

        if (!status) {
          const pdfBuffer = await loadKnowledgePdfSource(storedFile.id)
          if (!pdfBuffer) {
            throw new Error('未找到可用于补全讲义结构的 PDF 源文件。')
          }
          const pdfFile = new File([pdfBuffer], storedFile.fileName, { type: 'application/pdf' })
          status = await submitLectureDocumentForProcessing(pdfFile, storedFile.courseId, storedFile.id)
        }

        let refreshedFile = await persistPipelineStatus(status)
        if (status.status === 'completed') {
          if (!cancelled) hydrateCompletedLecture(refreshedFile)
          return
        }

        // Submission returns immediately. Keep PDF reading responsive while this
        // observer hydrates the structured content once the background task ends.
        while (!cancelled && !status.status.endsWith('_failed') && status.status !== 'completed') {
          await new Promise((resolve) => window.setTimeout(resolve, 2000))
          status = await getLectureDocumentProcessingStatus(storedFile.id)
          refreshedFile = await persistPipelineStatus(status)
        }
        if (cancelled) return
        if (status.status === 'completed') {
          hydrateCompletedLecture(refreshedFile)
          return
        }
        throw new Error(status.error || 'MinerU 处理失败')
      } catch (error) {
        if (cancelled) {
          return
        }

        lectureMineruFailedRef.current.add(storedFile.id)
        const message = error instanceof Error ? error.message : 'MinerU 处理失败'
        await upsertKnowledgeFile({
          fileId: storedFile.id,
          sourceKey: storedFile.sourceKey,
          fileName: storedFile.fileName,
          pageCount: storedFile.pageCount,
          byteSize: storedFile.byteSize,
          markdown: storedFile.markdown,
          layoutBlocks: storedFile.layoutBlocks,
          courseId: storedFile.courseId,
          pipelineStatus: 'mineru_failed',
          mineruStatus: 'failed',
          embeddingStatus: storedFile.embeddingStatus ?? 'pending',
          vectorStatus: storedFile.vectorStatus ?? 'pending',
          pipelineError: message,
        })
        setChatMessages((current) => [
          ...current,
          createMessage(
            'system',
            `MinerU 结构提取失败：${message}。当前仍可预览 PDF，但暂时不能按公式/图片区块引用。`,
          ),
        ])
      } finally {
        lectureMineruInFlightRef.current.delete(storedFile.id)
      }
    }

    void hydrateLectureStructure()

    return () => {
      cancelled = true
    }
  }, [knowledgeFileId, mineruHydrationAllowed])

  useEffect(() => {
    if (!knowledgeFileId || !activeKnowledgeCourseId) {
      return
    }
    let cancelled = false
    let pollTimer: number | null = null

    const refreshMappedRecordings = async (forcePoll = false) => {
      try {
        const result = await loadCourseLectureRecordings(
          activeKnowledgeCourseId,
          knowledgeFileId,
        )
        if (cancelled) return
        if (result.sessions.length) {
          const storedSessions = result.sessions.map((session) =>
            saveKnowledgeClassroomSession(knowledgeFileId, session),
          )
          setClassroomSessions((current) => {
            const importedIds = new Set(storedSessions.map((session) => session.id))
            return [
              ...storedSessions,
              ...current.filter((session) => !importedIds.has(session.id)),
            ]
          })
        }
        if (result.failed) {
          setChatMessages((current) => current.some((message) =>
            message.content.includes('课堂录音已转写，但自动页码映射失败'),
          ) ? current : [
            ...current,
            createMessage(
              'system',
              '课堂录音已转写，但自动页码映射失败。录音和 ASR 结果仍已保留，可稍后重试。',
            ),
          ])
        }
        if (result.waiting || forcePoll) {
          emitLessonProcessingState('课堂录音等待映射')
          pollTimer = window.setTimeout(() => refreshMappedRecordings(), 2500)
        } else if (result.sessions.length) {
          emitLessonProcessingState('课堂映射已完成')
          window.setTimeout(() => emitLessonProcessingState(''), 1800)
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Pending classroom recording refresh failed:', error)
        }
      }
    }

    const queueAndRefreshMappedRecordings = async () => {
      let queued = false
      try {
        await queuePendingCourseLectureRecordings(activeKnowledgeCourseId, knowledgeFileId)
        queued = true
      } catch (error) {
        if (!cancelled) {
          console.warn('Pending classroom recording queue failed:', error)
        }
      }
      if (!cancelled) {
        await refreshMappedRecordings(queued)
      }
    }

    void queueAndRefreshMappedRecordings()
    return () => {
      cancelled = true
      if (pollTimer !== null) window.clearTimeout(pollTimer)
    }
  }, [activeKnowledgeCourseId, knowledgeFileId])

  const handlePdfChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    let previewPublished = false
    try {
      interruptActiveRequest('document-upload')
      const buffer = await file.arrayBuffer()
      const result = { ...await openPdfPreviewFromBuffer(buffer), buffer }
      ownedPdfControllersRef.current.add(result.controller)
      const initialChatMessages = [
        createMessage(
          'assistant',
          `已载入 ${file.name}。PDF 预览已打开，正在后台用 MinerU 提取讲义结构。`,
        ),
      ]
      const pendingSession = {
        ...createReaderChatSession(`pending-upload-${crypto.randomUUID()}`),
        messages: initialChatMessages,
      }
      loadedChatDocumentKeyRef.current = null
      readerChatSessionsRef.current = [pendingSession]
      activeChatSessionIdRef.current = pendingSession.id
      setReaderChatSessions([pendingSession])
      setActiveChatSessionId(pendingSession.id)
      // Publish the reader before persistence or MinerU. Failed persistence
      // leaves the local document readable and reports an explicit save error.
      setReaderVisualReady(false)
      setKnowledgeFileId(null)
      setDocumentName(file.name)
      setDocumentText('')
      setPdfPageCount(result.pageCount)
      setPdfController(result.controller)
      setLectureDocumentName(file.name)
      setLectureDocumentText('')
      setLecturePdfPageCount(result.pageCount)
      setLecturePdfController(result.controller)
      setLectureLayoutBlocks([])
      setViewerSource({ kind: 'lecture' })
      setClassroomSessions([])
      setCurrentPage(1)
      setZoom(1)
      previewPublished = true
      const storedFile = await upsertKnowledgeFile({
        fileName: file.name,
        pageCount: result.pageCount,
        pageSizes: result.controller.pageSizes,
        byteSize: result.buffer.byteLength,
        markdown: '',
        layoutBlocks: [],
        pdfBuffer: result.buffer,
        courseId: currentCourseId,
      })
      const migrated = migrateReaderChatSessions({
        documentId: storedFile.id,
        sessions: storedFile.readerChatSessions,
        activeSessionId: storedFile.activeChatSessionId,
        annotations: storedFile.annotations,
        legacyMessages: storedFile.chatMessages,
      })
      const hasStoredConversation = migrated.sessions.some((session) => session.messages.length > 0)
      const nextSessions = hasStoredConversation
        ? migrated.sessions
        : migrated.sessions.map((session) => session.id === migrated.activeSessionId
            ? { ...session, messages: initialChatMessages, updatedAt: new Date().toISOString() }
            : session)
      saveKnowledgeReaderChatState(storedFile.id, nextSessions, migrated.activeSessionId)
      loadedChatDocumentKeyRef.current = `lecture:${storedFile.id}`
      readerChatSessionsRef.current = nextSessions
      activeChatSessionIdRef.current = migrated.activeSessionId

      startTransition(() => {
        setKnowledgeFileId(storedFile.id)
        setReaderChatSessions(nextSessions)
        setActiveChatSessionId(migrated.activeSessionId)
        try {
          setSearchParams(
            { file: storedFile.id, course: storedFile.courseId, folder: currentFolderType },
            { replace: true },
          )
        } catch (error) {
          console.error('setSearchParams failed:', error)
        }
        setDocumentName(file.name)
        setDocumentText('')
        setPdfPageCount(result.pageCount)
        setPdfController(result.controller)
        setLectureDocumentName(file.name)
        setLectureDocumentText('')
        setLecturePdfPageCount(result.pageCount)
        setLecturePdfController(result.controller)
        setLectureLayoutBlocks([])
        setViewerSource({ kind: 'lecture' })
        setHomeworkPreviewName('练习预览')
        setHomeworkPreviewController(null)
        setHomeworkPreviewPageCount(null)
        setHomeworkPreviewImageUrl(null)
        setHomeworkPreviewLayoutBlocks([])
        setKnowledgeCourseId(storedFile.courseId)
        setCurrentPage(1)
        setZoom(1)
        setHomeworkDocuments(
          getKnowledgeHomeworkDocumentsByCourseFolder(storedFile.courseId, currentFolderType),
        )
        setClassroomSessions(storedFile.classroomSessions)
        setHomeworkFocus(
          getKnowledgeHomeworkDocumentsByCourseFolder(storedFile.courseId, currentFolderType)[0]
            ? {
                documentId: getKnowledgeHomeworkDocumentsByCourseFolder(
                  storedFile.courseId,
                  currentFolderType,
                )[0].id,
                questionId:
                  getKnowledgeHomeworkDocumentsByCourseFolder(
                    storedFile.courseId,
                    currentFolderType,
                  )[0].questions[0]?.id ?? null,
              }
            : null,
        )
      })

    } catch (error) {
      const message = error instanceof Error ? error.message : '解析失败'
      setChatMessages((current) => [
        ...current,
        createMessage(
          'system',
          previewPublished
            ? `PDF 保存失败，本地预览仍可继续阅读：${message}`
            : `PDF 打开失败：${message}`,
        ),
      ])
    } finally {
      event.target.value = ''
    }
  }

  const handleInspectPageDoubts = (pageNumber: number) => {
    setCurrentPage(pageNumber)
    setPageLectureFilter(null)
    setIsCaptureMode(false)
  }

  const handleInspectPageQuestions = (pageNumber: number) => {
    setCurrentPage(pageNumber)
    setPageLectureFilter(null)
    setIsCaptureMode(false)
  }

  const handleInspectPageLectureSegments = (pageNumber: number) => {
    setCurrentPage(pageNumber)
    setPageLectureFilter(pageNumber)
    setIsCaptureMode(false)
  }

  const handlePlayPageLectureSegments = (pageNumber: number) => {
    pageLecturePlayback.playPageSegments(
      pageNumber,
      lectureSegmentsByPage.get(pageNumber) ?? [],
      activeKnowledgeCourseId,
    )
  }

  const persistLessonTranscript = useCallback(
    async (
      transcript:
        | string
        | AsrTranscriptionResult,
      sourceLabel: string,
      config: ApiConfig,
      targetDocumentId = knowledgeFileId,
    ) => {
      const transcriptText = typeof transcript === 'string' ? transcript : transcript.text
      if (!transcriptText.trim() || !targetDocumentId) {
        return
      }

      emitLessonProcessingState('课堂整理/映射中')
      const session =
        typeof transcript !== 'string' && transcript.recording && activeKnowledgeCourseId
          ? await buildClassroomSessionFromSequentialAlignment(
              transcript,
              activeKnowledgeCourseId,
              targetDocumentId,
            )
          : await buildClassroomSessionWithApi(transcript, documentText, config)
      const mappedPageCount = new Set(
        session.segments.flatMap((segment) => segment.pageNumbers ?? []),
      ).size
      if (!session.segments.length || mappedPageCount === 0) {
        throw new Error('课堂映射未得到任何有效讲义页，请检查转写内容或模型输出。')
      }
      const storedSession = saveKnowledgeClassroomSession(targetDocumentId, session)
      setClassroomSessions((current) => [
        storedSession,
        ...current.filter((item) => item.id !== storedSession.id),
      ])
      setChatMessages((current) => [
        ...current,
        createMessage('system', `${sourceLabel}已整理完成，相关讲解已经映射到讲义页。`),
      ])
    },
    [activeKnowledgeCourseId, documentText, knowledgeFileId],
  )

  const processLessonAudio = useCallback(
    async (
      audioBlob: Blob,
      sourceLabel: string,
      storedContext?: { courseId: string | null; documentId: string | null },
    ) => {
      const currentCourseId = activeKnowledgeCourseIdRef.current
      const targetCourseId = storedContext?.courseId?.trim() || currentCourseId
      const targetDocumentId = storedContext?.documentId
        || (targetCourseId === currentCourseId ? knowledgeFileIdRef.current : null)
      if (!audioBlob.size) {
        return
      }

      setIsProcessingLesson(true)
      let recordingPersisted = false
      try {
        const config = loadApiConfig()
        emitLessonProcessingState('ASR 转写中')
        const transcript = await transcribeAudioWithConfiguredAsr(
          audioBlob,
          config,
          targetCourseId
            ? { courseId: targetCourseId, documentId: targetDocumentId }
            : undefined,
        )
        recordingPersisted = Boolean(transcript.recording)
        const targetDocument = targetDocumentId ? getKnowledgeFile(targetDocumentId) : null
        if (targetCourseId && targetDocumentId && targetDocument?.pipelineStatus === 'completed') {
          await persistLessonTranscript(transcript, sourceLabel, config, targetDocumentId)
          emitLessonProcessingState('已完成')
        } else {
          setChatMessages((current) => [
            ...current,
            createMessage(
              'system',
              targetDocumentId
                ? `${sourceLabel}已完成 ASR 转写并保存。讲义处理完成后，后台会自动继续页码映射。`
                : targetCourseId
                  ? `${sourceLabel}已完成 ASR 转写并保存。上传本课程讲义后，后台会自动继续页码映射。`
                  : `${sourceLabel}已完成 ASR 转写并暂存。进入课程或上传讲义后，后台会自动绑定并继续页码映射。`,
            ),
          ])
          emitLessonProcessingState(targetCourseId ? '等待上传讲义' : '等待选择课程或上传讲义')
        }
        void refreshLessonRecordings()
        return true
      } catch (error) {
        const message = error instanceof Error ? error.message : `${sourceLabel}处理失败`
        setChatMessages((current) => [
          ...current,
          createMessage('system', `${sourceLabel}处理失败：${message}`),
        ])
        emitLessonProcessingState('处理失败')
        if (recordingPersisted) void refreshLessonRecordings()
        return recordingPersisted
      } finally {
        setIsProcessingLesson(false)
        window.setTimeout(() => emitLessonProcessingState(''), 1800)
      }
    },
    [persistLessonTranscript, refreshLessonRecordings],
  )

  const handleLessonAudioUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      event.target.value = ''
      return
    }

    setChatMessages((current) => [
      ...current,
      createMessage(
        'system',
        knowledgeFileId
          ? `已上传录音文件《${file.name}》，正在进行转写与课堂映射。`
          : activeKnowledgeCourseId
            ? `已上传录音文件《${file.name}》，正在转写；上传讲义后会自动继续映射。`
            : `已上传录音文件《${file.name}》，正在转写；进入课程或上传讲义后会自动绑定并继续映射。`,
      ),
    ])

    try {
      await processLessonAudio(file, `上传录音《${file.name}》`)
    } finally {
      event.target.value = ''
    }
  }

  const handleLessonTranscriptUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      event.target.value = ''
      return
    }

    const lowerName = file.name.toLowerCase()
    if (!(lowerName.endsWith('.md') || lowerName.endsWith('.markdown') || lowerName.endsWith('.txt'))) {
      setChatMessages((current) => [
        ...current,
        createMessage('system', '上传原文仅支持 .md / .markdown / .txt 文件。'),
      ])
      event.target.value = ''
      return
    }

    if (!knowledgeFileId) {
      setChatMessages((current) => [
        ...current,
        createMessage('system', '请先打开一份讲义 PDF，再上传原文。'),
      ])
      event.target.value = ''
      return
    }

    setChatMessages((current) => [
      ...current,
      createMessage('system', `已上传原文《${file.name}》，正在直接进行课堂映射。`),
    ])

    setIsProcessingLesson(true)
    try {
      const transcript = (await file.text()).trim()
      if (!transcript) {
        throw new Error('原文文件内容为空。')
      }
      const config = loadApiConfig()
      await persistLessonTranscript(transcript, `上传原文《${file.name}》`, config)
      emitLessonProcessingState('已完成')
    } catch (error) {
      const message = error instanceof Error ? error.message : '上传原文处理失败'
      setChatMessages((current) => [
        ...current,
        createMessage('system', `上传原文处理失败：${message}`),
      ])
      emitLessonProcessingState('处理失败')
    } finally {
      setIsProcessingLesson(false)
      event.target.value = ''
      window.setTimeout(() => emitLessonProcessingState(''), 1800)
    }
  }

  const handleModelChange = (model: string) => {
    const nextConfig = {
      ...apiConfig,
      doubtModel: model,
    }
    setApiConfig(nextConfig)
    saveApiConfig(nextConfig)
  }

  const handleOpenKnowledgeLink = (linkId: string) => {
    const link = allHomeworkKnowledgeLinks.find((entry) => entry.id === linkId)
    if (!link) {
      return
    }

    setHomeworkFocus({
      documentId: link.homeworkDocumentId,
      questionId: link.questionId,
    })
    setViewerSource({ kind: 'homework', documentId: link.homeworkDocumentId })
    setForcedHomeworkPreviewPage(null)
  }

  const handleOpenLecturePageQuestions = (pageNumber: number) => {
    const pageLinks = lecturePageQuestionLinks.get(pageNumber) ?? []
    const firstLink = pageLinks[0]

    setCurrentPage(pageNumber)
    if (!firstLink) {
      return
    }

    setHomeworkFocus({
      documentId: firstLink.homeworkDocumentId,
      questionId: firstLink.questionId,
    })
  }

  const handleHomeworkUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
  const file = event.target.files?.[0]
    if (!file || !activeKnowledgeCourseId) {
      event.target.value = ''
      return
    }

    if (!getMineruUploadKind(file)) {
      setChatMessages((current) => [
        ...current,
        createMessage('system', getMineruUploadError(file)),
      ])
      event.target.value = ''
      return
    }

    setIsExtractingHomework(true)
    const pendingDocument = buildPendingHomeworkDocument(file)

    try {
      const assetPayload = await readHomeworkAssetPayload(file)
      await addKnowledgeHomeworkDocument(
        activeKnowledgeCourseId,
        currentFolderType,
        pendingDocument,
        assetPayload,
      )
      setHomeworkDocuments((current) => [pendingDocument, ...current])
      setHomeworkFocus({
        documentId: pendingDocument.id,
        questionId: null,
      })

      const extraction = await processHomeworkDocumentWithPipeline(
        file,
        activeKnowledgeCourseId,
        currentFolderType,
        pendingDocument.id,
      )
      const readyDocument = {
        ...pendingDocument,
        pageCount: extraction.pageCount,
        status: 'ready' as const,
        extractedMarkdown: extraction.markdown,
        layoutBlocks: extraction.layoutBlocks,
        questions: extraction.questions,
        knowledgeLinks: [],
        errorMessage: null,
        updatedAt: new Date().toISOString(),
      }

      setHomeworkDocuments((current) => {
        const nextDocuments = current.map((document) =>
          document.id === readyDocument.id ? readyDocument : document,
        )
        saveKnowledgeHomeworkDocuments(activeKnowledgeCourseId, currentFolderType, nextDocuments)
        return nextDocuments
      })
      setHomeworkFocus({
        documentId: readyDocument.id,
        questionId: readyDocument.questions[0]?.id ?? null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '练习提取失败'
      const failedDocument = buildFailedHomeworkDocument(pendingDocument, message)
      setHomeworkDocuments((current) => {
        const existing = current.some((document) => document.id === failedDocument.id)
        const nextDocuments = existing
          ? current.map((document) => (document.id === failedDocument.id ? failedDocument : document))
          : [failedDocument, ...current]
        saveKnowledgeHomeworkDocuments(activeKnowledgeCourseId, currentFolderType, nextDocuments)
        return nextDocuments
      })
      setHomeworkFocus({
        documentId: failedDocument.id,
        questionId: null,
      })
      setChatMessages((current) => [
        ...current,
        createMessage('system', `练习提取失败：${message}`),
      ])
    } finally {
      setIsExtractingHomework(false)
      event.target.value = ''
    }
  }

  const appendAttachments = async (files: File[]) => {
    const nextAttachments: ComposerAttachment[] = []

    for (const file of files) {
      const lowerName = file.name.toLowerCase()

      if (file.type.startsWith('image/')) {
        nextAttachments.push({
          id: crypto.randomUUID(),
          kind: 'image',
          name: file.name,
          dataUrl: await readFileAsDataUrl(file),
        })
        continue
      }

      if (file.type === 'application/pdf' || lowerName.endsWith('.pdf')) {
        const extracted = await extractPdfPreview(file)
        nextAttachments.push({
          id: crypto.randomUUID(),
          kind: 'document',
          name: file.name,
          contentText: extracted.markdown.slice(0, 16000),
        })
        continue
      }

      if (
        file.type.startsWith('text/') ||
        lowerName.endsWith('.md') ||
        lowerName.endsWith('.markdown') ||
        lowerName.endsWith('.txt') ||
        lowerName.endsWith('.json')
      ) {
        nextAttachments.push({
          id: crypto.randomUUID(),
          kind: 'document',
          name: file.name,
          contentText: (await file.text()).slice(0, 16000),
        })
        continue
      }

      setChatMessages((current) => [
        ...current,
        createMessage('system', `暂不支持上传文件：${file.name}`),
      ])
    }

    if (nextAttachments.length) {
      setComposerAttachments((current) => [...current, ...nextAttachments])
    }
  }

  const handleChatUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (!files.length) {
      return
    }

    try {
      await appendAttachments(files)
    } catch (error) {
      const message = error instanceof Error ? error.message : '附件处理失败'
      setChatMessages((current) => [
        ...current,
        createMessage('system', `附件处理失败：${message}`),
      ])
    } finally {
      event.target.value = ''
    }
  }

  const handleToggleCaptureMode = () => {
    if (!currentViewerController) {
      setChatMessages((current) => [
        ...current,
        createMessage('system', 'Please open a PDF before starting a capture.'),
      ])
      return
    }

    setIsCaptureMode((current) => !current)
  }

  const handleCaptureSelection = (capture: {
    pageNumber: number
    dataUrl: string
    width: number
    height: number
  }) => {
    setComposerAttachments((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        kind: 'image',
        name: `page-${capture.pageNumber}-capture-${Date.now()}.png`,
        dataUrl: capture.dataUrl,
      },
    ])
    setIsCaptureMode(false)
  }

  const handleTextSelection = (selection: {
    pageNumber: number
    text: string
    source?: 'block' | 'selection'
    label?: string
    kind?: StructuredDocumentBlock['kind']
    blockId?: string
    blockSource?: StructuredDocumentBlock['source']
    blocks?: Array<{
      id: string
      text: string
      label?: string
      kind?: StructuredDocumentBlock['kind']
      source?: StructuredDocumentBlock['source']
    }>
  }) => {
    const referenceDocumentId = viewerSource.kind === 'homework'
      ? selectedHomework?.id ?? viewerSource.documentId
      : knowledgeFileId
    if (!referenceDocumentId) return
    const sourceType: ChatReference['sourceType'] =
      viewerSource.kind === 'lecture' ? 'lecture' : currentFolderType
    const selectedBlocks = selection.source === 'block'
      ? selection.blocks?.length
        ? selection.blocks
        : selection.blockId
          ? [{
              id: selection.blockId,
              text: selection.text,
              label: selection.label,
              kind: selection.kind,
              source: selection.blockSource,
            }]
          : []
      : []
    const referenceBlocks = selectedBlocks
      .map((block) => ({
        ...block,
        text: block.text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() ||
          `[${block.kind || '区块'}：${block.label || 'MinerU 已识别的非文本内容'}]`,
      }))

    if (selection.source !== 'block') {
      const text = selection.text.replace(/\s+/g, ' ').trim()
      if (text.length < 2) return
      setComposerAttachments((current) => [...current, {
        id: crypto.randomUUID(),
        kind: 'text',
        name: `第${selection.pageNumber}页文字引用`,
        contentText: `PDF《${currentViewerName}》第 ${selection.pageNumber} 页原文：\n${text}`,
        blockReference: {
          id: `reference-${referenceDocumentId}-${selection.pageNumber}-${crypto.randomUUID()}`,
          sourceType,
          documentId: referenceDocumentId,
          documentName: currentViewerName,
          pageNumber: selection.pageNumber,
          blockId: null,
          label: '文字选择',
          excerpt: text,
          viewer: viewerSource.kind,
        },
      }])
      return
    }

    if (!referenceBlocks.length) return
    setComposerAttachments((current) => {
      const existingIds = new Set(
        current
          .map((attachment) => attachment.blockReference)
          .filter((reference): reference is NonNullable<ComposerAttachment['blockReference']> => Boolean(reference))
          .filter((reference) =>
            reference.viewer === viewerSource.kind &&
            reference.documentId === referenceDocumentId,
          )
          .map((reference) => reference.blockId),
      )
      const additions = referenceBlocks
        .filter((block) => !existingIds.has(block.id))
        .map((block) => ({
          id: crypto.randomUUID(),
          kind: 'text' as const,
          name: `第${selection.pageNumber}页引用`,
          contentText: `PDF《${currentViewerName}》第 ${selection.pageNumber} 页${block.label || block.kind || '区块'}（${block.source === 'mineru-local' ? '本地 MinerU 解析块' : 'PDF 文字选择'}）：\n${block.text}`,
          blockReference: {
            id: `reference-${referenceDocumentId}-${block.id}`,
            sourceType,
            documentId: referenceDocumentId,
            documentName: currentViewerName,
            blockId: block.id,
            pageNumber: selection.pageNumber,
            label: block.label || block.kind || '区块',
            kind: block.kind,
            excerpt: block.text,
            viewer: viewerSource.kind,
          },
        }))
      return additions.length ? [...current, ...additions] : current
    })
  }

  const handleCaptureFromClipboard = async () => {
    handleToggleCaptureMode()
    return
    /*

    try {
      if (!navigator.clipboard?.read) {
        throw new Error('当前浏览器不支持读取剪贴板图片')
      }

      const clipboardItems = await navigator.clipboard.read()
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith('image/'))
        if (!imageType) {
          continue
        }

        const blob = await item.getType(imageType)
        const extension = imageType.split('/')[1] || 'png'
        const dataUrl = await readFileAsDataUrl(blob)
        setComposerAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            kind: 'image',
            name: `screenshot-${Date.now()}.${extension}`,
            dataUrl,
          },
        ])
        return
      }

      throw new Error('剪贴板里没有可用图片')
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取截图失败'
      setChatMessages((current) => [
        ...current,
        createMessage('system', `截图失败：${message}`),
      ])
    }
    */
  }

  const removeComposerAttachment = (attachmentId: string) => {
    setComposerAttachments((current) =>
      current.filter((attachment) => attachment.id !== attachmentId),
    )
  }

  const removeBlockReference = (blockId: string) => {
    setComposerAttachments((current) => current.filter((attachment) => {
      const reference = attachment.blockReference
      if (!reference || reference.blockId !== blockId || reference.viewer !== viewerSource.kind) {
        return true
      }
      return viewerSource.kind === 'homework' && reference.documentId !== viewerSource.documentId
    }))
  }

  const handleZoom = (nextZoom: number) => {
    setZoom(Math.min(2.5, Math.max(0.75, nextZoom)))
  }

  const handleVisiblePageChange = (pageNumber: number) => {
    setCurrentPage((current) => (current === pageNumber ? current : pageNumber))
  }

  const handleVisibleHomeworkQuestionChange = (questionId: string) => {
    if (viewerSource.kind !== 'homework' || !selectedHomework || questionId === homeworkFocus?.questionId) {
      return
    }
    const question = selectedHomework.questions.find((item) => item.id === questionId)
    if (!question) {
      return
    }
    setHomeworkFocus({
      documentId: selectedHomework.id,
      questionId,
    })
  }

  const handleOpenRelatedMaterial = (card: RelatedMaterialCard) => {
    const courseId = activeKnowledgeCourseId
    if (!courseId || !card.documentId) {
      return
    }

    if (card.kind === 'lecture') {
      if (!getKnowledgeFile(card.documentId)) {
        console.warn('Related lecture no longer exists in the course library:', card.documentId)
        removeRelatedMaterial(card.id)
        return
      }
      setSearchParams(
        {
          file: card.documentId,
          course: courseId,
          page: String(card.pageNumber ?? 1),
        },
        { replace: false },
      )
      return
    }


    const targetFolder = card.documentType === 'past-exam' ? 'past-exam' : 'homework'
    const targetExists = getKnowledgeHomeworkDocumentsByCourseFolder(courseId, targetFolder).some(
      (document) => document.id === card.documentId,
    )
    if (!targetExists) {
      console.warn('Related question document no longer exists in the course library:', card.documentId)
      removeRelatedMaterial(card.id)
      return
    }

    setSearchParams(
      {
        course: courseId,
        folder: targetFolder,
        homework: card.documentId,
        ...(card.questionId ? { question: card.questionId } : {}),
        page: String(card.pageNumber ?? 1),
      },
      { replace: false },
    )
  }

  const handlePrevPage = () => {
    setCurrentPage((page) => Math.max(1, page - 1))
  }

  const handleNextPage = () => {
    setCurrentPage((page) => Math.min(currentViewerPageCount ?? page, page + 1))
  }

  const runQuestion = async () => {
    const normalizedQuestion = questionInput.trim()
    const hasQuestionContext = Boolean(
      documentText.trim() ||
      selectedHomework?.extractedMarkdown.trim() ||
      currentViewerStructuredBlocks.length,
    )
    const documentId = viewerSource.kind === 'homework' ? selectedHomework?.id : knowledgeFileId
    const sessionId = activeChatSessionIdRef.current
    const baseChatSession = readerChatSessionsRef.current.find((session) => session.id === sessionId)
    if (
      !normalizedQuestion ||
      isAsking ||
      activeRequestRef.current ||
      !hasQuestionContext ||
      !documentId ||
      !baseChatSession
    ) {
      return
    }

    const requestAttachments = [...composerAttachments]
    const messageReferences: ChatReference[] = requestAttachments.flatMap((attachment) => {
      const reference = attachment.blockReference
      if (!reference) return []
      return [{
        id: reference.id,
        sourceType: reference.sourceType,
        documentId: reference.documentId,
        documentName: reference.documentName,
        pageNumber: reference.pageNumber,
        blockId: reference.blockId,
        label: reference.label,
        kind: reference.kind,
        excerpt: reference.excerpt,
      }]
    })
    const attachmentSummary = requestAttachments.length
      ? `\n\n附件：${requestAttachments.map((attachment) => attachment.name).join('、')}`
      : ''
    const visibleUserMessage: ChatMessage = {
      ...createMessage('user', normalizedQuestion),
      content: `${normalizedQuestion}${attachmentSummary}`,
      ...(messageReferences.length ? { references: messageReferences } : {}),
    }
    const assistantMessageId = crypto.randomUUID()
    const pendingAssistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    }
    const titledSession = !baseChatSession.messages.some((message) => message.role === 'user')
      ? { ...baseChatSession, title: deriveReaderChatTitle(normalizedQuestion) }
      : baseChatSession
    let workingChatSession = appendReaderChatMessages(
      titledSession,
      [visibleUserMessage, pendingAssistantMessage],
    )
    const requestKind = viewerSource.kind
    const requestCourseId = activeKnowledgeCourseId
    const requestFolderType = currentFolderType
    const requestDocumentKey = `${requestKind}:${documentId}`
    const persistRequestState = (sessions: ReaderChatSession[], activeId: string) => {
      if (requestKind === 'homework') {
        if (!requestCourseId) return
        saveKnowledgeHomeworkReaderChatState(
          requestCourseId,
          requestFolderType,
          documentId,
          sessions,
          activeId,
        )
        setHomeworkDocuments((current) => current.map((document) => document.id === documentId
          ? { ...document, readerChatSessions: sessions, activeChatSessionId: activeId }
          : document))
        return
      }
      saveKnowledgeReaderChatState(documentId, sessions, activeId)
    }
    let requestSessions = readerChatSessionsRef.current
    const updateRequestSession = (updater: (session: ReaderChatSession) => ReaderChatSession) => {
      requestSessions = requestSessions.map((session) =>
        session.id === sessionId ? updater(session) : session,
      )
      if (loadedChatDocumentKeyRef.current === requestDocumentKey) {
        readerChatSessionsRef.current = requestSessions
        setReaderChatSessions(requestSessions)
      }
      return requestSessions
    }
    const updateRequestMessage = (
      messageId: string,
      updater: (content: string) => string,
    ) => updateRequestSession((session) => ({
      ...session,
      messages: updateMessageContent(session.messages, messageId, updater),
      updatedAt: new Date().toISOString(),
    }))
    const controller = new AbortController()
    const batcher = createChatStreamBatcher((content, mode) => {
      updateRequestMessage(
        assistantMessageId,
        (current) => mode === 'replace' ? content : `${current}${content}`,
      )
    })
    activeRequestRef.current = {
      controller,
      sessionId,
      assistantMessageId,
      documentKey: requestDocumentKey,
      batcher,
      persist: () => persistRequestState(requestSessions, sessionId),
    }
    const initialSessions = updateRequestSession(() => workingChatSession)
    persistRequestState(initialSessions, sessionId)
    setQuestionInput('')
    setComposerAttachments([])
    setIsAsking(true)
    setIsCaptureMode(false)

    const explicitReferenceContext = requestAttachments
      .filter((attachment) => attachment.blockReference && attachment.contentText)
      .map((attachment) => attachment.contentText)
      .join('\n\n')
    const documentAttachmentContext = requestAttachments
      .filter(
        (attachment) => !attachment.blockReference &&
          (attachment.kind === 'document' || attachment.kind === 'text') && attachment.contentText,
      )
      .map((attachment) => `附件文档《${attachment.name}》：\n${attachment.contentText}`)
      .join('\n\n')
    const currentPageContext = buildStructuredPageContext(
      currentViewerStructuredBlocks,
      currentPage,
      currentViewerName,
    )
    const retrievalDocumentType = requestKind === 'homework'
      ? requestFolderType
      : 'lecture'
    const recentRetrievalMessages = titledSession.messages
      .filter((message) =>
        !message.isSummary &&
        (message.role === 'user' || message.role === 'assistant') &&
        message.content.trim(),
      )
      .slice(-4)
      .map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      }))
    let retrievedSections: PromptSourceSection[] = []
    if (requestCourseId) {
      try {
        const retrieval = await retrieveChatContext({
          query: normalizedQuestion,
          courseId: requestCourseId,
          documentId,
          documentType: retrievalDocumentType,
          topN: 20,
          topK: 6,
          recentMessages: recentRetrievalMessages,
        })
        retrievedSections = retrieval.results.map((fragment, index) => {
          const pageLabel = fragment.page_number ? `第 ${fragment.page_number} 页` : '页码未知'
          const location = [fragment.chapter, fragment.section, fragment.title]
            .filter(Boolean)
            .join(' / ')
          return {
            id: `retrieved-${fragment.chunk_id || fragment.question_id || index}`,
            title: [fragment.document_name || currentViewerName, pageLabel, location]
              .filter(Boolean)
              .join(' · '),
            content: fragment.content,
            bucket: 'retrieval',
            priority: 80 - index,
            trimMode: 'head-tail',
          }
        })
        if (retrieval.rerank_source !== 'reranker') {
          console.warn('chat context reranker fallback:', retrieval.rerank_source, retrieval.rerank_error)
        }
        if (retrieval.rewrite_source === 'fallback') {
          console.warn('chat retrieval query rewrite fallback:', retrieval.rewrite_error)
        }
      } catch (error) {
        console.warn('chat context retrieval failed; keeping pinned context only:', error)
      }
    }
    const questionSourceContext: PromptSourceSection[] = [
      {
        id: 'explicit-references',
        title: '用户显式选择的引用',
        content: explicitReferenceContext,
        bucket: 'pinned',
        priority: 140,
        trimMode: 'head-tail',
      },
      {
        id: 'uploaded-attachments',
        title: '本次提问附件',
        content: documentAttachmentContext,
        bucket: 'pinned',
        priority: 130,
        trimMode: 'head-tail',
      },
      ...retrievedSections,
      {
        id: 'current-homework-question',
        title: '当前练习题',
        content: activeHomeworkContextMarkdown,
        bucket: 'auxiliary',
        priority: 30,
        trimMode: 'head-tail',
      },
      ...(explicitReferenceContext ? [] : [{
        id: 'current-page',
        title: `当前查看的第 ${currentPage} 页（辅助背景）`,
        content: currentPageContext,
        bucket: 'auxiliary' as const,
        priority: 20,
        trimMode: 'head-tail' as const,
      }]),
    ]
    const imageAttachments = requestAttachments
      .filter((attachment) => attachment.kind === 'image' && attachment.dataUrl)
      .map((attachment) => ({
        name: attachment.name,
        dataUrl: attachment.dataUrl!,
      }))

    let memoryContextSession = titledSession
    if (
      apiConfig.doubtProvider === 'api' &&
      shouldCompactReaderChatSession(titledSession, apiConfig, apiConfig.doubtModel)
    ) {
      try {
        const memorySummary = await summarizeChatMemoryWithConfiguredApi(
          buildReaderChatContext(titledSession, Number.MAX_SAFE_INTEGER),
          apiConfig,
        )
        if (memorySummary) {
          memoryContextSession = commitReaderChatSummary(titledSession, memorySummary)
          workingChatSession = appendReaderChatMessages(
            memoryContextSession,
            [visibleUserMessage, pendingAssistantMessage],
          )
          const compactedSessions = updateRequestSession(() => workingChatSession)
          persistRequestState(compactedSessions, sessionId)
        }
      } catch (error) {
        console.warn('chat memory compaction failed; continuing with recent history:', error)
      }
    }
    const conversationHistory = buildReaderChatContext(memoryContextSession)

    try {
      if (controller.signal.aborted) throw new Error('Request aborted')
      const result = await askWithConfiguredVisionApi(
        `请回答用户当前问题。如果有显式引用，以显式引用为最高优先级；当前可见页仅作为辅助背景。\n\n${normalizedQuestion}${attachmentSummary}`,
        questionSourceContext,
        apiConfig,
        imageAttachments,
        {
          onToken: batcher.append,
          onSnapshot: batcher.replace,
          signal: controller.signal,
        },
        apiConfig.doubtModel,
        conversationHistory,
      )

      batcher.flush()
      const finalSessions = updateRequestMessage(
        assistantMessageId,
        () => result.answer,
      )
      persistRequestState(finalSessions, sessionId)
    } catch (error) {
      batcher.flush()
      const currentSession = requestSessions.find((session) => session.id === sessionId)
      const partialAnswer = currentSession?.messages.find(
        (message) => message.id === assistantMessageId,
      )?.content.trim() ?? ''
      if (controller.signal.aborted) {
        if (!partialAnswer) {
          updateRequestSession((session) => ({
            ...session,
            messages: session.messages.filter((message) => message.id !== assistantMessageId),
            updatedAt: new Date().toISOString(),
          }))
        }
      } else if (!partialAnswer) {
        const message = error instanceof Error ? error.message : '提问失败'
        updateRequestMessage(
          assistantMessageId,
          () => `当前无法完成回答：${message}\n\n请检查 API 配置、网络或模型能力后重试。`,
        )
      }
      persistRequestState(requestSessions, sessionId)
    } finally {
      if (activeRequestRef.current?.controller === controller) {
        batcher.flush()
        batcher.dispose()
        activeRequestRef.current = null
        setIsAsking(false)
      }
    }
  }

  const latestAssistantMessageId =
    [...visibleConversationMessages].reverse().find((message) => message.role === 'assistant')?.id ?? null
  const canGoPrev = currentPage > 1
  const canGoNext = currentViewerPageCount ? currentPage < currentViewerPageCount : false
  const zoomLabel = `${Math.round(zoom * 100)}%`
  const currentKnowledgeFileId = knowledgeFileId
  const currentDocumentText = documentText

  useEffect(() => {
    const handleAudioUpload = () => {
      lessonAudioUploadInputRef.current?.click()
    }

    const handleTranscriptUpload = () => {
      lessonTranscriptUploadInputRef.current?.click()
    }

    window.addEventListener('student-platform:lesson-audio-upload', handleAudioUpload)
    window.addEventListener('student-platform:lesson-transcript-upload', handleTranscriptUpload)
    return () => {
      window.removeEventListener('student-platform:lesson-audio-upload', handleAudioUpload)
      window.removeEventListener('student-platform:lesson-transcript-upload', handleTranscriptUpload)
    }
  }, [currentDocumentText, currentKnowledgeFileId])

  useEffect(() => {
    const handleRecordingState = (event: Event) => {
      const detail = (event as CustomEvent<{ isRecording?: boolean }>).detail
      setIsLessonRecording(Boolean(detail?.isRecording))
    }
    setIsLessonRecording(isLessonRecordingActive())
    window.addEventListener(LESSON_RECORDING_STATE_EVENT, handleRecordingState)
    return () => window.removeEventListener(LESSON_RECORDING_STATE_EVENT, handleRecordingState)
  }, [])

  return (
    <main className="pdf-workspace pdf-workspace--reader">
      <input
        ref={pdfInputRef}
        type="file"
        accept="application/pdf"
        onChange={handlePdfChange}
        hidden
      />
      <input
        ref={chatUploadInputRef}
        type="file"
        accept="image/*,.pdf,.txt,.md,.markdown,.json"
        multiple
        onChange={handleChatUploadChange}
        hidden
      />
      <input
        ref={homeworkUploadInputRef}
        type="file"
        accept="application/pdf,image/*"
        onChange={handleHomeworkUploadChange}
        hidden
      />
      <input
        ref={lessonAudioUploadInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.webm"
        onChange={handleLessonAudioUploadChange}
        hidden
      />
      <input
        ref={lessonTranscriptUploadInputRef}
        type="file"
        accept=".md,.markdown,.txt,text/markdown,text/plain"
        onChange={handleLessonTranscriptUploadChange}
        hidden
      />
      <section className="pdf-workspace__reader-grid">
        <div className="pdf-workspace__viewer">
          <QuestionAnswerViewer
            courseId={viewerSource.kind === 'homework' ? activeKnowledgeCourseId : null}
            sourceDocumentId={viewerSource.kind === 'homework' ? selectedHomework?.id ?? null : null}
            questionId={viewerSource.kind === 'homework' ? selectedHomeworkQuestion?.id ?? null : null}
            sourceType={currentFolderType}
            classroomPanel={(
              <ClassroomToolsPanel
                tool={pdfAnnotations.tool}
                color={pdfAnnotations.color}
                canAnnotate={Boolean(currentViewerController && annotationDocumentKey)}
                pageAnnotationCount={currentPageAnnotationCount}
                onToolChange={(tool) => {
                  pdfAnnotations.setTool(tool)
                  if (tool !== 'pointer') setIsCaptureMode(false)
                }}
                onColorChange={pdfAnnotations.setColor}
                onClearPage={() => pdfAnnotations.clearPage(currentPage)}
              />
            )}
            relatedPanel={(
              <RelatedMaterialsPanel
                mode={viewerSource.kind === 'lecture' ? 'lecture' : 'question'}
                currentPage={currentPage}
                currentQuestionTitle={selectedHomeworkQuestion?.title ?? null}
                cards={relatedMaterialCards}
                isLoading={isLoadingRelatedMaterials}
                onOpenCard={handleOpenRelatedMaterial}
              />
            )}
            chatPanel={(
              <ChatPanel
                messages={visibleConversationMessages}
                sessions={readerChatSessions}
                activeSessionId={activeChatSessionId}
                onSessionChange={handleSessionChange}
                onNewSession={handleNewChat}
                isAsking={isAsking}
                latestAssistantMessageId={latestAssistantMessageId}
                messagesContainerRef={messagesContainerRef}
                composerAttachments={composerAttachments}
                onRemoveAttachment={removeComposerAttachment}
                questionInput={questionInput}
                onQuestionInputChange={setQuestionInput}
                onQuestionInputKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void runQuestion()
                  }
                }}
                onToggleCapture={() => void handleCaptureFromClipboard()}
                onOpenUpload={() => chatUploadInputRef.current?.click()}
                showModelSelector={apiConfig.doubtProvider === 'api'}
                availableModels={availableDoubtModels}
                activeModel={apiConfig.doubtModel}
                onModelChange={handleModelChange}
                onSend={() => void runQuestion()}
                onStop={handleStopGeneration}
                canSend={!(
                  isAsking ||
                  !questionInput.trim() ||
                  !(
                    documentText.trim() ||
                    selectedHomework?.extractedMarkdown.trim() ||
                    currentViewerStructuredBlocks.length
                  )
                )}
              />
            )}
            workspaceHistoryPanel={isLectureViewer ? (
              <LessonRecordingPanel
                records={lessonRecordingRecords}
                isLoading={isLoadingLessonRecordings}
                error={lessonRecordingsError}
                onRefresh={() => void refreshLessonRecordings()}
              />
            ) : undefined}
            workspaceHistoryBadge={isLectureViewer
              ? isLessonRecording ? 'REC' : lessonRecordingRecords.length || null
              : null}
            classroomBadge={isLessonRecording ? 'REC' : null}
            workspaceHistoryTitle="课堂录音与 ASR"
            workspaceHistoryLabel="课堂记录"
          >
            {isLectureViewer && activeKnowledgeCourseId && currentKnowledgeFileId ? (
              <LectureMasteryTest
                courseId={activeKnowledgeCourseId}
                lectureDocumentId={currentKnowledgeFileId}
                lectureName={currentViewerName}
                onOpenPage={handleVisiblePageChange}
              />
            ) : null}
            <PdfPreviewCanvas
              fileName={currentViewerName}
              pdfController={currentViewerController}
              onVisualReady={() => setReaderVisualReady(true)}
              pageImageUrl={resolveLecturePageImage}
              imageUrl={currentViewerImageUrl}
              currentPage={currentPage}
              pageCount={currentViewerPageCount}
              zoom={zoom}
              zoomLabel={zoomLabel}
              canGoPrev={canGoPrev}
              canGoNext={canGoNext}
              onPrevPage={handlePrevPage}
              onNextPage={handleNextPage}
              onZoomOut={() => handleZoom(zoom - 0.12)}
              onZoomIn={() => handleZoom(zoom + 0.12)}
              onFitWidth={() => handleZoom(1)}
              onOpenPdf={() => pdfInputRef.current?.click()}
              onVisiblePageChange={handleVisiblePageChange}
              onInspectPageDoubts={handleInspectPageDoubts}
              onInspectPageLectureSegments={handleInspectPageLectureSegments}
              onPlayPageLectureSegments={handlePlayPageLectureSegments}
              playingLecturePage={pageLecturePlayback.playingPage}
              showLectureControls={isLectureViewer}
              onInspectPageQuestions={isLectureViewer ? handleInspectPageQuestions : () => {}}
              isCaptureMode={isCaptureMode}
              selectedHomeworkQuestion={viewerSource.kind === 'homework' ? selectedHomeworkQuestion : null}
              structuredBlocks={currentViewerStructuredBlocks}
              lectureSegmentsByPage={lectureSegmentsByPage}
              homeworkKnowledgeLinks={isLectureViewer ? allHomeworkKnowledgeLinks : []}
              onOpenKnowledgeLink={handleOpenKnowledgeLink}
              onOpenLecturePageQuestions={isLectureViewer ? handleOpenLecturePageQuestions : undefined}
              visibleQuestions={viewerSource.kind === 'homework' ? selectedHomework?.questions ?? [] : []}
              onVisibleQuestionChange={
                viewerSource.kind === 'homework' ? handleVisibleHomeworkQuestionChange : undefined
              }
              onCaptureSelection={handleCaptureSelection}
              onTextSelection={handleTextSelection}
              referencedBlockIds={referencedBlockIds}
              onRemoveBlockReference={removeBlockReference}
              annotationTool={pdfAnnotations.tool}
              annotationColor={pdfAnnotations.color}
              annotations={pdfAnnotations.annotations}
              onAddAnnotation={pdfAnnotations.addAnnotation}
              onUpdateAnnotation={pdfAnnotations.updateAnnotation}
              onRemoveAnnotation={pdfAnnotations.removeAnnotation}
            />
          </QuestionAnswerViewer>
        </div>
      </section>
      {isLectureViewer ? (
        <PageLecturePlayer
          player={pageLecturePlayback.activePlayer}
          playingPage={pageLecturePlayback.playingPage}
          playbackSeconds={pageLecturePlayback.playbackSeconds}
          playbackRate={pageLecturePlayback.playbackRate}
          onToggle={pageLecturePlayback.toggle}
          onSeek={pageLecturePlayback.seek}
          onSkip={pageLecturePlayback.skip}
          onStop={pageLecturePlayback.stop}
          onChangeRate={pageLecturePlayback.changeRate}
        />
      ) : null}
    </main>
  )
}
