import { resolveBackendApiUrl } from './apiConfig'

export type QuestionRelationTarget = {
  document_id?: string | null
  document_name?: string | null
  document_type?: string | null
  page_number?: number | null
  question_id?: string | null
  title?: string | null
  content?: string | null
}

export type QuestionRelation = {
  relation_id: string
  relation_type: string
  confidence?: number | null
  vector_score?: number | null
  rerank_score?: number | null
  target: QuestionRelationTarget
  question?: QuestionRelationTarget & { analysis?: { chapter?: string | null } | null }
}

export type QuestionRelationRecord = {
  relations: QuestionRelation[]
  status: 'missing' | 'processing' | 'completed' | 'failed'
  current_target?: string | null
}

async function readRelations(url: string, signal?: AbortSignal): Promise<QuestionRelationRecord> {
  const response = await fetch(url, { signal })
  if (response.status === 404) {
    return { relations: [], status: 'missing' }
  }
  if (!response.ok) {
    throw new Error(`关联数据读取失败 (HTTP ${response.status})`)
  }
  const payload = (await response.json()) as Partial<QuestionRelationRecord>
  return {
    relations: Array.isArray(payload.relations) ? payload.relations : [],
    status:
      payload.status === 'processing' || payload.status === 'failed'
        ? payload.status
        : 'completed',
    current_target: typeof payload.current_target === 'string' ? payload.current_target : null,
  }
}

export function getQuestionRelations(questionId: string, signal?: AbortSignal) {
  return readRelations(
    resolveBackendApiUrl(`/api/question-relations/questions/${encodeURIComponent(questionId)}`),
    signal,
  )
}

export function getLecturePageRelations(
  courseId: string,
  documentId: string,
  pageNumber: number,
  signal?: AbortSignal,
) {
  return readRelations(
    resolveBackendApiUrl(
      `/api/question-relations/courses/${encodeURIComponent(courseId)}/lectures/${encodeURIComponent(documentId)}/pages/${pageNumber}`,
    ),
    signal,
  )
}
