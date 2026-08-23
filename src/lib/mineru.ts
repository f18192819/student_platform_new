import type { HomeworkDocument, StructuredDocumentBlock } from '../types'

type MineruExtractionResult = {
  markdown: string
  pageCount: number | null
  layoutBlocks: StructuredDocumentBlock[]
}

function normalizeBlockKind(rawKind: unknown): StructuredDocumentBlock['kind'] {
  const kind = String(rawKind || '').trim().toLowerCase()
  if (kind === 'equation' || kind === 'interline_equation' || kind === 'inline_equation') {
    return 'formula'
  }
  if (kind === 'chart' || kind === 'figure') {
    return 'image'
  }
  if (kind === 'text' || kind === 'list' || kind === 'code') {
    return 'text'
  }
  if (kind === 'image' || kind === 'table' || kind === 'title' || kind === 'formula') {
    return kind
  }
  return 'unknown'
}

function resolveBlockPageNumber(partial: Record<string, unknown>) {
  const direct = Number(partial.pageNumber ?? partial.page_number ?? partial.page ?? partial.pageNo)
  if (Number.isFinite(direct) && direct >= 1) {
    return direct
  }

  const zeroBased = Number(partial.page_idx ?? partial.pageIndex ?? partial.page_index)
  if (Number.isFinite(zeroBased) && zeroBased >= 0) {
    return zeroBased + 1
  }

  return null
}

function collectBlockText(partial: Record<string, unknown>, kind: StructuredDocumentBlock['kind']) {
  const values: string[] = []

  const append = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      values.push(value.trim())
      return
    }
    if (Array.isArray(value)) {
      value.forEach(append)
    }
  }

  append(partial.text)
  append(partial.content)
  append(partial.latex)
  append(partial.html)
  append(partial.caption)
  append(partial.footnote)
  append(partial.image_caption)
  append(partial.image_footnote)
  append(partial.table_caption)
  append(partial.table_footnote)
  append(partial.table_body)
  append(partial.code_body)
  append(partial.code_caption)
  append(partial.code_footnote)

  const text = values.join('\n').trim()
  if (text) {
    return text
  }

  if (kind === 'formula') {
    return '公式区域'
  }
  if (kind === 'image') {
    return '图片区域'
  }
  if (kind === 'table') {
    return '表格区域'
  }
  return ''
}

function resolveDocumentPipelineApiUrl() {
  if (typeof window === 'undefined') {
    return '/api/documents/process'
  }

  const runtime = (window as typeof window & {
    __OCTOPUS_SERVICE__?: { apiBase?: string; serviceId?: string; uuid?: string }
  }).__OCTOPUS_SERVICE__
  const apiBase = typeof runtime?.apiBase === 'string' ? runtime.apiBase.trim() : ''
  if (apiBase.startsWith('/')) {
    return `${apiBase.replace(/\/+$/, '')}/api/documents/process`
  }

  const serviceKey =
    (typeof runtime?.uuid === 'string' && runtime.uuid.trim()) ||
    (typeof runtime?.serviceId === 'string' && runtime.serviceId.trim()) ||
    ''
  return serviceKey ? `/api/v1/service/${serviceKey}/api/documents/process` : '/api/documents/process'
}

function resolveQuestionPipelineApiUrl() {
  return resolveDocumentPipelineApiUrl().replace('/api/documents/process', '/api/questions/process')
}

function resolveDocumentStatusApiUrl(documentId: string) {
  return `${resolveDocumentPipelineApiUrl().replace('/process', '')}/${encodeURIComponent(documentId)}/status`
}

function resolveDocumentRetryApiUrl(documentId: string) {
  return `${resolveDocumentPipelineApiUrl().replace('/process', '')}/${encodeURIComponent(documentId)}/retry`
}

export type DocumentPipelineStatus = {
  document_id?: string
  status: string
  mineru_status: string
  embedding_status: string
  vector_status: string
  error?: string
  markdown?: string
  page_count?: number
  layout_blocks?: unknown[]
  chunk_count?: number
  embedding_completed_chunks?: number
  vector_completed_chunks?: number
}

async function readPipelineResponse(response: Response): Promise<DocumentPipelineStatus> {
  const rawText = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = (JSON.parse(rawText) as Record<string, unknown>) ?? {}
  } catch {
    payload = {}
  }
  if (!response.ok) {
    throw new Error(String(payload.detail || rawText || `Document pipeline failed (HTTP ${response.status})`))
  }
  return payload as DocumentPipelineStatus
}

export async function submitLectureDocumentForProcessing(
  file: File,
  courseId: string,
  documentId: string,
) {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('course_id', courseId)
  formData.append('document_type', 'lecture')
  formData.append('source_type', 'pdf')
  formData.append('document_id', documentId)
  return readPipelineResponse(await fetch(resolveDocumentPipelineApiUrl(), { method: 'POST', body: formData }))
}

export async function getLectureDocumentProcessingStatus(documentId: string) {
  return readPipelineResponse(await fetch(resolveDocumentStatusApiUrl(documentId)))
}

export async function retryLectureDocumentProcessing(documentId: string) {
  return readPipelineResponse(await fetch(resolveDocumentRetryApiUrl(documentId), { method: 'POST' }))
}

function extractLayoutBlocksFromPayload(payload: unknown): StructuredDocumentBlock[] {
  if (!payload || typeof payload !== 'object') {
    return []
  }

  const record = payload as Record<string, unknown>
  const direct = record.layout_blocks
  if (Array.isArray(direct)) {
    return direct
      .map((block): StructuredDocumentBlock | null => {
        if (!block || typeof block !== 'object') {
          return null
        }

        const partial = block as Record<string, unknown>
        const rawBbox = Array.isArray(partial.bbox) ? partial.bbox : []
        const bbox = rawBbox
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .slice(0, 4)
        const pageNumber = resolveBlockPageNumber(partial)
        const kind = normalizeBlockKind(partial.kind ?? partial.type ?? partial.sub_type)

        if (bbox.length !== 4 || !pageNumber) {
          return null
        }

        return {
          id: String(partial.id || crypto.randomUUID()),
          pageNumber,
          kind,
          label:
            String(partial.label || partial.sub_type || partial.type || '').trim() ||
            `第 ${pageNumber} 页${kind}区块`,
          text: collectBlockText(partial, kind),
          bbox: [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!] as [number, number, number, number],
          ...(partial.coordinateSpace === 'pdf-page' ? { coordinateSpace: 'pdf-page' as const } : {}),
          source: 'mineru-local',
        } satisfies StructuredDocumentBlock
      })
      .filter((block): block is StructuredDocumentBlock => block !== null)
  }

  if (record.data && typeof record.data === 'object') {
    return extractLayoutBlocksFromPayload(record.data)
  }

  return []
}

export async function processLectureDocumentWithPipeline(
  file: File,
  courseId: string,
  documentId?: string,
) {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('course_id', courseId)
  formData.append('document_type', 'lecture')
  formData.append('source_type', 'pdf')
  if (documentId) {
    formData.append('document_id', documentId)
  }

  let payload = await readPipelineResponse(await fetch(resolveDocumentPipelineApiUrl(), {
    method: 'POST', body: formData,
  }))
  const pipelineDocumentId = documentId || String(payload.document_id || '')
  if (!pipelineDocumentId) throw new Error('Document pipeline did not return a document id.')
  const deadline = Date.now() + 3_600_000
  while (
    payload.status !== 'completed'
    && payload.status !== 'cancelled'
    && !payload.status.endsWith('_failed')
  ) {
    if (Date.now() >= deadline) throw new Error('Document pipeline timed out.')
    await new Promise((resolve) => window.setTimeout(resolve, 1500))
    payload = await getLectureDocumentProcessingStatus(pipelineDocumentId)
  }
  if (payload.status !== 'completed') {
    throw new Error(
      String(payload.error || (payload.status === 'cancelled'
        ? 'Document pipeline cancelled.'
        : 'Document pipeline failed.')),
    )
  }

  const markdown = String(payload.markdown || '').trim()
  const layoutBlocks = extractLayoutBlocksFromPayload(payload)
  if (payload.mineru_status !== 'completed' || !markdown) {
    throw new Error(String(payload.error || 'MinerU 未返回可用的讲义 Markdown。'))
  }
  return {
    markdown,
    pageCount: Number(payload.page_count || 0) || null,
    layoutBlocks,
    pipelineStatus: String(payload.status || ''),
  }
}

export async function moveLectureDocumentToCourse(documentId: string, courseId: string) {
  const payload = await readPipelineResponse(await fetch(
    `${resolveDocumentPipelineApiUrl().replace('/process', '')}/${encodeURIComponent(documentId)}/move-course`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course_id: courseId }),
    },
  ))
  if (payload.status !== 'completed') {
    throw new Error(String(payload.error || 'Document course reassignment did not complete.'))
  }
  const markdown = String(payload.markdown || '').trim()
  if (payload.mineru_status !== 'completed' || !markdown) {
    throw new Error(String(payload.error || 'MinerU result is unavailable after course reassignment.'))
  }
  return {
    markdown,
    pageCount: Number(payload.page_count || 0) || null,
    layoutBlocks: extractLayoutBlocksFromPayload(payload),
    pipelineStatus: String(payload.status || ''),
  }
}

export async function processHomeworkDocumentWithPipeline(
  file: File,
  courseId: string,
  folderType: 'homework' | 'past-exam',
  documentId: string,
): Promise<MineruExtractionResult & { questions: HomeworkDocument['questions']; status: string }> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('course_id', courseId)
  formData.append('document_type', folderType)
  formData.append('document_id', documentId)
  const response = await fetch(resolveQuestionPipelineApiUrl(), { method: 'POST', body: formData })
  const rawText = await response.text()
  let payload: Record<string, unknown> = {}
  try {
    payload = (JSON.parse(rawText) as Record<string, unknown>) ?? {}
  } catch {
    payload = {}
  }
  if (!response.ok) {
    throw new Error(String(payload.detail || rawText || `Question pipeline failed (HTTP ${response.status})`))
  }
  if (payload.status !== 'completed') {
    throw new Error(String(payload.error || 'Question pipeline did not complete.'))
  }
  const questions = Array.isArray(payload.questions)
    ? payload.questions.map((item, index) => {
        const question = item as Record<string, unknown>
        return {
          id: String(question.question_id || crypto.randomUUID()),
          homeworkDocumentId: documentId,
          index: Number(question.index || index + 1),
          title: String(question.title || `第 ${index + 1} 题`),
          content: String(question.content || ''),
          pageNumber: Number(question.page_number) || null,
          anchorText: String(question.anchor_text || '') || null,
          analysis: question.analysis as HomeworkDocument['questions'][number]['analysis'],
        }
      }).filter((question) => question.content.trim())
    : []
  return {
    markdown: String(payload.markdown || '').trim(),
    pageCount: Number(payload.page_count || 0) || null,
    layoutBlocks: extractLayoutBlocksFromPayload(payload),
    questions,
    status: String(payload.status || ''),
  }
}

export async function readHomeworkAssetPayload(file: File) {
  if (file.type.startsWith('image/')) {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read image file.'))
      reader.readAsDataURL(file)
    })
  }

  return await file.arrayBuffer()
}

export function buildPendingHomeworkDocument(file: File): HomeworkDocument {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    lectureDocumentId: null,
    assetId: crypto.randomUUID(),
    fileName: file.name,
    sourceType: file.type.startsWith('image/') ? 'image' : 'pdf',
    mimeType: file.type,
    byteSize: file.size,
    pageCount: null,
    status: 'processing',
    extractor: 'mineru',
    extractedMarkdown: '',
    layoutBlocks: [],
    questions: [],
    knowledgeLinks: [],
    annotations: [],
    errorMessage: null,
    createdAt: now,
    updatedAt: now,
  }
}

export function buildReadyHomeworkDocument(
  base: HomeworkDocument,
  extraction: MineruExtractionResult,
) {
  return {
    ...base,
    pageCount: extraction.pageCount,
    status: 'ready' as const,
    extractedMarkdown: extraction.markdown,
    layoutBlocks: extraction.layoutBlocks,
    questions: base.questions,
    knowledgeLinks: base.knowledgeLinks,
    annotations: base.annotations,
    errorMessage: null,
    updatedAt: new Date().toISOString(),
  }
}

export function buildFailedHomeworkDocument(
  base: HomeworkDocument,
  errorMessage: string,
): HomeworkDocument {
  return {
    ...base,
    status: 'error',
    questions: [],
    knowledgeLinks: base.knowledgeLinks,
    annotations: base.annotations,
    errorMessage,
    updatedAt: new Date().toISOString(),
  }
}
