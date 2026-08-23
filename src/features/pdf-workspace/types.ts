import type { ChatMessage, HomeworkKnowledgeLink, HomeworkQuestion } from '../../types'

export type DraftDoubt = {
  id: string
  pageNumber: number | null
}

export type ComposerAttachment = {
  id: string
  kind: 'image' | 'document' | 'text'
  name: string
  dataUrl?: string
  contentText?: string
  blockReference?: {
    blockId: string
    pageNumber: number
    viewer: 'lecture' | 'homework'
    documentId?: string | null
  }
}

export type HomeworkFocus = {
  documentId: string
  questionId: string | null
}

export type LecturePageQuestionFocus = {
  pageNumber: number
}

export type ViewerSource =
  | { kind: 'lecture' }
  | { kind: 'homework'; documentId: string }

export type PageQuestionEntry = {
  linkId: string
  homeworkDocumentId: string
  homeworkFileName: string
  questionId: string
  questionTitle: string
  questionPageNumber: number | null
  conceptTitle: string
  lecturePageNumber: number | null
}

export type VisibleConversationState = {
  messages: ChatMessage[]
  latestAssistantMessageId: string | null
}

export type HomeworkQuestionLinkChip = Pick<
  HomeworkKnowledgeLink,
  'id' | 'conceptTitle' | 'lecturePageNumber'
>

export type SelectedHomeworkQuestionSummary = Pick<
  HomeworkQuestion,
  'id' | 'title' | 'content' | 'pageNumber'
>

export type RelatedMaterialCard = {
  id: string
  kind: 'lecture' | 'question'
  documentId: string
  documentName: string
  documentType: string
  pageNumber: number | null
  questionId: string | null
  title: string
  content: string
  chapter: string
  confidence: number | null
}
