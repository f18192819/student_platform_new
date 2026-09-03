import type { PDFPageProxy } from 'pdfjs-dist'

export type PdfOutlineBlock = {
  id: string
  title: string
  body: string
  page: number
}

export type AskAnswer = {
  answer: string
  evidence: string[]
  keyword: string | null
  mode: 'api' | 'local'
  note?: string
  contextUsage?: {
    model: string
    contextWindow: number
    estimatedInputTokens: number
    rawInputTokens: number
    wasTruncated: boolean
  }
}

export type AskStreamHandlers = {
  onToken?: (chunk: string) => void
}

export type AskImageAttachment = {
  name: string
  dataUrl: string
}

export type ChatMessage = {
  id: string
  role: 'assistant' | 'user' | 'system' | 'teacher'
  content: string
  createdAt?: string
  isSummary?: boolean
}

export type ChatCompactionPoint = {
  summaryMessageId: string
  boundaryMessageId: string
  createdAt: number
}

export type DoubtChatSession = {
  id: string
  messages: ChatMessage[]
  compactionPoints: ChatCompactionPoint[]
  updatedAt: string
}

export type DoubtAnnotation = {
  id: string
  pageNumber: number | null
  question: string
  imageAssetId: string | null
  imageName: string | null
  createdAt: string
  updatedAt: string
}

export type StoredDoubtAnnotation = DoubtAnnotation & {
  relatedQuestionIds: string[]
  chatSession?: DoubtChatSession
}

export type HomeworkQuestion = {
  id: string
  homeworkDocumentId: string
  index: number
  title: string
  content: string
  pageNumber: number | null
  anchorText?: string | null
  analysis?: QuestionAnalysis | null
}

export type QuestionAnalysis = {
  question_type: string
  difficulty: { level: number; reason: string }
  knowledge_points: string[]
  formulas: string[]
  chapter: string
  prerequisites: string[]
  skills: string[]
  summary: string
}

export type HomeworkKnowledgeLink = {
  id: string
  homeworkDocumentId: string
  lectureDocumentId: string | null
  questionId: string
  questionTitle?: string | null
  questionIndex?: number | null
  conceptTitle: string
  lecturePageNumber: number | null
  lectureAnchorText: string
  lectureSnippet?: string | null
}

export type StructuredDocumentBlock = {
  id: string
  pageNumber: number
  kind: 'text' | 'formula' | 'image' | 'table' | 'title' | 'unknown'
  label: string
  text: string
  bbox: [number, number, number, number]
  coordinateSpace?: 'pdf-page'
  source: 'mineru-local' | 'pdfjs-fallback'
}

export type HomeworkDocument = {
  id: string
  lectureDocumentId: string | null
  assetId: string | null
  fileName: string
  sourceType: 'pdf' | 'image'
  mimeType: string
  byteSize: number
  pageCount: number | null
  status: 'processing' | 'ready' | 'error'
  pipelineStatus?: string | null
  parserStatus?: string | null
  extractionStatus?: string | null
  analysisStatus?: string | null
  embeddingStatus?: string | null
  vectorStatus?: string | null
  embeddingCompletedQuestions?: number
  vectorCompletedQuestions?: number
  extractor: 'mineru'
  extractedMarkdown: string
  layoutBlocks: StructuredDocumentBlock[]
  questions: HomeworkQuestion[]
  knowledgeLinks: HomeworkKnowledgeLink[]
  annotations: StoredDoubtAnnotation[]
  errorMessage: string | null
  createdAt: string
  updatedAt: string
}

export type KnowledgeHomeworkFolderType = 'homework' | 'past-exam'
export type KnowledgeLibraryFolderType = 'courseware' | 'other'

export type KnowledgeHomeworkFolder = {
  id: string
  courseId: string
  folderType: KnowledgeHomeworkFolderType
  name: string
  homeworkDocuments: HomeworkDocument[]
  createdAt: string
  updatedAt: string
}

export type KnowledgeFile = {
  id: string
  sourceKey: string
  courseId: string
  fileName: string
  pageCount: number
  byteSize: number
  hasPdfSource: boolean
  markdown: string
  layoutBlocks: StructuredDocumentBlock[]
  annotationMarkdown: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  annotations: StoredDoubtAnnotation[]
  chatMessages: ChatMessage[]
  homeworkDocuments: HomeworkDocument[]
  classroomSessions: ClassroomSession[]
  libraryFolder?: KnowledgeLibraryFolderType
  pipelineStatus?: string | null
  mineruStatus?: string | null
  embeddingStatus?: string | null
  vectorStatus?: string | null
  pipelineError?: string | null
  chunkCount?: number | null
  indexedChunkCount?: number | null
}

export type KnowledgeLibrary = {
  files: KnowledgeFile[]
  courses: KnowledgeCourse[]
}

export type KnowledgeCourse = {
  id: string
  name: string
  displayName?: string | null
  source?: 'manual' | 'tsinghua-sync' | null
  semesterId?: string | null
  semesterName?: string | null
  courseCode?: string | null
  wlkcid?: string | null
  homeworkFolders: KnowledgeHomeworkFolder[]
  createdAt: string
  updatedAt: string
}

export type StudyPlanResourceType = 'lecture' | 'homework' | 'past-exam'

export type StudyPlanResource = {
  id: string
  type: StudyPlanResourceType
  label: string
  courseId?: string
  courseName?: string
}

export type StudyPlanItem = {
  id: string
  title: string
  startAt: string
  endAt: string
  resources: StudyPlanResource[]
  createdAt: string
  updatedAt: string
}

export type CourseStudyPlan = {
  courseId: string
  items: StudyPlanItem[]
  updatedAt: string
}

export type PdfController = {
  pageCount: number
  markdown: string
  pageTexts?: string[]
  pageSizes?: Array<{
    width: number
    height: number
  }>
  getPage: (pageNumber: number) => Promise<PDFPageProxy>
}

export type ApiConfig = {
  baseUrl: string
  apiKey: string
  model: string
  models: string[]
  ocrBaseUrl: string
  ocrApiKey: string
  ocrModel: string
  ocrModels: string[]
  ocrProvider: 'api' | 'deepseek-web'
  doubtModel: string
  doubtModels: string[]
  doubtProvider: 'api' | 'deepseek-web'
  deepseekWebBridgeUrl: string
  contextWindowOverrides: Record<string, number>
  contextCompactionThreshold: number
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingModels: string[]
  rerankBaseUrl: string
  rerankApiKey: string
  rerankModel: string
  rerankModels: string[]
  neo4jEnabled: boolean
  neo4jAutoStart: boolean
  neo4jHome: string
  neo4jUri: string
  neo4jUsername: string
  neo4jPassword: string
  neo4jDatabase: string
  homeworkSplitModel: string
  systemPrompt: string
  asrBaseUrl: string
  asrApiKey: string
  asrModel: string
  asrPrompt: string
}

export type TsinghuaAuthConfig = {
  configured: boolean
  username: string
  hasPassword: boolean
  autoLoginEnabled: boolean
}

export type TranscriptSentence = {
  id: string
  text: string
  startSeconds: number | null
  endSeconds: number | null
  order: number
}

export type AsrTranscriptPayload = {
  text: string
  sentences: TranscriptSentence[]
}

export type ClassroomLectureSegment = {
  id: string
  recordingId: string | null
  title: string
  summary: string
  polishedText: string
  anchorText: string | null
  pageNumbers: number[]
  startSeconds: number | null
  endSeconds: number | null
  sourceSentenceIds: string[]
  createdAt: string
}

export type ClassroomSession = {
  id: string
  transcript: string
  polishedOverview: string
  segments: ClassroomLectureSegment[]
  createdAt: string
  updatedAt: string
}
