import type {
  ClassroomLectureSegment,
  ClassroomSession,
  ChatMessage,
  DoubtAnnotation,
  DoubtChatSession,
  HomeworkDocument,
  HomeworkKnowledgeLink,
  HomeworkQuestion,
  KnowledgeCourse,
  KnowledgeHomeworkFolder,
  KnowledgeHomeworkFolderType,
  KnowledgeLibraryFolderType,
  KnowledgeFile,
  KnowledgeLibrary,
  StructuredDocumentBlock,
  StoredDoubtAnnotation,
} from '../types'
import { resolveBackendApiUrl } from './apiConfig'
import { normalizeDoubtChatSession } from './chatMemory'
import {
  createKnowledgeCourseRecord,
  findKnowledgeCourseByInput,
  findKnowledgeCourseByName as findKnowledgeCourseByStoredName,
  getKnowledgeCourseDisplayName,
  normalizeKnowledgeCourse,
  normalizeKnowledgeCourseInput,
  planKnowledgeCourseSync,
  type KnowledgeCourseInput,
} from './knowledgeBaseCourses'
import { notifyCoursewareAutoSyncDeletion } from '../features/knowledge-library/coursewareSyncEvents'

const DEFAULT_COURSE_ID = 'general-course'
const DEFAULT_COURSE_NAME = '未分类课程'
const HOMEWORK_FOLDER_ORDER: KnowledgeHomeworkFolderType[] = ['homework', 'past-exam']
const HOMEWORK_FOLDER_NAMES: Record<KnowledgeHomeworkFolderType, string> = {
  homework: '作业题',
  'past-exam': '往年题',
}
export const KNOWLEDGE_LIBRARY_UPDATED_EVENT = 'student-platform:knowledge-base-updated'

let knowledgeLibraryCache: KnowledgeLibrary = {
  files: [],
  courses: [buildDefaultCourse()],
}
let knowledgeLibraryHydrationPromise: Promise<KnowledgeLibrary> | null = null
let knowledgeLibraryPersistPromise: Promise<void> = Promise.resolve()
const deletedKnowledgeFileIds = new Set<string>()

function normalizeCourseInput(input: KnowledgeCourseInput) {
  return normalizeKnowledgeCourseInput(input)
}

function findCourseByInput(input: KnowledgeCourseInput) {
  return findKnowledgeCourseByInput(loadKnowledgeLibrary().courses, input)
}

function buildDefaultCourse(now = new Date().toISOString()): KnowledgeCourse {
  return {
    id: DEFAULT_COURSE_ID,
    name: DEFAULT_COURSE_NAME,
    source: 'manual',
    semesterId: null,
    semesterName: null,
    courseCode: null,
    wlkcid: null,
    homeworkFolders: HOMEWORK_FOLDER_ORDER.map((folderType) =>
      buildDefaultHomeworkFolder(DEFAULT_COURSE_ID, folderType, now),
    ),
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeHomeworkFolderType(
  value: unknown,
  folderName = '',
): KnowledgeHomeworkFolderType {
  if (value === 'past-exam' || /往年/.test(folderName)) {
    return 'past-exam'
  }
  return 'homework'
}

function buildDefaultHomeworkFolder(
  courseId: string,
  folderType: KnowledgeHomeworkFolderType,
  now = new Date().toISOString(),
): KnowledgeHomeworkFolder {
  return {
    id: `${courseId}:${folderType}`,
    courseId,
    folderType,
    name: HOMEWORK_FOLDER_NAMES[folderType],
    homeworkDocuments: [],
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeHomeworkFolder(
  folder: Partial<KnowledgeHomeworkFolder>,
  courseId: string,
  folderType?: KnowledgeHomeworkFolderType,
): KnowledgeHomeworkFolder {
  const now = new Date().toISOString()
  const resolvedFolderType = normalizeHomeworkFolderType(
    folderType ?? folder.folderType,
    String(folder.name || ''),
  )

  return {
    id: folder.id ?? `${courseId}:${resolvedFolderType}`,
    courseId,
    folderType: resolvedFolderType,
    name:
      String(folder.name || HOMEWORK_FOLDER_NAMES[resolvedFolderType]).trim() ||
      HOMEWORK_FOLDER_NAMES[resolvedFolderType],
    homeworkDocuments: dedupeHomeworkDocuments(
      (Array.isArray(folder.homeworkDocuments) ? folder.homeworkDocuments : []).map((document) =>
        normalizeHomeworkDocument(document as Partial<HomeworkDocument>),
      ),
    ),
    createdAt: folder.createdAt ?? now,
    updatedAt: folder.updatedAt ?? folder.createdAt ?? now,
  }
}

function normalizeCourseHomeworkFolders(
  course: KnowledgeCourse,
  legacyHomeworkDocuments: HomeworkDocument[] = [],
): KnowledgeCourse {
  const folderMap = new Map<KnowledgeHomeworkFolderType, KnowledgeHomeworkFolder>()
  const existingFolders =
    (course as Partial<KnowledgeCourse> & { homeworkFolders?: KnowledgeHomeworkFolder[] })
      .homeworkFolders ?? []

  existingFolders.forEach((folder) => {
    const normalized = normalizeHomeworkFolder(folder, course.id)
    const current = folderMap.get(normalized.folderType)
    if (!current) {
      folderMap.set(normalized.folderType, normalized)
      return
    }

    folderMap.set(normalized.folderType, {
      ...current,
      homeworkDocuments: dedupeHomeworkDocuments([
        ...current.homeworkDocuments,
        ...normalized.homeworkDocuments,
      ]),
      updatedAt:
        new Date(normalized.updatedAt).getTime() >= new Date(current.updatedAt).getTime()
          ? normalized.updatedAt
          : current.updatedAt,
    })
  })

  HOMEWORK_FOLDER_ORDER.forEach((folderType) => {
    if (!folderMap.has(folderType)) {
      folderMap.set(folderType, buildDefaultHomeworkFolder(course.id, folderType, course.updatedAt))
    }
  })

  if (legacyHomeworkDocuments.length) {
    const homeworkFolder = folderMap.get('homework')
    if (homeworkFolder) {
      folderMap.set('homework', {
        ...homeworkFolder,
        homeworkDocuments: dedupeHomeworkDocuments([
          ...homeworkFolder.homeworkDocuments,
          ...legacyHomeworkDocuments,
        ]),
        updatedAt: new Date().toISOString(),
      })
    }
  }

  return {
    ...course,
    homeworkFolders: HOMEWORK_FOLDER_ORDER.map(
      (folderType) => folderMap.get(folderType) ?? buildDefaultHomeworkFolder(course.id, folderType),
    ),
  }
}

function sortFiles(files: KnowledgeFile[]) {
  return [...files].sort(
    (left, right) =>
      new Date(right.lastOpenedAt).getTime() - new Date(left.lastOpenedAt).getTime(),
  )
}

function sortCourses(courses: KnowledgeCourse[]) {
  return [...courses].sort((left, right) =>
    getKnowledgeCourseDisplayName(left).localeCompare(getKnowledgeCourseDisplayName(right), 'zh-CN'),
  )
}

function dedupeHomeworkDocuments(documents: HomeworkDocument[]) {
  const deduped = new Map<string, HomeworkDocument>()

  documents.forEach((document) => {
    const key = `${document.fileName}::${document.byteSize}::${document.sourceType}`
    const existing = deduped.get(key)
    if (!existing) {
      deduped.set(key, document)
      return
    }

    const existingUpdated = new Date(existing.updatedAt).getTime()
    const currentUpdated = new Date(document.updatedAt).getTime()
    const shouldReplace =
      document.questions.length > existing.questions.length ||
      currentUpdated >= existingUpdated

    if (shouldReplace) {
      deduped.set(key, document)
    }
  })

  return Array.from(deduped.values()).sort(
    (left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
  )
}

function buildSourceKey(fileName: string, byteSize: number) {
  return `${fileName.toLowerCase()}::${byteSize}`
}

function buildAnnotationMarkdown(annotations: StoredDoubtAnnotation[]) {
  if (!annotations.length) {
    return '## 疑点记录\n\n- 暂无已保存疑点。'
  }

  return [
    '## 疑点记录',
    '',
    ...annotations.flatMap((annotation, index) => {
      const lines = [
        `### 疑点 ${index + 1}`,
        `- 页码：${annotation.pageNumber ?? '未指定'}`,
        `- 问题：${annotation.question}`,
      ]

      if (annotation.imageName) {
        lines.push(`- 图片：${annotation.imageName}`)
      }

      return [...lines, '']
    }),
  ]
    .join('\n')
    .trim()
}

function normalizeClassroomSegment(segment: Partial<ClassroomLectureSegment>): ClassroomLectureSegment {
  const now = new Date().toISOString()
  return {
    id: segment.id ?? crypto.randomUUID(),
    recordingId:
      typeof segment.recordingId === 'string' && segment.recordingId.trim()
        ? segment.recordingId.trim()
        : null,
    title: String(segment.title || '课堂讲解片段').trim() || '课堂讲解片段',
    summary: String(segment.summary || '').trim(),
    polishedText: String(segment.polishedText || '').trim(),
    anchorText:
      typeof segment.anchorText === 'string' && segment.anchorText.trim()
        ? segment.anchorText.trim()
        : null,
    pageNumbers: Array.isArray(segment.pageNumbers)
      ? Array.from(
          new Set(
            segment.pageNumbers
              .map((pageNumber) => Number(pageNumber))
              .filter((pageNumber) => Number.isFinite(pageNumber) && pageNumber > 0),
          ),
        )
      : [],
    startSeconds:
      typeof segment.startSeconds === 'number' && Number.isFinite(segment.startSeconds)
        ? segment.startSeconds
        : null,
    endSeconds:
      typeof segment.endSeconds === 'number' && Number.isFinite(segment.endSeconds)
        ? segment.endSeconds
        : null,
    sourceSentenceIds: Array.isArray(segment.sourceSentenceIds)
      ? Array.from(
          new Set(
            segment.sourceSentenceIds
              .map((sentenceId) => String(sentenceId || '').trim())
              .filter(Boolean),
          ),
        )
      : [],
    createdAt: segment.createdAt ?? now,
  }
}

function normalizeClassroomSession(session: Partial<ClassroomSession>): ClassroomSession {
  const now = new Date().toISOString()
  return {
    id: session.id ?? crypto.randomUUID(),
    transcript: String(session.transcript || '').trim(),
    polishedOverview: String(session.polishedOverview || '').trim(),
    segments: Array.isArray(session.segments)
      ? session.segments.map((segment) =>
          normalizeClassroomSegment({
            ...(segment as Partial<ClassroomLectureSegment>),
            recordingId:
              typeof (segment as Partial<ClassroomLectureSegment>).recordingId === 'undefined'
                ? session.id
                : (segment as Partial<ClassroomLectureSegment>).recordingId,
          }),
        )
      : [],
    createdAt: session.createdAt ?? now,
    updatedAt: session.updatedAt ?? session.createdAt ?? now,
  }
}

function normalizeHomeworkQuestion(
  question: Partial<HomeworkQuestion>,
  homeworkDocumentId: string,
  index: number,
): HomeworkQuestion {
  const normalizedContent = String(question.content || question.title || '').trim()

  return {
    id: question.id ?? crypto.randomUUID(),
    homeworkDocumentId,
    index: Number.isFinite(question.index) ? Number(question.index) : index,
    title: String(question.title || `第 ${index + 1} 题`).trim() || `第 ${index + 1} 题`,
    content: normalizedContent,
    pageNumber:
      typeof question.pageNumber === 'number' && Number.isFinite(question.pageNumber)
        ? question.pageNumber
        : null,
    anchorText:
      typeof question.anchorText === 'string' && question.anchorText.trim()
        ? question.anchorText.trim()
        : null,
    analysis: question.analysis ?? null,
  }
}

function normalizeStructuredDocumentBlocks(blocks: unknown): StructuredDocumentBlock[] {
  if (!Array.isArray(blocks)) {
    return []
  }

  const resolvePageNumber = (partial: Record<string, unknown>) => {
    for (const key of ['pageNumber', 'page_number', 'page', 'pageNo']) {
      const value = Number(partial[key])
      if (Number.isFinite(value) && value >= 1) {
        return value
      }
    }

    for (const key of ['page_idx', 'pageIndex', 'page_index']) {
      const value = Number(partial[key])
      if (Number.isFinite(value) && value >= 0) {
        return value + 1
      }
    }

    return null
  }

  return blocks
    .map((block, index) => {
      if (!block || typeof block !== 'object') {
        return null
      }

      const partial = block as Partial<StructuredDocumentBlock> & { bbox?: unknown }
      const rawBbox = Array.isArray(partial.bbox) ? partial.bbox : []
      const bbox = rawBbox
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .slice(0, 4)
      if (bbox.length !== 4) {
        return null
      }

      const pageNumber =
        resolvePageNumber(partial as Record<string, unknown>) ?? null
      if (!pageNumber) {
        return null
      }

      const rawKind = String(partial.kind || '').trim()
      const kind =
        rawKind === 'equation' ||
        rawKind === 'interline_equation' ||
        rawKind === 'inline_equation'
          ? 'formula'
          : rawKind === 'formula' ||
              rawKind === 'image' ||
              rawKind === 'table' ||
              rawKind === 'title' ||
              rawKind === 'unknown'
            ? rawKind
            : 'text'

      return {
        id:
          typeof partial.id === 'string' && partial.id.trim()
            ? partial.id.trim()
            : crypto.randomUUID(),
        pageNumber,
        kind,
        label:
          typeof partial.label === 'string' && partial.label.trim()
            ? partial.label.trim()
            : `第 ${pageNumber} 页区域 ${index + 1}`,
        text: typeof partial.text === 'string' ? partial.text.trim() : '',
        bbox: [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!],
        ...(partial.coordinateSpace === 'pdf-page' ? { coordinateSpace: 'pdf-page' as const } : {}),
        source: partial.source === 'pdfjs-fallback' ? 'pdfjs-fallback' : 'mineru-local',
      } satisfies StructuredDocumentBlock
    })
    .filter((block): block is StructuredDocumentBlock => block !== null)
}

function normalizeHomeworkDocument(document: Partial<HomeworkDocument>): HomeworkDocument {
  const now = new Date().toISOString()
  const documentId = document.id ?? crypto.randomUUID()
  const annotations = (Array.isArray(document.annotations) ? document.annotations : []).map(
    (annotation) => {
      const legacyAnnotation = annotation as StoredDoubtAnnotation & { text?: string }
      const normalizedQuestion =
        typeof annotation.question === 'string'
          ? annotation.question
          : typeof legacyAnnotation.text === 'string'
            ? legacyAnnotation.text
            : ''

      return {
        id: annotation.id ?? crypto.randomUUID(),
        pageNumber: annotation.pageNumber ?? null,
        question: normalizedQuestion,
        imageAssetId: annotation.imageAssetId ?? null,
        imageName: annotation.imageName ?? null,
        createdAt: annotation.createdAt ?? now,
        updatedAt: annotation.updatedAt ?? annotation.createdAt ?? now,
        relatedQuestionIds: Array.isArray(annotation.relatedQuestionIds)
          ? annotation.relatedQuestionIds
          : [],
        ...(annotation.chatSession
          ? { chatSession: normalizeDoubtChatSession(annotation.chatSession, annotation.id ?? '') }
          : {}),
      } satisfies StoredDoubtAnnotation
    },
  )
  const questions = (Array.isArray(document.questions) ? document.questions : [])
    .map((question, index) =>
      normalizeHomeworkQuestion(question as Partial<HomeworkQuestion>, documentId, index),
    )
    .filter((question) => question.content.trim())
  const knowledgeLinks = (Array.isArray(document.knowledgeLinks) ? document.knowledgeLinks : [])
    .map((link) => {
      const partial = link as Partial<HomeworkKnowledgeLink>
      return {
        id: partial.id ?? crypto.randomUUID(),
        homeworkDocumentId: partial.homeworkDocumentId ?? documentId,
        lectureDocumentId:
          typeof partial.lectureDocumentId === 'string' && partial.lectureDocumentId.trim()
            ? partial.lectureDocumentId.trim()
            : null,
        questionId: String(partial.questionId || '').trim(),
        questionTitle:
          typeof partial.questionTitle === 'string' && partial.questionTitle.trim()
            ? partial.questionTitle.trim()
            : null,
        questionIndex:
          typeof partial.questionIndex === 'number' && Number.isFinite(partial.questionIndex)
            ? partial.questionIndex
            : null,
        conceptTitle: String(partial.conceptTitle || '').trim(),
        lecturePageNumber:
          typeof partial.lecturePageNumber === 'number' && Number.isFinite(partial.lecturePageNumber)
            ? partial.lecturePageNumber
            : null,
        lectureAnchorText: String(partial.lectureAnchorText || '').trim(),
        lectureSnippet:
          typeof partial.lectureSnippet === 'string' && partial.lectureSnippet.trim()
            ? partial.lectureSnippet.trim()
            : null,
      } satisfies HomeworkKnowledgeLink
    })
    .filter((link) => link.questionId && link.conceptTitle && link.lectureAnchorText)

  return {
    id: documentId,
    lectureDocumentId:
      typeof document.lectureDocumentId === 'string' && document.lectureDocumentId.trim()
        ? document.lectureDocumentId.trim()
        : null,
    assetId: document.assetId ?? null,
    fileName: String(document.fileName || '未命名练习').trim() || '未命名练习',
    sourceType: document.sourceType === 'image' ? 'image' : 'pdf',
    mimeType: String(document.mimeType || '').trim(),
    byteSize: typeof document.byteSize === 'number' ? document.byteSize : 0,
    pageCount: typeof document.pageCount === 'number' ? document.pageCount : null,
    status:
      document.status === 'processing' || document.status === 'error' ? document.status : 'ready',
    pipelineStatus: typeof document.pipelineStatus === 'string' ? document.pipelineStatus : null,
    parserStatus: typeof document.parserStatus === 'string' ? document.parserStatus : null,
    extractionStatus: typeof document.extractionStatus === 'string' ? document.extractionStatus : null,
    analysisStatus: typeof document.analysisStatus === 'string' ? document.analysisStatus : null,
    embeddingStatus: typeof document.embeddingStatus === 'string' ? document.embeddingStatus : null,
    vectorStatus: typeof document.vectorStatus === 'string' ? document.vectorStatus : null,
    embeddingCompletedQuestions: Math.max(0, Number(document.embeddingCompletedQuestions || 0)),
    vectorCompletedQuestions: Math.max(0, Number(document.vectorCompletedQuestions || 0)),
    extractor: 'mineru',
    extractedMarkdown: String(document.extractedMarkdown || ''),
    layoutBlocks: normalizeStructuredDocumentBlocks(document.layoutBlocks),
    questions,
    knowledgeLinks,
    annotations,
    errorMessage: document.errorMessage ? String(document.errorMessage) : null,
    createdAt: document.createdAt ?? now,
    updatedAt: document.updatedAt ?? document.createdAt ?? now,
  }
}

function normalizeCourse(course: Partial<KnowledgeCourse>): KnowledgeCourse {
  return normalizeKnowledgeCourse(course)
}

function normalizeLibraryCourses(
  courses: unknown[],
  legacyHomeworkDocumentsByCourseId = new Map<string, HomeworkDocument[]>(),
): KnowledgeCourse[] {
  const now = new Date().toISOString()
  const normalized = Array.isArray(courses)
    ? courses.map((course) => normalizeCourse(course as Partial<KnowledgeCourse>))
    : []

  if (!normalized.some((course) => course.id === DEFAULT_COURSE_ID)) {
    normalized.unshift(buildDefaultCourse(now))
  }

  return sortCourses(
    normalized.map((course) =>
      normalizeCourseHomeworkFolders(course, legacyHomeworkDocumentsByCourseId.get(course.id) ?? []),
    ),
  )
}

function normalizeLibraryFile(file: Partial<KnowledgeFile>): KnowledgeFile {
  const annotations = (Array.isArray(file.annotations) ? file.annotations : []).map((annotation) => {
    const legacyAnnotation = annotation as StoredDoubtAnnotation & { text?: string }
    const normalizedQuestion =
      typeof annotation.question === 'string'
        ? annotation.question
        : typeof legacyAnnotation.text === 'string'
          ? legacyAnnotation.text
          : ''

    return {
      id: annotation.id ?? crypto.randomUUID(),
      pageNumber: annotation.pageNumber ?? null,
      question: normalizedQuestion,
      imageAssetId: annotation.imageAssetId ?? null,
      imageName: annotation.imageName ?? null,
      createdAt: annotation.createdAt ?? new Date().toISOString(),
      updatedAt: annotation.updatedAt ?? annotation.createdAt ?? new Date().toISOString(),
      relatedQuestionIds: Array.isArray(annotation.relatedQuestionIds)
        ? annotation.relatedQuestionIds
        : [],
      ...(annotation.chatSession
        ? { chatSession: normalizeDoubtChatSession(annotation.chatSession, annotation.id ?? '') }
        : {}),
    } satisfies StoredDoubtAnnotation
  })
  const homeworkDocuments = (Array.isArray(file.homeworkDocuments) ? file.homeworkDocuments : []).map(
    (document) => normalizeHomeworkDocument(document as Partial<HomeworkDocument>),
  )
  const classroomSessions = Array.isArray(file.classroomSessions)
    ? file.classroomSessions.map((session) =>
        normalizeClassroomSession(session as Partial<ClassroomSession>),
      )
    : []

  return {
    id: file.id ?? crypto.randomUUID(),
    sourceKey: file.sourceKey ?? buildSourceKey(file.fileName ?? 'untitled.pdf', file.byteSize ?? 0),
    courseId: String(file.courseId || DEFAULT_COURSE_ID).trim() || DEFAULT_COURSE_ID,
    fileName: String(file.fileName || '未命名文件').trim() || '未命名文件',
    pageCount: typeof file.pageCount === 'number' ? file.pageCount : 0,
    byteSize: typeof file.byteSize === 'number' ? file.byteSize : 0,
    hasPdfSource: Boolean(file.hasPdfSource),
    markdown: String(file.markdown || ''),
    layoutBlocks: normalizeStructuredDocumentBlocks(file.layoutBlocks),
    annotationMarkdown:
      typeof file.annotationMarkdown === 'string' && file.annotationMarkdown.trim()
        ? file.annotationMarkdown
        : buildAnnotationMarkdown(annotations as StoredDoubtAnnotation[]),
    createdAt: file.createdAt ?? new Date().toISOString(),
    updatedAt: file.updatedAt ?? new Date().toISOString(),
    lastOpenedAt: file.lastOpenedAt ?? new Date().toISOString(),
    annotations,
    chatMessages: Array.isArray(file.chatMessages) ? file.chatMessages : [],
    homeworkDocuments: dedupeHomeworkDocuments(homeworkDocuments),
    classroomSessions,
    libraryFolder: file.libraryFolder === 'other' ? 'other' : 'courseware',
    pipelineStatus: typeof file.pipelineStatus === 'string' ? file.pipelineStatus : null,
    mineruStatus: typeof file.mineruStatus === 'string' ? file.mineruStatus : null,
    embeddingStatus: typeof file.embeddingStatus === 'string' ? file.embeddingStatus : null,
    vectorStatus: typeof file.vectorStatus === 'string' ? file.vectorStatus : null,
    pipelineError: typeof file.pipelineError === 'string' ? file.pipelineError : null,
    chunkCount: typeof file.chunkCount === 'number' && file.chunkCount > 0 ? file.chunkCount : null,
    indexedChunkCount: typeof file.indexedChunkCount === 'number' && file.indexedChunkCount >= 0
      ? file.indexedChunkCount
      : null,
  }
}

function ensureWindow() {
  if (typeof window === 'undefined') {
    throw new Error('当前环境不支持知识库存储')
  }
}

function normalizeKnowledgeLibrary(input?: Partial<KnowledgeLibrary> | null): KnowledgeLibrary {
  const files = Array.isArray(input?.files) ? input.files : []
  const courses = Array.isArray(input?.courses) ? input.courses : []
  const legacyHomeworkDocumentsByCourseId = new Map<string, HomeworkDocument[]>()
  const normalizedFiles = files.map((file) => normalizeLibraryFile(file))

  normalizedFiles.forEach((file) => {
    if (!file.homeworkDocuments.length) {
      return
    }

    const current = legacyHomeworkDocumentsByCourseId.get(file.courseId) ?? []
    legacyHomeworkDocumentsByCourseId.set(file.courseId, [...current, ...file.homeworkDocuments])
  })

  return {
    files: sortFiles(
      normalizedFiles.map((file) =>
        file.homeworkDocuments.length ? { ...file, homeworkDocuments: [] } : file,
      ),
    ),
    courses: normalizeLibraryCourses(courses as unknown[], legacyHomeworkDocumentsByCourseId),
  }
}

function emitKnowledgeLibraryUpdated() {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent(KNOWLEDGE_LIBRARY_UPDATED_EVENT))
}

function setKnowledgeLibraryCache(library: Partial<KnowledgeLibrary> | null | undefined) {
  knowledgeLibraryCache = normalizeKnowledgeLibrary(library)
  emitKnowledgeLibraryUpdated()
  return knowledgeLibraryCache
}

function buildLibrarySnapshot(files: KnowledgeFile[], courses: KnowledgeCourse[]): KnowledgeLibrary {
  return normalizeKnowledgeLibrary({ files, courses })
}

async function readResponseError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => ({}))) as { detail?: string }
  return payload.detail || fallback
}

async function fetchKnowledgeLibraryFromServer() {
  ensureWindow()
  const response = await fetch(resolveBackendApiUrl('/api/knowledge/library'))
  if (!response.ok) {
    throw new Error(await readResponseError(response, `无法加载知识库 (HTTP ${response.status})`))
  }

  const payload = (await response.json().catch(() => ({}))) as Partial<KnowledgeLibrary>
  return setKnowledgeLibraryCache(payload)
}

async function persistKnowledgeLibrary(library: KnowledgeLibrary) {
  ensureWindow()
  const response = await fetch(resolveBackendApiUrl('/api/knowledge/library'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: sortFiles(library.files),
      courses: sortCourses(library.courses),
    }),
  })
  if (!response.ok) {
    throw new Error(await readResponseError(response, `知识库保存失败 (HTTP ${response.status})`))
  }
}

function scheduleKnowledgeLibraryPersist(library: KnowledgeLibrary) {
  knowledgeLibraryPersistPromise = knowledgeLibraryPersistPromise.then(() =>
    persistKnowledgeLibrary(library),
  )
  return knowledgeLibraryPersistPromise
}

function saveKnowledgeLibrary(library: KnowledgeLibrary) {
  const snapshot = setKnowledgeLibraryCache(buildLibrarySnapshot(library.files, library.courses))
  void scheduleKnowledgeLibraryPersist(snapshot).catch((error) => {
    console.error('persistKnowledgeLibrary failed:', error)
  })
  return snapshot
}

function updateKnowledgeLibrary(updater: (library: KnowledgeLibrary) => KnowledgeLibrary): KnowledgeLibrary {
  return saveKnowledgeLibrary(updater(loadKnowledgeLibrary()))
}

function updateLibraryFile(fileId: string, updater: (file: KnowledgeFile) => KnowledgeFile) {
  const library = loadKnowledgeLibrary()
  let didUpdate = false

  const files = library.files.map((file) => {
    if (file.id !== fileId) {
      return file
    }

    didUpdate = true
    const nextFile = updater(file)
    return {
      ...normalizeLibraryFile(nextFile),
      annotationMarkdown: buildAnnotationMarkdown(nextFile.annotations),
    }
  })

  if (!didUpdate) {
    return null
  }

  const nextLibrary = buildLibrarySnapshot(files, library.courses)
  saveKnowledgeLibrary(nextLibrary)
  return nextLibrary.files.find((file) => file.id === fileId) ?? null
}

function updateLibraryCourse(courseId: string, updater: (course: KnowledgeCourse) => KnowledgeCourse) {
  const library = loadKnowledgeLibrary()
  let didUpdate = false

  const courses = library.courses.map((course) => {
    if (course.id !== courseId) {
      return course
    }

    didUpdate = true
    return normalizeCourseHomeworkFolders(updater(course))
  })

  if (!didUpdate) {
    return null
  }

  const nextLibrary = buildLibrarySnapshot(library.files, courses)
  saveKnowledgeLibrary(nextLibrary)
  return nextLibrary.courses.find((course) => course.id === courseId) ?? null
}

export function loadKnowledgeLibrary(): KnowledgeLibrary {
  if (typeof window === 'undefined') {
    return {
      files: [],
      courses: [buildDefaultCourse()],
    }
  }

  return knowledgeLibraryCache
}

export async function refreshKnowledgeLibrary() {
  return await fetchKnowledgeLibraryFromServer()
}

export async function ensureKnowledgeLibraryLoaded() {
  if (typeof window === 'undefined') {
    return {
      files: [],
      courses: [buildDefaultCourse()],
    }
  }

  if (!knowledgeLibraryHydrationPromise) {
    knowledgeLibraryHydrationPromise = fetchKnowledgeLibraryFromServer().catch((error) => {
      knowledgeLibraryHydrationPromise = null
      throw error
    })
  }

  return await knowledgeLibraryHydrationPromise
}

export function createKnowledgeCourse(name: KnowledgeCourseInput): KnowledgeCourse {
  const normalized = normalizeCourseInput(name)
  if (!normalized.name) {
    throw new Error('课程名称不能为空')
  }

  const course = createKnowledgeCourseRecord(normalized)
  const nextLibrary = updateKnowledgeLibrary((library) =>
    buildLibrarySnapshot(library.files, [...library.courses, course]),
  )

  return nextLibrary.courses.find((item) => item.id === course.id) ?? course
}

export function findKnowledgeCourseByName(name: string) {
  return findKnowledgeCourseByStoredName(loadKnowledgeLibrary().courses, name)
}

export function ensureKnowledgeCourse(
  name: KnowledgeCourseInput,
): { course: KnowledgeCourse; created: boolean } {
  const existing = findCourseByInput(name)
  if (existing) {
    return {
      course: existing,
      created: false,
    }
  }

  return {
    course: createKnowledgeCourse(name),
    created: true,
  }
}

export function syncKnowledgeCourses(names: KnowledgeCourseInput[]) {
  const library = loadKnowledgeLibrary()
  const result = planKnowledgeCourseSync(library.courses, names)

  if (result.created.length) {
    saveKnowledgeLibrary(buildLibrarySnapshot(library.files, result.nextCourses))
  }

  return {
    created: result.created,
    existing: result.existing,
    courses: result.courses,
  }
}

export function getKnowledgeCourse(courseId: string) {
  return loadKnowledgeLibrary().courses.find((course) => course.id === courseId) ?? null
}

export function getKnowledgeFilesByCourse(courseId: string) {
  return loadKnowledgeLibrary().files.filter((file) => file.courseId === courseId)
}

export function getKnowledgeHomeworkFoldersByCourse(courseId: string) {
  return getKnowledgeCourse(courseId)?.homeworkFolders ?? []
}

export function getKnowledgeHomeworkFolder(courseId: string, folderType: KnowledgeHomeworkFolderType) {
  return (
    getKnowledgeHomeworkFoldersByCourse(courseId).find((folder) => folder.folderType === folderType) ??
    null
  )
}

export function getKnowledgeHomeworkFolderName(folderType: KnowledgeHomeworkFolderType) {
  return HOMEWORK_FOLDER_NAMES[folderType]
}

export function getKnowledgeHomeworkDocumentsByCourseFolder(
  courseId: string,
  folderType: KnowledgeHomeworkFolderType,
) {
  return getKnowledgeHomeworkFolder(courseId, folderType)?.homeworkDocuments ?? []
}

export function moveKnowledgeFileToCourse(fileId: string, courseId: string) {
  const course = getKnowledgeCourse(courseId)
  if (!course) {
    throw new Error('目标课程不存在')
  }

  const now = new Date().toISOString()
  updateLibraryFile(fileId, (file) => ({
    ...file,
    courseId,
    updatedAt: now,
    lastOpenedAt: now,
  }))
}

export async function saveKnowledgePdfSource(fileId: string, buffer: ArrayBuffer) {
  const formData = new FormData()
  formData.append('file', new Blob([buffer], { type: 'application/pdf' }), `${fileId}.pdf`)
  const response = await fetch(resolveBackendApiUrl(`/api/knowledge/pdf/${encodeURIComponent(fileId)}`), {
    method: 'PUT',
    body: formData,
  })
  if (!response.ok) {
    throw new Error(await readResponseError(response, `PDF 婧愭枃浠朵繚瀛樺け璐?(HTTP ${response.status})`))
  }

  updateLibraryFile(fileId, (file) => ({
    ...file,
    hasPdfSource: true,
  }))
}

export function getKnowledgeFile(fileId: string) {
  return loadKnowledgeLibrary().files.find((file) => file.id === fileId) ?? null
}

export function getKnowledgeFileBySourceKey(sourceKey: string) {
  const normalized = String(sourceKey || '').trim()
  return normalized
    ? loadKnowledgeLibrary().files.find((file) => file.sourceKey === normalized) ?? null
    : null
}

export async function deleteKnowledgeFile(fileId: string) {
  await ensureKnowledgeLibraryLoaded()
  const file = getKnowledgeFile(fileId)
  const sourceKey = file?.sourceKey || ''
  const isSyncedCourseware = sourceKey.startsWith('tsinghua-courseware:')
  if (isSyncedCourseware) {
    notifyCoursewareAutoSyncDeletion({ sourceKey, action: 'suppress' })
  }
  // Status pollers retain file references while a document is being removed.
  // Keep those late callbacks from recreating the local card after deletion.
  deletedKnowledgeFileIds.add(fileId)

  try {
    const response = await fetch(resolveBackendApiUrl(`/api/knowledge/files/${encodeURIComponent(fileId)}`), {
      method: 'DELETE',
    })
    if (!response.ok) {
      throw new Error(await readResponseError(response, `删除讲义失败 (HTTP ${response.status})`))
    }
    const payload = (await response.json().catch(() => ({}))) as Partial<KnowledgeLibrary> & {
      deleted?: boolean
      library?: Partial<KnowledgeLibrary>
    }
    if (!payload.deleted) {
      deletedKnowledgeFileIds.delete(fileId)
      if (isSyncedCourseware) {
        notifyCoursewareAutoSyncDeletion({ sourceKey, action: 'restore' })
      }
      return false
    }
    setKnowledgeLibraryCache(payload.library)
    return true
  } catch (error) {
    deletedKnowledgeFileIds.delete(fileId)
    if (isSyncedCourseware) {
      notifyCoursewareAutoSyncDeletion({ sourceKey, action: 'restore' })
    }
    throw error
  }
}

export async function deleteKnowledgeCourse(courseId: string) {
  await ensureKnowledgeLibraryLoaded()
  const courseFiles = knowledgeLibraryCache.files.filter((file) => file.courseId === courseId)
  const syncedSourceKeys = courseFiles
    .map((file) => file.sourceKey)
    .filter((sourceKey) => sourceKey.startsWith('tsinghua-courseware:'))
  for (const sourceKey of syncedSourceKeys) {
    notifyCoursewareAutoSyncDeletion({ sourceKey, action: 'suppress' })
  }
  let response: Response
  try {
    response = await fetch(resolveBackendApiUrl(`/api/knowledge/courses/${encodeURIComponent(courseId)}`), {
      method: 'DELETE',
    })
  } catch (error) {
    for (const sourceKey of syncedSourceKeys) {
      notifyCoursewareAutoSyncDeletion({ sourceKey, action: 'restore' })
    }
    throw error
  }
  if (!response.ok) {
    for (const sourceKey of syncedSourceKeys) {
      notifyCoursewareAutoSyncDeletion({ sourceKey, action: 'restore' })
    }
    throw new Error(await readResponseError(response, `删除课程失败 (HTTP ${response.status})`))
  }
  const payload = (await response.json().catch(() => ({}))) as Partial<KnowledgeLibrary> & {
    deleted?: boolean
    library?: Partial<KnowledgeLibrary>
  }
  if (!payload.deleted) {
    for (const sourceKey of syncedSourceKeys) {
      notifyCoursewareAutoSyncDeletion({ sourceKey, action: 'restore' })
    }
    return false
  }
  setKnowledgeLibraryCache(payload.library)
  return true
}

export type KnowledgeCourseSettingsInput = {
  displayName: string
  association: {
    name: string
    semesterId: string
    semesterName: string
    courseCode?: string
    wlkcid: string
  } | null
}

export async function updateKnowledgeCourseSettings(
  courseId: string,
  input: KnowledgeCourseSettingsInput,
) {
  await ensureKnowledgeLibraryLoaded()
  const response = await fetch(
    resolveBackendApiUrl(`/api/knowledge/courses/${encodeURIComponent(courseId)}`),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
  )
  if (!response.ok) {
    throw new Error(await readResponseError(response, `保存课程设置失败 (HTTP ${response.status})`))
  }
  const payload = (await response.json().catch(() => ({}))) as {
    course?: KnowledgeCourse
    library?: Partial<KnowledgeLibrary>
  }
  const library = setKnowledgeLibraryCache(payload.library)
  return library.courses.find((course) => course.id === courseId) ?? payload.course ?? null
}

export async function loadKnowledgePdfSource(fileId: string) {
  const response = await fetch(resolveBackendApiUrl(`/api/knowledge/pdf/${encodeURIComponent(fileId)}`))
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(await readResponseError(response, `PDF 源文件加载失败 (HTTP ${response.status})`))
  }
  return await response.arrayBuffer()
}

export async function saveKnowledgeAnnotationAsset(assetId: string, dataUrl: string) {
  const response = await fetch(
    resolveBackendApiUrl(`/api/knowledge/annotation-asset/${encodeURIComponent(assetId)}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl }),
    },
  )
  if (!response.ok) {
    throw new Error(await readResponseError(response, `疑点图片保存失败 (HTTP ${response.status})`))
  }
}

export async function loadKnowledgeAnnotationAsset(assetId: string) {
  const response = await fetch(
    resolveBackendApiUrl(`/api/knowledge/annotation-asset/${encodeURIComponent(assetId)}`),
  )
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(await readResponseError(response, `疑点图片加载失败 (HTTP ${response.status})`))
  }

  const payload = (await response.json().catch(() => ({}))) as { dataUrl?: string }
  return payload.dataUrl ?? null
}

export async function saveKnowledgeHomeworkAsset(assetId: string, payload: ArrayBuffer | string) {
  const response =
    typeof payload === 'string'
      ? await fetch(
          resolveBackendApiUrl(`/api/knowledge/homework-asset/${encodeURIComponent(assetId)}`),
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: payload }),
          },
        )
      : await fetch(
          resolveBackendApiUrl(`/api/knowledge/homework-asset/${encodeURIComponent(assetId)}`),
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Student-Content-Type': 'application/pdf',
            },
            body: payload,
          },
        )

  if (!response.ok) {
    throw new Error(await readResponseError(response, `练习资源保存失败 (HTTP ${response.status})`))
  }
}

export async function loadKnowledgeHomeworkAsset(assetId: string) {
  const response = await fetch(
    resolveBackendApiUrl(`/api/knowledge/homework-asset/${encodeURIComponent(assetId)}`),
  )
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(await readResponseError(response, `练习资源加载失败 (HTTP ${response.status})`))
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => ({}))) as { kind?: string; text?: string }
    if (payload.kind === 'text') {
      return payload.text ?? ''
    }
  }

  return await response.arrayBuffer()
}

export async function deleteKnowledgeHomeworkDocument(
  courseId: string,
  _folderType: KnowledgeHomeworkFolderType,
  homeworkDocumentId: string,
) {
  await ensureKnowledgeLibraryLoaded()
  const response = await fetch(
    resolveBackendApiUrl(
      `/api/knowledge/courses/${encodeURIComponent(courseId)}/homework-documents/${encodeURIComponent(homeworkDocumentId)}`,
    ),
    { method: 'DELETE' },
  )
  if (!response.ok) {
    throw new Error(
      await readResponseError(response, `删除题目文档失败 (HTTP ${response.status})`),
    )
  }
  const payload = (await response.json().catch(() => ({}))) as {
    deleted?: boolean
    library?: Partial<KnowledgeLibrary>
  }
  if (payload.library) {
    setKnowledgeLibraryCache(payload.library)
  }
  return payload.deleted === true
}

export function touchKnowledgeFile(fileId: string) {
  const now = new Date().toISOString()
  updateLibraryFile(fileId, (file) => ({
    ...file,
    lastOpenedAt: now,
    updatedAt: now,
  }))
}

export function saveKnowledgeChatMessages(fileId: string, chatMessages: ChatMessage[]) {
  const now = new Date().toISOString()
  updateLibraryFile(fileId, (file) => ({
    ...file,
    chatMessages,
    updatedAt: now,
    lastOpenedAt: now,
  }))
}

export function saveKnowledgeHomeworkDocuments(
  courseId: string,
  folderType: KnowledgeHomeworkFolderType,
  homeworkDocuments: HomeworkDocument[],
) {
  const now = new Date().toISOString()
  updateLibraryCourse(courseId, (course) => ({
    ...course,
    homeworkFolders: course.homeworkFolders.map((folder) =>
      folder.folderType === folderType
        ? {
            ...folder,
            homeworkDocuments: homeworkDocuments.map((document) =>
              normalizeHomeworkDocument({
                ...document,
                updatedAt: document.updatedAt ?? now,
              }),
            ),
            updatedAt: now,
          }
        : folder,
    ),
    updatedAt: now,
  }))
}

export function saveKnowledgeClassroomSession(fileId: string, session: ClassroomSession) {
  const now = new Date().toISOString()
  const normalized = normalizeClassroomSession({
    ...session,
    updatedAt: now,
  })

  updateLibraryFile(fileId, (file) => ({
    ...file,
    classroomSessions: [
      normalized,
      ...file.classroomSessions.filter((item) => item.id !== normalized.id),
    ].slice(0, 40),
    updatedAt: now,
    lastOpenedAt: now,
  }))

  return normalized
}

export async function addKnowledgeHomeworkDocument(
  courseId: string,
  folderType: KnowledgeHomeworkFolderType,
  input: Omit<HomeworkDocument, 'id' | 'createdAt' | 'updatedAt'> & { id?: string },
  assetPayload?: ArrayBuffer | string | null,
) {
  const now = new Date().toISOString()
  const normalized = normalizeHomeworkDocument({
    ...input,
    id: input.id ?? crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  })

  if (normalized.assetId && assetPayload !== undefined && assetPayload !== null) {
    await saveKnowledgeHomeworkAsset(normalized.assetId, assetPayload)
  }

  const nextCourse = updateLibraryCourse(courseId, (course) => ({
    ...course,
    homeworkFolders: course.homeworkFolders.map((folder) =>
      folder.folderType === folderType
        ? {
            ...folder,
            homeworkDocuments: [
              normalized,
              ...folder.homeworkDocuments.filter(
                (item) =>
                  item.id !== normalized.id &&
                  !(
                    item.fileName === normalized.fileName &&
                    item.byteSize === normalized.byteSize &&
                    item.sourceType === normalized.sourceType
                  ),
              ),
            ],
            updatedAt: now,
          }
        : folder,
    ),
    updatedAt: now,
  }))

  return (
    nextCourse?.homeworkFolders
      .find((folder) => folder.folderType === folderType)
      ?.homeworkDocuments.find((document) => document.id === normalized.id) ?? normalized
  )
}

export async function saveKnowledgeHomeworkAnnotation(
  courseId: string,
  folderType: KnowledgeHomeworkFolderType,
  homeworkDocumentId: string,
  annotation: DoubtAnnotation,
  imageDataUrl?: string | null,
) {
  const now = new Date().toISOString()
  const nextAnnotation: StoredDoubtAnnotation = {
    ...annotation,
    relatedQuestionIds: [],
  }

  if (nextAnnotation.imageAssetId && imageDataUrl) {
    await saveKnowledgeAnnotationAsset(nextAnnotation.imageAssetId, imageDataUrl)
  }

  updateLibraryCourse(courseId, (course) => ({
    ...course,
    homeworkFolders: course.homeworkFolders.map((folder) =>
      folder.folderType === folderType
        ? {
            ...folder,
            homeworkDocuments: folder.homeworkDocuments.map((document) =>
              document.id === homeworkDocumentId
                ? {
                    ...document,
                    annotations: [nextAnnotation, ...document.annotations].slice(0, 80),
                    updatedAt: now,
                  }
                : document,
            ),
            updatedAt: now,
          }
        : folder,
    ),
    updatedAt: now,
  }))

  return nextAnnotation
}

export async function saveKnowledgeAnnotation(
  fileId: string,
  annotation: DoubtAnnotation,
  imageDataUrl?: string | null,
) {
  const now = new Date().toISOString()
  const nextAnnotation: StoredDoubtAnnotation = {
    ...annotation,
    relatedQuestionIds: [],
  }

  if (nextAnnotation.imageAssetId && imageDataUrl) {
    await saveKnowledgeAnnotationAsset(nextAnnotation.imageAssetId, imageDataUrl)
  }

  updateLibraryFile(fileId, (file) => ({
    ...file,
    annotations: [nextAnnotation, ...file.annotations].slice(0, 80),
    updatedAt: now,
    lastOpenedAt: now,
  }))

  return nextAnnotation
}

export function linkQuestionToAnnotation(
  fileId: string,
  annotationId: string,
  questionMessageId: string,
) {
  const now = new Date().toISOString()
  updateLibraryFile(fileId, (file) => ({
    ...file,
    annotations: file.annotations.map((annotation) =>
      annotation.id === annotationId
        ? {
            ...annotation,
            relatedQuestionIds: Array.from(
              new Set([...annotation.relatedQuestionIds, questionMessageId]),
            ),
            updatedAt: now,
          }
        : annotation,
    ),
    updatedAt: now,
    lastOpenedAt: now,
  }))
}

export function linkQuestionToHomeworkAnnotation(
  courseId: string,
  folderType: KnowledgeHomeworkFolderType,
  homeworkDocumentId: string,
  annotationId: string,
  questionMessageId: string,
) {
  const now = new Date().toISOString()
  updateLibraryCourse(courseId, (course) => ({
    ...course,
    homeworkFolders: course.homeworkFolders.map((folder) =>
      folder.folderType === folderType
        ? {
            ...folder,
            homeworkDocuments: folder.homeworkDocuments.map((document) =>
              document.id === homeworkDocumentId
                ? {
                    ...document,
                    annotations: document.annotations.map((annotation) =>
                      annotation.id === annotationId
                        ? {
                            ...annotation,
                            relatedQuestionIds: Array.from(
                              new Set([...annotation.relatedQuestionIds, questionMessageId]),
                            ),
                            updatedAt: now,
                          }
                        : annotation,
                    ),
                    updatedAt: now,
                  }
                : document,
            ),
            updatedAt: now,
          }
        : folder,
    ),
    updatedAt: now,
  }))
}

export function saveKnowledgeAnnotationChatSession(
  fileId: string,
  annotationId: string,
  chatSession: DoubtChatSession,
) {
  const now = new Date().toISOString()
  const normalizedSession = normalizeDoubtChatSession(chatSession, annotationId)
  updateLibraryFile(fileId, (file) => ({
    ...file,
    annotations: file.annotations.map((annotation) =>
      annotation.id === annotationId
        ? { ...annotation, chatSession: normalizedSession, updatedAt: now }
        : annotation,
    ),
    updatedAt: now,
    lastOpenedAt: now,
  }))
}

export function saveKnowledgeHomeworkAnnotationChatSession(
  courseId: string,
  folderType: KnowledgeHomeworkFolderType,
  homeworkDocumentId: string,
  annotationId: string,
  chatSession: DoubtChatSession,
) {
  const now = new Date().toISOString()
  const normalizedSession = normalizeDoubtChatSession(chatSession, annotationId)
  updateLibraryCourse(courseId, (course) => ({
    ...course,
    homeworkFolders: course.homeworkFolders.map((folder) =>
      folder.folderType === folderType
        ? {
            ...folder,
            homeworkDocuments: folder.homeworkDocuments.map((document) =>
              document.id === homeworkDocumentId
                ? {
                    ...document,
                    annotations: document.annotations.map((annotation) =>
                      annotation.id === annotationId
                        ? { ...annotation, chatSession: normalizedSession, updatedAt: now }
                        : annotation,
                    ),
                    updatedAt: now,
                  }
                : document,
            ),
            updatedAt: now,
          }
        : folder,
    ),
    updatedAt: now,
  }))
}

export async function upsertKnowledgeFile(input: {
  fileId?: string
  fileName: string
  pageCount: number
  byteSize: number
  markdown: string
  layoutBlocks?: StructuredDocumentBlock[]
  pdfBuffer?: ArrayBuffer | null
  chatMessages?: ChatMessage[]
  courseId?: string | null
  sourceKey?: string
  pipelineStatus?: string | null
  mineruStatus?: string | null
  embeddingStatus?: string | null
  vectorStatus?: string | null
  pipelineError?: string | null
  chunkCount?: number | null
  indexedChunkCount?: number | null
  libraryFolder?: KnowledgeLibraryFolderType
}) {
  await ensureKnowledgeLibraryLoaded()
  const library = loadKnowledgeLibrary()
  const now = new Date().toISOString()
  const sourceKey =
    typeof input.sourceKey === 'string' && input.sourceKey.trim()
      ? input.sourceKey.trim()
      : buildSourceKey(input.fileName, input.byteSize)
  if (input.fileId && deletedKnowledgeFileIds.has(input.fileId)) {
    throw new Error('Document was deleted.')
  }
  const existing = input.fileId
    ? library.files.find((file) => file.id === input.fileId)
    : library.files.find((file) => file.sourceKey === sourceKey)
  const targetCourseId =
    String(input.courseId || existing?.courseId || DEFAULT_COURSE_ID).trim() || DEFAULT_COURSE_ID

  const nextFile: KnowledgeFile = existing
    ? {
        ...existing,
        sourceKey,
        courseId: targetCourseId,
        fileName: input.fileName,
        pageCount: input.pageCount,
        byteSize: input.byteSize,
        hasPdfSource: Boolean(input.pdfBuffer) || existing.hasPdfSource,
        markdown: input.markdown,
        layoutBlocks: normalizeStructuredDocumentBlocks(input.layoutBlocks),
        annotationMarkdown: buildAnnotationMarkdown(existing.annotations),
        updatedAt: now,
        lastOpenedAt: now,
        chatMessages: input.chatMessages ?? existing.chatMessages,
        homeworkDocuments: [],
        classroomSessions: existing.classroomSessions,
        pipelineStatus: input.pipelineStatus ?? existing.pipelineStatus ?? null,
        mineruStatus: input.mineruStatus ?? existing.mineruStatus ?? null,
        embeddingStatus: input.embeddingStatus ?? existing.embeddingStatus ?? null,
        vectorStatus: input.vectorStatus ?? existing.vectorStatus ?? null,
        pipelineError: input.pipelineError ?? existing.pipelineError ?? null,
        chunkCount: input.chunkCount ?? existing.chunkCount ?? null,
        indexedChunkCount: input.indexedChunkCount ?? existing.indexedChunkCount ?? null,
        libraryFolder: input.libraryFolder ?? existing.libraryFolder ?? 'courseware',
      }
    : {
        id: input.fileId || crypto.randomUUID(),
        sourceKey,
        courseId: targetCourseId,
        fileName: input.fileName,
        pageCount: input.pageCount,
        byteSize: input.byteSize,
        hasPdfSource: Boolean(input.pdfBuffer),
        markdown: input.markdown,
        layoutBlocks: normalizeStructuredDocumentBlocks(input.layoutBlocks),
        annotationMarkdown: buildAnnotationMarkdown([]),
        createdAt: now,
        updatedAt: now,
        lastOpenedAt: now,
        annotations: [],
        chatMessages: input.chatMessages ?? [],
        homeworkDocuments: [],
        classroomSessions: [],
        pipelineStatus: input.pipelineStatus ?? null,
        mineruStatus: input.mineruStatus ?? null,
        embeddingStatus: input.embeddingStatus ?? null,
        vectorStatus: input.vectorStatus ?? null,
        pipelineError: input.pipelineError ?? null,
        chunkCount: input.chunkCount ?? null,
        indexedChunkCount: input.indexedChunkCount ?? null,
        libraryFolder: input.libraryFolder ?? 'courseware',
      }

  const nextLibrary = buildLibrarySnapshot(
    existing
      ? library.files.map((file) => (file.id === existing.id ? nextFile : file))
      : [nextFile, ...library.files],
    library.courses,
  )

  saveKnowledgeLibrary(nextLibrary)
  if (input.pdfBuffer) {
    await saveKnowledgePdfSource(nextFile.id, input.pdfBuffer)
  }
  return nextFile
}

if (typeof window !== 'undefined') {
  void ensureKnowledgeLibraryLoaded().catch((error) => {
    console.warn('Initial knowledge library hydration failed:', error)
  })
}
