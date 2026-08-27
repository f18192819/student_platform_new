import { resolveBackendApiUrl } from './apiConfig'

export type ChatRetrievedFragment = {
  chunk_id?: string
  question_id?: string
  document_id: string
  document_name?: string
  document_type?: string
  page_number?: number | null
  chapter?: string | null
  section?: string | null
  title?: string | null
  content: string
  vector_score: number
  rerank_score: number
  score: number
}

export type ChatContextRetrievalResult = {
  results: ChatRetrievedFragment[]
  candidate_count: number
  rerank_source: 'reranker' | 'reranker-partial' | 'vector-only' | 'none'
  rerank_error?: string | null
  retrieval_query: string
  rewrite_source: 'text-model' | 'original' | 'fallback'
  rewrite_error?: string | null
}

export type ChatRetrievalMessage = {
  role: 'user' | 'assistant'
  content: string
}

export async function retrieveChatContext(input: {
  query: string
  courseId: string
  documentId?: string | null
  documentType?: 'lecture' | 'homework' | 'past-exam'
  topN?: number
  topK?: number
  recentMessages?: ChatRetrievalMessage[]
}): Promise<ChatContextRetrievalResult> {
  const response = await fetch(resolveBackendApiUrl('/api/chat/retrieve-context'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: input.query,
      course_id: input.courseId,
      document_id: input.documentId || '',
      document_type: input.documentType || '',
      top_n: input.topN ?? 20,
      top_k: input.topK ?? 6,
      recent_messages: input.recentMessages ?? [],
    }),
  })
  const payload = (await response.json().catch(() => ({}))) as Partial<ChatContextRetrievalResult> & {
    detail?: string
  }
  if (!response.ok) {
    throw new Error(payload.detail || `检索聊天上下文失败 (HTTP ${response.status})`)
  }
  return {
    results: Array.isArray(payload.results) ? payload.results : [],
    candidate_count: Number(payload.candidate_count || 0),
    rerank_source: payload.rerank_source || 'none',
    rerank_error: payload.rerank_error || null,
    retrieval_query: String(payload.retrieval_query || input.query),
    rewrite_source: payload.rewrite_source || 'original',
    rewrite_error: payload.rewrite_error || null,
  }
}
