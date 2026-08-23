import {
  startTransition,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { PdfPreviewCanvas } from '../components/PdfPreviewCanvas'
import { ChatPanel } from '../features/pdf-workspace/components/ChatPanel'
import { RelatedMaterialsPanel } from '../features/pdf-workspace/components/RelatedMaterialsPanel'
import type {
  ComposerAttachment,
  DraftDoubt,
  HomeworkFocus,
  RelatedMaterialCard,
  ViewerSource,
} from '../features/pdf-workspace/types'
import {
  appendRelatedQuestionId,
  buildAnnotationConversation,
  buildHomeworkContextMarkdown,
  buildLectureConversation,
  buildStructuredPageContext,
  clampPanelWidth,
  createDraftDoubt,
  createMessage,
  DEFAULT_DOCUMENT_NAME,
  emitLessonProcessingState,
  ensureActiveModel,
  groupHomeworkLinksByLecturePage,
  groupLectureSegmentsByPage,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  LEFT_PANEL_WIDTH_KEY,
  loadPanelWidth,
  readFileAsDataUrl,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  RIGHT_PANEL_WIDTH_KEY,
  updateMessageContent,
} from '../features/pdf-workspace/utils'
import {
  loadApiConfig,
  loadApiConfigFromServer,
  resolveBackendApiUrl,
  saveApiConfig,
} from '../lib/apiConfig'
import {
  buildClassroomSessionWithApi,
  buildClassroomSessionFromSequentialAlignment,
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
  getKnowledgeHomeworkFolderName,
  linkQuestionToAnnotation,
  linkQuestionToHomeworkAnnotation,
  loadKnowledgeHomeworkAsset,
  loadKnowledgePdfSource,
  saveKnowledgeClassroomSession,
  saveKnowledgeHomeworkDocuments,
  saveKnowledgeAnnotation,
  saveKnowledgeHomeworkAnnotation,
  saveKnowledgeHomeworkAnnotationChatSession,
  saveKnowledgeChatMessages,
  saveKnowledgeAnnotationChatSession,
  getKnowledgeCourse,
  touchKnowledgeFile,
  upsertKnowledgeFile,
} from '../lib/knowledgeBase'
import {
  appendDoubtChatMessages,
  buildDoubtChatContext,
  commitDoubtChatSummary,
  normalizeDoubtChatSession,
  shouldCompactDoubtChatSession,
  updateDoubtChatMessage,
} from '../lib/chatMemory'
import type { PromptSourceSection } from '../lib/contextBudget'
import {
  buildFailedHomeworkDocument,
  buildPendingHomeworkDocument,
  getLectureDocumentProcessingStatus,
  processHomeworkDocumentWithPipeline,
  readHomeworkAssetPayload,
  submitLectureDocumentForProcessing,
  type DocumentPipelineStatus,
} from '../lib/mineru'
import {
  extractPdfPreview,
  extractPdfPreviewFromBuffer,
} from '../lib/pdf'
import {
  getLecturePageRelations,
  getQuestionRelations,
  type QuestionRelation,
} from '../lib/questionRelations'
import type {
  ApiConfig,
  ChatMessage,
  ClassroomLectureSegment,
  ClassroomSession,
  DoubtAnnotation,
  DoubtChatSession,
  HomeworkDocument,
  KnowledgeHomeworkFolderType,
  PdfController,
  StructuredDocumentBlock,
  StoredDoubtAnnotation,
} from '../types'

type PageLecturePlaybackRange = {
  recordingId: string
  startSeconds: number
  endSeconds: number
}

type ActivePageLecturePlayer = PageLecturePlaybackRange & {
  pageNumber: number
}

function formatPlaybackTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

function findLongestContinuousLectureRange(
  segments: ClassroomLectureSegment[],
): PageLecturePlaybackRange | null {
  const candidates = segments
    .flatMap((segment) => {
      if (
        !segment.recordingId ||
        segment.startSeconds === null ||
        segment.endSeconds === null ||
        segment.endSeconds <= segment.startSeconds
      ) {
        return []
      }
      return [{
        recordingId: segment.recordingId,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
      }]
    })
    .sort(
      (left, right) =>
        left.recordingId.localeCompare(right.recordingId) || left.startSeconds - right.startSeconds,
    )

  const ranges: PageLecturePlaybackRange[] = []
  for (const candidate of candidates) {
    const previous = ranges.at(-1)
    if (
      previous &&
      previous.recordingId === candidate.recordingId &&
      candidate.startSeconds <= previous.endSeconds + 1
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, candidate.endSeconds)
      continue
    }
    ranges.push({ ...candidate })
  }

  return ranges.reduce<PageLecturePlaybackRange | null>(
    (longest, range) =>
      !longest || range.endSeconds - range.startSeconds > longest.endSeconds - longest.startSeconds
        ? range
        : longest,
    null,
  )
}

function mapQuestionRelationCards(relations: QuestionRelation[]): RelatedMaterialCard[] {
  return relations
    .map((relation) => {
      const target = relation.target
      const documentType = String(target.document_type || '')
      const isLecture = documentType === 'lecture'
      const content = String(target.content || '')
      return {
        id: relation.relation_id,
        kind: isLecture ? ('lecture' as const) : ('question' as const),
        documentId: String(target.document_id || ''),
        documentName: String(target.document_name || ''),
        documentType,
        pageNumber: Number(target.page_number) || null,
        questionId: target.question_id ? String(target.question_id) : null,
        title: String(target.title || ''),
        content,
        chapter: '',
        confidence: typeof relation.confidence === 'number' ? relation.confidence : null,
      }
    })
    .filter((card) => Boolean(card.documentId))
}

function mapLecturePageRelationCards(
  relations: QuestionRelation[],
  lectureDocumentId: string,
  pageNumber: number,
): RelatedMaterialCard[] {
  return relations
    .map<RelatedMaterialCard | null>((relation) => {
      const question = relation.question
      const target = relation.target
      if (
        !question?.document_id ||
        String(target.document_id || '') !== lectureDocumentId ||
        Number(target.page_number) !== pageNumber
      ) {
        return null
      }
      return {
        id: relation.relation_id,
        kind: 'question' as const,
        documentId: String(question.document_id),
        documentName: String(question.document_name || ''),
        documentType: String(question.document_type || ''),
        pageNumber: Number(question.page_number) || null,
        questionId: question.question_id ? String(question.question_id) : null,
        title: String(question.title || ''),
        content: String(question.content || ''),
        chapter: String(question.analysis?.chapter || ''),
        confidence: typeof relation.confidence === 'number' ? relation.confidence : null,
      }
    })
    .filter((card): card is RelatedMaterialCard => card !== null)
}

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
  const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
    clampPanelWidth(loadPanelWidth(LEFT_PANEL_WIDTH_KEY, 320), LEFT_PANEL_MIN, LEFT_PANEL_MAX),
  )
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    clampPanelWidth(loadPanelWidth(RIGHT_PANEL_WIDTH_KEY, 420), RIGHT_PANEL_MIN, RIGHT_PANEL_MAX),
  )
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
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [apiConfig, setApiConfig] = useState<ApiConfig>(loadApiConfig())
  const [isAsking, setIsAsking] = useState(false)
  const [_isRestoringFile, setIsRestoringFile] = useState(false)
  const [isSavingDoubt, setIsSavingDoubt] = useState(false)
  const [draftDoubt, setDraftDoubt] = useState<DraftDoubt | null>(null)
  const [annotations, setAnnotations] = useState<StoredDoubtAnnotation[]>([])
  const [homeworkDocuments, setHomeworkDocuments] = useState<HomeworkDocument[]>([])
  const [homeworkFocus, setHomeworkFocus] = useState<HomeworkFocus | null>(null)
  const [relatedMaterialCards, setRelatedMaterialCards] = useState<RelatedMaterialCard[]>([])
  const [isLoadingRelatedMaterials, setIsLoadingRelatedMaterials] = useState(false)
  const [, setIsExtractingHomework] = useState(false)
  const [_isProcessingLesson, setIsProcessingLesson] = useState(false)
  const [isLessonRecording, setIsLessonRecording] = useState(false)
  const [pageFilter, setPageFilter] = useState<number | null>(null)
  const [pageLectureFilter, setPageLectureFilter] = useState<number | null>(null)
  const [playingLecturePage, setPlayingLecturePage] = useState<number | null>(null)
  const [activeLecturePlayer, setActiveLecturePlayer] = useState<ActivePageLecturePlayer | null>(null)
  const [lecturePlaybackSeconds, setLecturePlaybackSeconds] = useState<number | null>(null)
  const [lecturePlaybackRate, setLecturePlaybackRate] = useState(1)
  const [isLecturePlayerMinimized, setIsLecturePlayerMinimized] = useState(false)
  const [lecturePlayerPosition, setLecturePlayerPosition] = useState<{
    left: number
    top: number
  } | null>(null)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [isCaptureMode, setIsCaptureMode] = useState(false)
  const [classroomSessions, setClassroomSessions] = useState<ClassroomSession[]>([])
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => [
    createMessage(
      'assistant',
      '上传 PDF 后，你可以按页查看疑点，或者直接开启新的疑点对话。',
    ),
  ])
  const messagesContainerRef = useRef<HTMLDivElement | null>(null)
  const streamBufferRef = useRef('')
  const streamTimerRef = useRef<number | null>(null)
  const saveChatTimerRef = useRef<number | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const pageLectureAudioRef = useRef<HTMLAudioElement | null>(null)
  const lecturePlayerDragRef = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
    width: number
    height: number
  } | null>(null)
  const lessonChunksRef = useRef<Blob[]>([])
  const lessonStreamRef = useRef<MediaStream | null>(null)
  const pdfInputRef = useRef<HTMLInputElement | null>(null)
  const chatUploadInputRef = useRef<HTMLInputElement | null>(null)
  const homeworkUploadInputRef = useRef<HTMLInputElement | null>(null)
  const lessonAudioUploadInputRef = useRef<HTMLInputElement | null>(null)
  const lessonTranscriptUploadInputRef = useRef<HTMLInputElement | null>(null)
  const lectureMineruInFlightRef = useRef<Set<string>>(new Set())
  const lectureMineruFailedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    return () => {
      const audio = pageLectureAudioRef.current
      if (!audio) {
        return
      }
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
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
    const cache = homeworkPreviewCacheRef.current
    cache.delete(documentId)
    cache.set(documentId, preview)
    // PDF.js page controllers retain render resources. Keep recently viewed
    // exercises available without allowing an unbounded cache in long sessions.
    while (cache.size > 4) {
      const oldestDocumentId = cache.keys().next().value
      if (!oldestDocumentId) break
      cache.delete(oldestDocumentId)
    }
  }

  useEffect(() => () => {
    if (streamTimerRef.current !== null) {
      window.clearTimeout(streamTimerRef.current)
    }
    if (saveChatTimerRef.current !== null) {
      window.clearTimeout(saveChatTimerRef.current)
    }
    homeworkPreviewCacheRef.current.clear()
  }, [])
  const readerGridRef = useRef<HTMLElement | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const latestPointerXRef = useRef<number | null>(null)
  const activeResizeRef = useRef<{
    side: 'left' | 'right'
    startX: number
    startWidth: number
  } | null>(null)
  const deferredChatMessages = useDeferredValue(chatMessages)
  const [composerAttachments, setComposerAttachments] = useState<ComposerAttachment[]>([])

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
  const activeKnowledgeCourseId = currentCourseId ?? knowledgeCourseId
  const activeAnnotations = useMemo(
    () => (viewerSource.kind === 'homework' ? selectedHomework?.annotations ?? [] : annotations),
    [annotations, selectedHomework, viewerSource.kind],
  )
  const visibleAnnotations = useMemo(
    () =>
      pageFilter === null
        ? activeAnnotations
        : activeAnnotations.filter((annotation) => annotation.pageNumber === pageFilter),
    [activeAnnotations, pageFilter],
  )
  const selectedAnnotation =
    activeAnnotations.find((annotation) => annotation.id === selectedAnnotationId) ?? null
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

  useEffect(() => {
    const controller = new AbortController()
    const sourceQuestionId =
      viewerSource.kind === 'homework' ? selectedHomeworkQuestion?.id ?? null : null
    const lectureDocumentId = viewerSource.kind === 'lecture' ? knowledgeFileId : null

    if (!activeKnowledgeCourseId || (!sourceQuestionId && !lectureDocumentId)) {
      setRelatedMaterialCards([])
      setIsLoadingRelatedMaterials(false)
      return () => controller.abort()
    }

    setIsLoadingRelatedMaterials(true)
    void (async () => {
      try {
        const record = sourceQuestionId
          ? await getQuestionRelations(sourceQuestionId, controller.signal)
          : await getLecturePageRelations(
              activeKnowledgeCourseId,
              lectureDocumentId!,
              currentPage,
              controller.signal,
            )
        if (controller.signal.aborted) {
          return
        }
        setRelatedMaterialCards(
          sourceQuestionId
            ? mapQuestionRelationCards(record.relations)
            : mapLecturePageRelationCards(record.relations, lectureDocumentId!, currentPage),
        )
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn('Unable to load related materials:', error)
          setRelatedMaterialCards([])
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingRelatedMaterials(false)
        }
      }
    })()

    return () => controller.abort()
  }, [
    activeKnowledgeCourseId,
    currentPage,
    knowledgeFileId,
    selectedHomeworkQuestion?.id,
    viewerSource.kind,
  ])

  const selectedAnnotationConversation = useMemo<ChatMessage[]>(
    () => buildAnnotationConversation(selectedAnnotation, chatMessages),
    [chatMessages, selectedAnnotation],
  )
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

    if (draftDoubt) {
      return [
        createMessage(
          'assistant',
          `已在第 ${draftDoubt.pageNumber ?? currentPage} 页开启新的疑点对话。直接在下方输入问题并发送，我会自动创建这条疑点记录。`,
        ),
      ]
    }

    if (selectedAnnotation) {
      return selectedAnnotationConversation
    }

    if (pageFilter !== null) {
      return [
        createMessage(
          'system',
          `当前正在查看第 ${pageFilter} 页的疑点。请先从左侧选择一条疑点，或在下方新建提问。`,
        ),
      ]
    }

    return [
      createMessage(
        'assistant',
        viewerSource.kind === 'homework'
          ? '点击“查看疑点”后，这里会列出当前页面的疑点会话。选择一条会话即可继续讨论。'
          : '点击“查看疑点”后，这里会列出当前页面的疑点会话。选择一条会话即可继续讨论。',
      ),
    ]
  }, [
    currentPage,
    draftDoubt,
    lectureSegmentsByPage,
    pageFilter,
    pageLectureFilter,
    selectedAnnotation,
    selectedAnnotationConversation,
    viewerSource.kind,
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
  const isLectureViewer = viewerSource.kind === 'lecture'
  const activeHomeworkDocumentId =
    viewerSource.kind === 'homework' ? viewerSource.documentId : null

  useEffect(() => {
    if (isLectureViewer) {
      return
    }

    const audio = pageLectureAudioRef.current
    audio?.pause()
    setPlayingLecturePage(null)
    setActiveLecturePlayer(null)
    setLecturePlaybackSeconds(null)
  }, [isLectureViewer])
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

  const clearStreamTimer = () => {
    if (streamTimerRef.current !== null) {
      window.clearTimeout(streamTimerRef.current)
      streamTimerRef.current = null
    }
  }

  const flushStreamBuffer = (messageId: string) => {
    if (!streamBufferRef.current.length) {
      streamTimerRef.current = null
      return
    }

    const chunk = streamBufferRef.current.slice(0, 1)
    streamBufferRef.current = streamBufferRef.current.slice(1)

    startTransition(() => {
      setChatMessages((current) =>
        updateMessageContent(current, messageId, (content) => `${content}${chunk}`),
      )
    })

    streamTimerRef.current = window.setTimeout(() => flushStreamBuffer(messageId), 14)
  }

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
    if (!selectedAnnotationId) {
      return
    }

    const stillExists = activeAnnotations.some((annotation) => annotation.id === selectedAnnotationId)
    if (!stillExists) {
      setSelectedAnnotationId(null)
    }
  }, [activeAnnotations, selectedAnnotationId])

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
              : await extractPdfPreviewFromBuffer(payload, targetDocument.fileName)
          if (cancelled) {
            return
          }

          if (!cachedPreview) {
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

  useEffect(() => () => clearStreamTimer(), [])

  useEffect(() => {
    window.localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(leftPanelWidth))
  }, [leftPanelWidth])

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth))
  }, [rightPanelWidth])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      latestPointerXRef.current = event.clientX
      if (resizeFrameRef.current !== null) {
        return
      }

      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null

        const activeResize = activeResizeRef.current
        const readerGrid = readerGridRef.current
        const pointerX = latestPointerXRef.current

        if (!activeResize || !readerGrid || pointerX === null) {
          return
        }

        const gridRect = readerGrid.getBoundingClientRect()
        const gapWidth = 36
        const minCenterWidth = 520

        if (activeResize.side === 'left') {
          const delta = pointerX - activeResize.startX
          const maxWidth = Math.min(
            LEFT_PANEL_MAX,
            gridRect.width - rightPanelWidth - minCenterWidth - gapWidth,
          )
          setLeftPanelWidth(
            clampPanelWidth(
              activeResize.startWidth + delta,
              LEFT_PANEL_MIN,
              Math.max(LEFT_PANEL_MIN, maxWidth),
            ),
          )
          return
        }

        const delta = activeResize.startX - pointerX
        const maxWidth = Math.min(
          RIGHT_PANEL_MAX,
          gridRect.width - leftPanelWidth - minCenterWidth - gapWidth,
        )
        setRightPanelWidth(
          clampPanelWidth(
            activeResize.startWidth + delta,
            RIGHT_PANEL_MIN,
            Math.max(RIGHT_PANEL_MIN, maxWidth),
          ),
        )
      })
    }

    const handlePointerUp = () => {
      activeResizeRef.current = null
      latestPointerXRef.current = null
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      document.body.classList.remove('is-resizing-panels')
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [leftPanelWidth, rightPanelWidth])

  useEffect(() => {
    if (!initialFileId) {
      return
    }

    let cancelled = false

    const restoreFile = async () => {
      try {
        await ensureKnowledgeLibraryLoaded()
        const storedFile = getKnowledgeFile(initialFileId)
        if (!storedFile) {
          return
        }

        setIsRestoringFile(true)

        const pdfBuffer = storedFile.hasPdfSource
          ? await loadKnowledgePdfSource(storedFile.id)
          : null
        const extracted = pdfBuffer
          ? await extractPdfPreviewFromBuffer(pdfBuffer, storedFile.fileName)
          : null

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
        setPdfPageCount((storedFile.pageCount > 0 ? storedFile.pageCount : extracted?.pageCount) || null)
        setPdfController(extracted?.controller ?? null)
        setLectureDocumentName(storedFile.fileName)
        setLectureDocumentText(storedFile.markdown || '')
        setLecturePdfPageCount(
          (storedFile.pageCount > 0 ? storedFile.pageCount : extracted?.pageCount) || null,
        )
        setLecturePdfController(extracted?.controller ?? null)
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
        setAnnotations(storedFile.annotations)
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
        setPageFilter(null)
        setSelectedAnnotationId(
          initialHomeworkDocument
            ? initialHomeworkDocument.annotations[0]?.id ?? null
            : storedFile.annotations[0]?.id ?? null,
        )
        setChatMessages(
          storedFile.chatMessages.length
            ? storedFile.chatMessages
            : [
                createMessage(
                  'assistant',
                  `已恢复 ${storedFile.fileName} 的历史问答与疑点记录，你可以继续编辑新的疑点。`,
                ),
              ],
        )
        setCurrentPage(initialHomeworkQuestion?.pageNumber ?? initialPageNumber)
        setZoom(1)
        setDraftDoubt(null)
        touchKnowledgeFile(storedFile.id)
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
  }, [initialFileId, initialHomeworkId, initialHomeworkQuestionId, initialPageNumber])

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
        setAnnotations([])
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
        setPageFilter(null)
        setSelectedAnnotationId(initialHomeworkDocument?.annotations[0]?.id ?? null)
        setChatMessages([
          createMessage(
            'assistant',
            `${getKnowledgeHomeworkFolderName(currentFolderType)} 已打开，你可以直接上传题目。`,
          ),
        ])
        setCurrentPage(initialHomeworkQuestion?.pageNumber ?? initialPageNumber)
        setZoom(1)
        setDraftDoubt(null)
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
    if (!knowledgeFileId) {
      return
    }

    if (saveChatTimerRef.current !== null) {
      window.clearTimeout(saveChatTimerRef.current)
    }

    saveChatTimerRef.current = window.setTimeout(() => {
      try {
        saveKnowledgeChatMessages(knowledgeFileId, deferredChatMessages)
      } catch (error) {
        console.error('saveKnowledgeChatMessages failed:', error)
      } finally {
        saveChatTimerRef.current = null
      }
    }, 280)

    return () => {
      if (saveChatTimerRef.current !== null) {
        window.clearTimeout(saveChatTimerRef.current)
        saveChatTimerRef.current = null
      }
    }
  }, [deferredChatMessages, knowledgeFileId])

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
            setAnnotations(refreshedFile.annotations)
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
  }, [knowledgeFileId])

  const handlePdfChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const result = await extractPdfPreview(file)
      const initialChatMessages = [
        createMessage(
          'assistant',
          `已载入 ${file.name}。PDF 预览已打开，正在后台用 MinerU 提取讲义结构。`,
        ),
      ]
      const storedFile = await upsertKnowledgeFile({
        fileName: file.name,
        pageCount: result.pageCount,
        byteSize: result.buffer.byteLength,
        markdown: '',
        layoutBlocks: [],
        pdfBuffer: result.buffer,
        courseId: currentCourseId,
        chatMessages: initialChatMessages,
      })

      startTransition(() => {
        setKnowledgeFileId(storedFile.id)
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
        setAnnotations(storedFile.annotations)
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
        setPageFilter(null)
        setSelectedAnnotationId(storedFile.annotations[0]?.id ?? null)
        setDraftDoubt(null)
        setChatMessages(initialChatMessages)
      })

    } catch (error) {
      const message = error instanceof Error ? error.message : '解析失败'
      setChatMessages((current) => [
        ...current,
        createMessage('system', `这次 PDF 解析失败了：${message}`),
      ])
    } finally {
      event.target.value = ''
    }
  }

  const handleInspectPageDoubts = (pageNumber: number) => {
    setDraftDoubt(null)
    setPageFilter(pageNumber)
    setPageLectureFilter(null)
    setSelectedAnnotationId(null)
    setComposerAttachments([])
    setIsCaptureMode(false)
  }

  const handleInspectPageQuestions = (pageNumber: number) => {
    setCurrentPage(pageNumber)
    setPageLectureFilter(null)
    setDraftDoubt(null)
    setPageFilter(null)
    setSelectedAnnotationId(null)
    setIsCaptureMode(false)
  }

  const handleSelectAnnotation = (annotationId: string) => {
    const nextAnnotation =
      activeAnnotations.find((annotation) => annotation.id === annotationId) ?? null
    setSelectedAnnotationId(annotationId)
    setDraftDoubt(null)
    setQuestionInput('')
    setComposerAttachments([])
    setIsCaptureMode(false)
    setPageLectureFilter(null)
    if (nextAnnotation?.pageNumber) {
      setCurrentPage(nextAnnotation.pageNumber)
      setPageFilter(nextAnnotation.pageNumber)
    }
  }

  const handleInspectPageLectureSegments = (pageNumber: number) => {
    setCurrentPage(pageNumber)
    setPageLectureFilter(pageNumber)
    setPageFilter(null)
    setDraftDoubt(null)
    setSelectedAnnotationId(null)
    setComposerAttachments([])
    setIsCaptureMode(false)
  }

  const handlePlayPageLectureSegments = (pageNumber: number) => {
    const playbackRange = findLongestContinuousLectureRange(
      lectureSegmentsByPage.get(pageNumber) ?? [],
    )
    if (!playbackRange || !activeKnowledgeCourseId) {
      return
    }

    const audio = pageLectureAudioRef.current ?? new Audio()
    pageLectureAudioRef.current = audio
    audio.pause()
    audio.playbackRate = lecturePlaybackRate
    setActiveLecturePlayer({ pageNumber, ...playbackRange })
    setLecturePlaybackSeconds(playbackRange.startSeconds)
    setIsLecturePlayerMinimized(false)
    audio.onplay = () => setPlayingLecturePage(pageNumber)
    audio.onpause = () => setPlayingLecturePage((current) => (current === pageNumber ? null : current))
    audio.onended = () => setPlayingLecturePage(null)
    audio.onerror = () => {
      setPlayingLecturePage(null)
      setActiveLecturePlayer(null)
      setLecturePlaybackSeconds(null)
    }
    audio.ontimeupdate = () => {
      setLecturePlaybackSeconds(audio.currentTime)
      if (audio.currentTime >= playbackRange.endSeconds) {
        audio.currentTime = playbackRange.endSeconds
        audio.pause()
      }
    }
    audio.onloadedmetadata = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : playbackRange.endSeconds
      audio.currentTime = Math.min(playbackRange.startSeconds, Math.max(0, duration - 0.05))
      void audio.play().then(
        () => setPlayingLecturePage(pageNumber),
        () => setPlayingLecturePage(null),
      )
    }
    audio.src = resolveBackendApiUrl(
      `/api/audio/recordings/${encodeURIComponent(playbackRange.recordingId)}/media?course_id=${encodeURIComponent(activeKnowledgeCourseId)}`,
    )
    audio.load()
  }

  const handleToggleLecturePlayback = () => {
    const audio = pageLectureAudioRef.current
    const player = activeLecturePlayer
    if (!audio || !player) {
      return
    }

    if (audio.paused) {
      if (audio.currentTime < player.startSeconds || audio.currentTime >= player.endSeconds) {
        audio.currentTime = player.startSeconds
        setLecturePlaybackSeconds(player.startSeconds)
      }
      audio.playbackRate = lecturePlaybackRate
      void audio.play().catch(() => setPlayingLecturePage(null))
      return
    }

    audio.pause()
  }

  const handleSeekLecturePlayback = (targetSeconds: number) => {
    const audio = pageLectureAudioRef.current
    const player = activeLecturePlayer
    if (!audio || !player) {
      return
    }

    const nextSeconds = Math.min(
      player.endSeconds,
      Math.max(player.startSeconds, targetSeconds),
    )
    audio.currentTime = nextSeconds
    setLecturePlaybackSeconds(nextSeconds)
    if (nextSeconds >= player.endSeconds) {
      audio.pause()
    }
  }

  const handleSkipLecturePlayback = (seconds: number) => {
    const player = activeLecturePlayer
    if (!player) {
      return
    }

    handleSeekLecturePlayback((lecturePlaybackSeconds ?? player.startSeconds) + seconds)
  }

  const handleStopLecturePlayback = () => {
    const audio = pageLectureAudioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    setPlayingLecturePage(null)
    setActiveLecturePlayer(null)
    setLecturePlaybackSeconds(null)
    setIsLecturePlayerMinimized(false)
  }

  const handleLecturePlaybackRateChange = (rate: number) => {
    setLecturePlaybackRate(rate)
    if (pageLectureAudioRef.current) {
      pageLectureAudioRef.current.playbackRate = rate
    }
  }

  const handleLecturePlayerDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return
    }

    const player = event.currentTarget.closest<HTMLElement>('.lecture-player')
    if (!player) {
      return
    }

    const bounds = player.getBoundingClientRect()
    lecturePlayerDragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const handleLecturePlayerDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = lecturePlayerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    const margin = 12
    setLecturePlayerPosition({
      left: Math.min(
        window.innerWidth - drag.width - margin,
        Math.max(margin, event.clientX - drag.offsetX),
      ),
      top: Math.min(
        window.innerHeight - drag.height - margin,
        Math.max(margin, event.clientY - drag.offsetY),
      ),
    })
  }

  const handleLecturePlayerDragEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = lecturePlayerDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }

    lecturePlayerDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const stopLessonRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current
    if (!recorder) {
      return
    }

    await new Promise<void>((resolve) => {
      recorder.addEventListener(
        'stop',
        () => {
          resolve()
        },
        { once: true },
      )
      recorder.stop()
    })
  }, [])

  const persistLessonTranscript = useCallback(
    async (
      transcript:
        | string
        | AsrTranscriptionResult,
      sourceLabel: string,
      config: ApiConfig,
    ) => {
      const transcriptText = typeof transcript === 'string' ? transcript : transcript.text
      if (!transcriptText.trim() || !knowledgeFileId) {
        return
      }

      emitLessonProcessingState('课堂整理/映射中')
      const session =
        typeof transcript !== 'string' && transcript.recording && activeKnowledgeCourseId
          ? await buildClassroomSessionFromSequentialAlignment(
              transcript,
              activeKnowledgeCourseId,
              knowledgeFileId,
            )
          : await buildClassroomSessionWithApi(transcript, documentText, config)
      const mappedPageCount = new Set(
        session.segments.flatMap((segment) => segment.pageNumbers ?? []),
      ).size
      if (!session.segments.length || mappedPageCount === 0) {
        throw new Error('课堂映射未得到任何有效讲义页，请检查转写内容或模型输出。')
      }
      const storedSession = saveKnowledgeClassroomSession(knowledgeFileId, session)
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
    async (audioBlob: Blob, sourceLabel: string) => {
      if (!audioBlob.size || !knowledgeFileId || !activeKnowledgeCourseId) {
        return
      }

      setIsProcessingLesson(true)
      try {
        const config = loadApiConfig()
        emitLessonProcessingState('ASR 转写中')
        const transcript = await transcribeAudioWithConfiguredAsr(audioBlob, config, {
          courseId: activeKnowledgeCourseId,
          documentId: knowledgeFileId,
        })
        await persistLessonTranscript(transcript, sourceLabel, config)
        emitLessonProcessingState('已完成')
      } catch (error) {
        const message = error instanceof Error ? error.message : `${sourceLabel}处理失败`
        setChatMessages((current) => [
          ...current,
          createMessage('system', `${sourceLabel}处理失败：${message}`),
        ])
        emitLessonProcessingState('处理失败')
      } finally {
        setIsProcessingLesson(false)
        window.setTimeout(() => emitLessonProcessingState(''), 1800)
      }
    },
    [activeKnowledgeCourseId, knowledgeFileId, persistLessonTranscript],
  )

  const startLessonRecording = useCallback(async () => {
    if (!knowledgeFileId) {
      setChatMessages((current) => [
        ...current,
        createMessage('system', '请先打开一份讲义 PDF，再开始上课录音。'),
      ])
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream)
      lessonChunksRef.current = []
      lessonStreamRef.current = stream
      mediaRecorderRef.current = recorder

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          lessonChunksRef.current.push(event.data)
        }
      })

      recorder.addEventListener(
        'stop',
        async () => {
          setIsLessonRecording(false)
          window.dispatchEvent(
            new CustomEvent('student-platform:lesson-recording-state', {
              detail: { isRecording: false },
            }),
          )

          lessonStreamRef.current?.getTracks().forEach((track) => track.stop())
          lessonStreamRef.current = null
          mediaRecorderRef.current = null

          const audioBlob = new Blob(lessonChunksRef.current, {
            type: recorder.mimeType || 'audio/webm',
          })
          lessonChunksRef.current = []

          if (!audioBlob.size || !knowledgeFileId) {
            return
          }

          await processLessonAudio(audioBlob, '课堂录音')
        },
        { once: true },
      )

      recorder.start()
      setIsLessonRecording(true)
      emitLessonProcessingState('录音中')
      window.dispatchEvent(
        new CustomEvent('student-platform:lesson-recording-state', {
          detail: { isRecording: true },
        }),
      )
      setChatMessages((current) => [
        ...current,
        createMessage('system', '已开始录音。结束录音后，系统会自动转写并生成课堂讲解片段。'),
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : '无法启动录音'
      emitLessonProcessingState('')
      setChatMessages((current) => [
        ...current,
        createMessage('system', `录音启动失败：${message}`),
      ])
    }
  }, [knowledgeFileId, processLessonAudio])

  const handleLessonAudioUploadChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      event.target.value = ''
      return
    }

    if (!knowledgeFileId) {
      setChatMessages((current) => [
        ...current,
        createMessage('system', '请先打开一份讲义 PDF，再上传录音文件。'),
      ])
      event.target.value = ''
      return
    }

    setChatMessages((current) => [
      ...current,
      createMessage('system', `已上传录音文件《${file.name}》，正在进行转写与课堂映射。`),
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
    setSelectedAnnotationId(null)
    setPageFilter(null)
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

    const lowerName = file.name.toLowerCase()
    const isPdf = file.type === 'application/pdf' || lowerName.endsWith('.pdf')
    if (!isPdf) {
      setChatMessages((current) => [
        ...current,
        createMessage('system', `练习文件格式不支持：${file.name}`),
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
            reference.documentId === (viewerSource.kind === 'homework' ? viewerSource.documentId : null),
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
            blockId: block.id,
            pageNumber: selection.pageNumber,
            viewer: viewerSource.kind,
            documentId: viewerSource.kind === 'homework' ? viewerSource.documentId : null,
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

  const persistDoubtRecord = async (
    question: string,
    source: DraftDoubt | null = draftDoubt,
  ) => {
    if (!source || !question.trim()) {
      return null
    }

    const annotation: DoubtAnnotation = {
      id: source.id,
      pageNumber: source.pageNumber,
      question: question.trim(),
      imageAssetId: null,
      imageName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    let storedAnnotation: StoredDoubtAnnotation
    try {
      storedAnnotation =
        viewerSource.kind === 'homework' && selectedHomework && activeKnowledgeCourseId
          ? await saveKnowledgeHomeworkAnnotation(
              activeKnowledgeCourseId,
              currentFolderType,
              selectedHomework.id,
              annotation,
            )
          : knowledgeFileId
            ? await saveKnowledgeAnnotation(knowledgeFileId, annotation)
            : ({ ...annotation, relatedQuestionIds: [] } satisfies StoredDoubtAnnotation)
    } catch (error) {
      console.error('save annotation failed:', error)
      throw error
    }

    if (viewerSource.kind === 'homework' && selectedHomework) {
      setHomeworkDocuments((current) =>
        current.map((document) =>
          document.id === selectedHomework.id
            ? {
                ...document,
                annotations: [
                  storedAnnotation,
                  ...document.annotations.filter((item) => item.id !== storedAnnotation.id),
                ].slice(0, 80),
              }
            : document,
        ),
      )
    } else {
      setAnnotations((current) => {
        const nextAnnotations = [
          storedAnnotation,
          ...current.filter((item) => item.id !== storedAnnotation.id),
        ].slice(0, 80)
        return nextAnnotations
      })
    }
    if (storedAnnotation.pageNumber !== null) {
      setPageFilter(storedAnnotation.pageNumber)
    }
    setSelectedAnnotationId(storedAnnotation.id)
    return storedAnnotation
  }

  const handleZoom = (nextZoom: number) => {
    setZoom(Math.min(1, Math.max(0.75, nextZoom)))
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

    setSearchParams(
      {
        course: courseId,
        folder: card.documentType === 'past-exam' ? 'past-exam' : 'homework',
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
    const hasQuestionContext = documentText.trim() || selectedHomework?.extractedMarkdown.trim()
    if (!normalizedQuestion || isAsking || !hasQuestionContext) {
      return
    }

    let activeAnnotationId = selectedAnnotationId
    let activeAnnotationPage = pageFilter ?? currentPage
    let activeAnnotationRecord = selectedAnnotation
    const autoDraft =
      !activeAnnotationId && !draftDoubt
        ? createDraftDoubt(pageFilter ?? currentPage)
        : null

    if (!activeAnnotationId && (draftDoubt || autoDraft)) {
      setIsSavingDoubt(true)
      try {
        const storedAnnotation = await persistDoubtRecord(
          normalizedQuestion,
          draftDoubt ?? autoDraft,
        )
        if (!storedAnnotation) {
          setIsSavingDoubt(false)
          return
        }

        activeAnnotationId = storedAnnotation.id
        activeAnnotationPage = storedAnnotation.pageNumber ?? currentPage
        activeAnnotationRecord = storedAnnotation
        setDraftDoubt(null)
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建疑点失败'
        setChatMessages((current) => [
          ...current,
          createMessage('system', `创建疑点失败：${message}`),
        ])
        setIsSavingDoubt(false)
        return
      } finally {
        setIsSavingDoubt(false)
      }
    }

    if (!activeAnnotationId) {
      return
    }

    const legacyConversation = activeAnnotationRecord?.relatedQuestionIds.length
      ? buildAnnotationConversation(activeAnnotationRecord, chatMessages)
      : []
    const baseChatSession = normalizeDoubtChatSession(
      activeAnnotationRecord?.chatSession,
      activeAnnotationId,
      legacyConversation,
    )
    const persistActiveChatSession = (nextSession: DoubtChatSession) => {
      const updatedAt = new Date().toISOString()
      if (viewerSource.kind === 'homework' && selectedHomework && activeKnowledgeCourseId) {
        setHomeworkDocuments((current) =>
          current.map((document) =>
            document.id === selectedHomework.id
              ? {
                  ...document,
                  annotations: document.annotations.map((annotation) =>
                    annotation.id === activeAnnotationId
                      ? { ...annotation, chatSession: nextSession, updatedAt }
                      : annotation,
                  ),
                  updatedAt,
                }
              : document,
          ),
        )
        saveKnowledgeHomeworkAnnotationChatSession(
          activeKnowledgeCourseId,
          currentFolderType,
          selectedHomework.id,
          activeAnnotationId,
          nextSession,
        )
        return
      }

      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === activeAnnotationId
            ? { ...annotation, chatSession: nextSession, updatedAt }
            : annotation,
        ),
      )
      if (knowledgeFileId) {
        saveKnowledgeAnnotationChatSession(
          knowledgeFileId,
          activeAnnotationId,
          nextSession,
        )
      }
    }

    const userMessage = createMessage('user', normalizedQuestion)
    const attachmentSummary = composerAttachments.length
      ? `\n\n附件：${composerAttachments.map((attachment) => attachment.name).join('、')}`
      : ''
    const visibleUserMessage = {
      ...userMessage,
      content: `${normalizedQuestion}${attachmentSummary}`,
    }
    setChatMessages((current) => [...current, visibleUserMessage])
    setQuestionInput('')
    setIsAsking(true)
    setIsCaptureMode(false)
    clearStreamTimer()
    streamBufferRef.current = ''

    const assistantMessageId = crypto.randomUUID()
    const pendingAssistantMessage: ChatMessage = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
    }
    setChatMessages((current) => [
      ...current,
      pendingAssistantMessage,
    ])
    let workingChatSession = appendDoubtChatMessages(
      baseChatSession,
      [visibleUserMessage, pendingAssistantMessage],
    )
    persistActiveChatSession(workingChatSession)

    if (viewerSource.kind === 'homework' && selectedHomework && activeKnowledgeCourseId) {
      linkQuestionToHomeworkAnnotation(
        activeKnowledgeCourseId,
        currentFolderType,
        selectedHomework.id,
        activeAnnotationId,
        visibleUserMessage.id,
      )
    } else if (knowledgeFileId) {
      linkQuestionToAnnotation(knowledgeFileId, activeAnnotationId, visibleUserMessage.id)
    }
    if (viewerSource.kind === 'homework' && selectedHomework) {
      setHomeworkDocuments((current) =>
        current.map((document) =>
          document.id === selectedHomework.id
            ? {
                ...document,
                annotations: appendRelatedQuestionId(
                  document.annotations,
                  activeAnnotationId,
                  visibleUserMessage.id,
                ),
              }
            : document,
        ),
      )
    } else {
      setAnnotations((current) =>
        appendRelatedQuestionId(current, activeAnnotationId, visibleUserMessage.id),
      )
    }

    const explicitReferenceContext = composerAttachments
      .filter((attachment) => attachment.blockReference && attachment.contentText)
      .map((attachment) => attachment.contentText)
      .join('\n\n')
    const documentAttachmentContext = composerAttachments
      .filter(
        (attachment) => !attachment.blockReference &&
          (attachment.kind === 'document' || attachment.kind === 'text') && attachment.contentText,
      )
      .map((attachment) => `附件文档《${attachment.name}》：\n${attachment.contentText}`)
      .join('\n\n')
    const currentPageContext = buildStructuredPageContext(
      currentViewerStructuredBlocks,
      activeAnnotationPage,
      currentViewerName,
    )
    const completeDocumentContext = viewerSource.kind === 'homework'
      ? selectedHomework?.extractedMarkdown ?? ''
      : documentText
    const questionSourceContext: PromptSourceSection[] = [
      {
        id: 'current-page',
        title: `当前查看的第 ${activeAnnotationPage} 页`,
        content: currentPageContext,
        priority: 100,
        trimMode: 'head-tail',
      },
      {
        id: 'explicit-references',
        title: '用户显式选择的引用',
        content: explicitReferenceContext,
        priority: 95,
        trimMode: 'head-tail',
      },
      {
        id: 'current-homework-question',
        title: '当前练习题',
        content: activeHomeworkContextMarkdown,
        priority: 90,
        trimMode: 'head-tail',
      },
      {
        id: 'uploaded-attachments',
        title: '本次提问附件',
        content: documentAttachmentContext,
        priority: 85,
        trimMode: 'head-tail',
      },
      {
        id: 'complete-document',
        title: '完整文档补充上下文',
        content: completeDocumentContext,
        priority: currentPageContext ? 10 : 60,
        trimMode: 'head-tail',
      },
    ]
    const imageAttachments = composerAttachments
      .filter((attachment) => attachment.kind === 'image' && attachment.dataUrl)
      .map((attachment) => ({
        name: attachment.name,
        dataUrl: attachment.dataUrl!,
      }))

    let memoryContextSession = baseChatSession
    if (shouldCompactDoubtChatSession(baseChatSession, apiConfig, apiConfig.doubtModel)) {
      try {
        const memorySummary = await summarizeChatMemoryWithConfiguredApi(
          buildDoubtChatContext(baseChatSession, Number.MAX_SAFE_INTEGER),
          apiConfig,
        )
        if (memorySummary) {
          memoryContextSession = commitDoubtChatSummary(baseChatSession, memorySummary)
          workingChatSession = appendDoubtChatMessages(
            memoryContextSession,
            [visibleUserMessage, pendingAssistantMessage],
          )
          persistActiveChatSession(workingChatSession)
        }
      } catch (error) {
        console.warn('chat memory compaction failed; continuing with recent history:', error)
      }
    }
    const conversationHistory = buildDoubtChatContext(memoryContextSession)

    try {
      const result = await askWithConfiguredVisionApi(
        `请继续围绕第 ${activeAnnotationPage} 页的当前疑点回答：${normalizedQuestion}${attachmentSummary}`,
        questionSourceContext,
        apiConfig,
        imageAttachments,
        {
          onToken: (chunk) => {
            streamBufferRef.current += chunk
            if (streamTimerRef.current === null) {
              flushStreamBuffer(assistantMessageId)
            }
          },
        },
        apiConfig.doubtModel,
        conversationHistory,
      )

      workingChatSession = updateDoubtChatMessage(
        workingChatSession,
        assistantMessageId,
        result.answer,
      )
      persistActiveChatSession(workingChatSession)

      startTransition(() => {
        clearStreamTimer()
        streamBufferRef.current = ''
        setChatMessages((current) =>
          updateMessageContent(current, assistantMessageId, () => result.answer),
        )
        setIsAsking(false)
        setComposerAttachments([])
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : '提问失败'
      const failureContent = `1. 当前无法完成回答。\n2. ${message}\n3. 请检查 API 配置、网络或模型能力后重试。`
      workingChatSession = updateDoubtChatMessage(
        workingChatSession,
        assistantMessageId,
        failureContent,
      )
      persistActiveChatSession(workingChatSession)
      startTransition(() => {
        clearStreamTimer()
        streamBufferRef.current = ''
        setChatMessages((current) =>
          updateMessageContent(
            current,
            assistantMessageId,
            () => failureContent,
          ),
        )
        setIsAsking(false)
      })
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
    window.dispatchEvent(
      new CustomEvent('student-platform:lesson-recording-state', {
        detail: { isRecording: isLessonRecording },
      }),
    )
  }, [isLessonRecording])

  useEffect(() => {
    const handleToggle = (event: Event) => {
      const customEvent = event as CustomEvent<{ nextRecording?: boolean }>
      if (customEvent.detail?.nextRecording) {
        void startLessonRecording()
      } else {
        void stopLessonRecording()
      }
    }

    const handleAudioUpload = () => {
      lessonAudioUploadInputRef.current?.click()
    }

    const handleTranscriptUpload = () => {
      lessonTranscriptUploadInputRef.current?.click()
    }

    window.addEventListener('student-platform:lesson-recording-toggle', handleToggle)
    window.addEventListener('student-platform:lesson-audio-upload', handleAudioUpload)
    window.addEventListener('student-platform:lesson-transcript-upload', handleTranscriptUpload)
    return () => {
      window.removeEventListener('student-platform:lesson-recording-toggle', handleToggle)
      window.removeEventListener('student-platform:lesson-audio-upload', handleAudioUpload)
      window.removeEventListener('student-platform:lesson-transcript-upload', handleTranscriptUpload)
      lessonStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [currentDocumentText, currentKnowledgeFileId, startLessonRecording, stopLessonRecording])

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
      <section
        ref={readerGridRef}
        className="pdf-workspace__reader-grid"
        style={
          {
            '--reader-left-width': `${leftPanelWidth}px`,
            '--reader-right-width': `${rightPanelWidth}px`,
          } as React.CSSProperties
        }
        >
          <aside className="pdf-workspace__homework pdf-workspace__homework--fixed">
            <RelatedMaterialsPanel
              mode={viewerSource.kind === 'lecture' ? 'lecture' : 'question'}
              currentPage={currentPage}
              currentQuestionTitle={selectedHomeworkQuestion?.title ?? null}
              cards={relatedMaterialCards}
              isLoading={isLoadingRelatedMaterials}
              onOpenCard={handleOpenRelatedMaterial}
            />
          </aside>

        <button
          type="button"
          className="panel-resizer panel-resizer--left"
          aria-label="调整关联资料宽度"
          onPointerDown={(event) => {
            activeResizeRef.current = {
              side: 'left',
              startX: event.clientX,
              startWidth: leftPanelWidth,
            }
            document.body.classList.add('is-resizing-panels')
          }}
        />

        <div className="pdf-workspace__viewer">
          <PdfPreviewCanvas
            fileName={currentViewerName}
            pdfController={currentViewerController}
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
            playingLecturePage={playingLecturePage}
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
          />
        </div>

        <button
          type="button"
          className="panel-resizer panel-resizer--right"
          aria-label="调整 AI 对话宽度"
          onPointerDown={(event) => {
            activeResizeRef.current = {
              side: 'right',
              startX: event.clientX,
              startWidth: rightPanelWidth,
            }
            document.body.classList.add('is-resizing-panels')
          }}
        />

        <ChatPanel
          messages={visibleConversationMessages}
          isAsking={isAsking}
          latestAssistantMessageId={latestAssistantMessageId}
          messagesContainerRef={messagesContainerRef}
          composerAttachments={composerAttachments}
          onRemoveAttachment={removeComposerAttachment}
          questionInput={questionInput}
          currentPage={currentPage}
          pageFilter={pageFilter}
          pageAnnotations={pageFilter === null ? [] : visibleAnnotations}
          draftDoubt={draftDoubt}
          selectedAnnotation={selectedAnnotation}
          onCreateDoubt={() => {
            setDraftDoubt(createDraftDoubt(pageFilter ?? currentPage))
            setSelectedAnnotationId(null)
            setQuestionInput('')
            setComposerAttachments([])
            setIsCaptureMode(false)
          }}
          onSelectAnnotation={handleSelectAnnotation}
          onQuestionInputChange={setQuestionInput}
          onQuestionInputKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void runQuestion()
            }
          }}
          onToggleCapture={() => void handleCaptureFromClipboard()}
          onOpenUpload={() => chatUploadInputRef.current?.click()}
          availableModels={availableDoubtModels}
          activeModel={apiConfig.doubtModel}
          onModelChange={handleModelChange}
          onSend={() => void runQuestion()}
          isSavingDoubt={isSavingDoubt}
          canSend={!(isAsking || isSavingDoubt || !questionInput.trim() || !documentText.trim())}
        />
      </section>
      {isLectureViewer && activeLecturePlayer ? (
        <section
          className={`lecture-player ${isLecturePlayerMinimized ? 'is-minimized' : ''}`}
          aria-label={`第 ${activeLecturePlayer.pageNumber} 页课堂讲解播放器`}
          style={
            lecturePlayerPosition
              ? {
                  left: `${lecturePlayerPosition.left}px`,
                  top: `${lecturePlayerPosition.top}px`,
                  right: 'auto',
                  bottom: 'auto',
                }
              : undefined
          }
        >
          {isLecturePlayerMinimized ? (
            <div className="lecture-player__compact-shell">
              <button
                type="button"
                className="lecture-player__drag-handle"
                onPointerDown={handleLecturePlayerDragStart}
                onPointerMove={handleLecturePlayerDragMove}
                onPointerUp={handleLecturePlayerDragEnd}
                onPointerCancel={handleLecturePlayerDragEnd}
                aria-label="拖动课堂讲解播放器"
                title="拖动播放器"
              >
                ⠿
              </button>
              <button
                type="button"
                className="lecture-player__compact"
                onClick={() => setIsLecturePlayerMinimized(false)}
                title="展开课堂讲解播放器"
              >
                <span className={`lecture-player__pulse ${playingLecturePage ? 'is-playing' : ''}`} />
                <span>第 {activeLecturePlayer.pageNumber} 页</span>
                <strong>
                  {formatPlaybackTime(
                    Math.max(
                      0,
                      (lecturePlaybackSeconds ?? activeLecturePlayer.startSeconds) -
                        activeLecturePlayer.startSeconds,
                    ),
                  )}
                </strong>
              </button>
            </div>
          ) : (
            <>
              <div className="lecture-player__header">
                <button
                  type="button"
                  className="lecture-player__drag-handle"
                  onPointerDown={handleLecturePlayerDragStart}
                  onPointerMove={handleLecturePlayerDragMove}
                  onPointerUp={handleLecturePlayerDragEnd}
                  onPointerCancel={handleLecturePlayerDragEnd}
                  aria-label="拖动课堂讲解播放器"
                  title="拖动播放器"
                >
                  ⠿
                </button>
                <div>
                  <span>课堂讲解</span>
                  <strong>第 {activeLecturePlayer.pageNumber} 页</strong>
                </div>
                <button
                  type="button"
                  className="lecture-player__minimize"
                  onClick={() => setIsLecturePlayerMinimized(true)}
                  aria-label="最小化课堂讲解播放器"
                  title="最小化"
                >
                  −
                </button>
              </div>
              <div className="lecture-player__progress">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(
                        0,
                        ((lecturePlaybackSeconds ?? activeLecturePlayer.startSeconds) -
                          activeLecturePlayer.startSeconds) /
                          (activeLecturePlayer.endSeconds - activeLecturePlayer.startSeconds) *
                          100,
                      ),
                    )}%`,
                  }}
                />
                <input
                  className="lecture-player__seek"
                  type="range"
                  min={activeLecturePlayer.startSeconds}
                  max={activeLecturePlayer.endSeconds}
                  step="0.1"
                  value={Math.min(
                    activeLecturePlayer.endSeconds,
                    Math.max(
                      activeLecturePlayer.startSeconds,
                      lecturePlaybackSeconds ?? activeLecturePlayer.startSeconds,
                    ),
                  )}
                  onChange={(event) => handleSeekLecturePlayback(Number(event.currentTarget.value))}
                  aria-label="课堂讲解播放进度"
                />
              </div>
              <div className="lecture-player__time">
                <span>
                  {formatPlaybackTime(
                    Math.max(
                      0,
                      (lecturePlaybackSeconds ?? activeLecturePlayer.startSeconds) -
                        activeLecturePlayer.startSeconds,
                    ),
                  )}
                </span>
                <span>
                  {formatPlaybackTime(activeLecturePlayer.endSeconds - activeLecturePlayer.startSeconds)}
                </span>
              </div>
              <div className="lecture-player__controls">
                <button
                  type="button"
                  className="lecture-player__stop"
                  onClick={handleStopLecturePlayback}
                  aria-label="停止课堂讲解"
                  title="停止并关闭播放器"
                >
                  <span />
                </button>
                <button
                  type="button"
                  className="lecture-player__skip"
                  onClick={() => handleSkipLecturePlayback(-10)}
                  aria-label="后退 10 秒"
                  title="后退 10 秒"
                >
                  -10s
                </button>
                <button
                  type="button"
                  className="lecture-player__play"
                  onClick={handleToggleLecturePlayback}
                >
                  {playingLecturePage === activeLecturePlayer.pageNumber ? '暂停' : '继续播放'}
                </button>
                <button
                  type="button"
                  className="lecture-player__skip"
                  onClick={() => handleSkipLecturePlayback(10)}
                  aria-label="快进 10 秒"
                  title="快进 10 秒"
                >
                  +10s
                </button>
                <div className="lecture-player__rates" aria-label="播放速度">
                  {[1, 1.25, 1.5, 2].map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      className={lecturePlaybackRate === rate ? 'is-active' : ''}
                      onClick={() => handleLecturePlaybackRateChange(rate)}
                    >
                      {rate}x
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}
    </main>
  )
}

