import {
  getKnowledgeFile,
  upsertKnowledgeFile,
} from '../../lib/knowledgeBase'
import type {
  DocumentPipelineStatus,
  QuestionPipelineResult,
} from '../../lib/mineru'
import type { HomeworkDocument, StructuredDocumentBlock } from '../../types'

export function applyQuestionPipelineResult(
  document: HomeworkDocument,
  result: QuestionPipelineResult,
): HomeworkDocument {
  const failed = result.status.endsWith('_failed')
  return {
    ...document,
    pageCount: result.pageCount ?? document.pageCount,
    status: result.status === 'completed' ? 'ready' : failed ? 'error' : 'processing',
    pipelineStatus: result.status,
    parserStatus: result.parserStatus || document.parserStatus || null,
    extractionStatus: result.extractionStatus || document.extractionStatus || null,
    analysisStatus: result.analysisStatus || document.analysisStatus || null,
    embeddingStatus: result.embeddingStatus || document.embeddingStatus || null,
    vectorStatus: result.vectorStatus || document.vectorStatus || null,
    embeddingCompletedQuestions: result.embeddingCompletedQuestions,
    vectorCompletedQuestions: result.vectorCompletedQuestions,
    extractedMarkdown: result.markdown || document.extractedMarkdown,
    layoutBlocks: result.layoutBlocks.length ? result.layoutBlocks : document.layoutBlocks,
    questions: result.questions.length ? result.questions : document.questions,
    errorMessage: result.error,
    updatedAt: new Date().toISOString(),
  }
}

export function pipelineFields(payload: DocumentPipelineStatus) {
  return {
    pipelineStatus: payload.status,
    mineruStatus: payload.mineru_status,
    embeddingStatus: payload.embedding_status,
    vectorStatus: payload.vector_status,
    pipelineError: payload.error || null,
    chunkCount: Number(payload.chunk_count || 0) || null,
    indexedChunkCount: Number(
      payload.vector_completed_chunks || payload.embedding_completed_chunks || 0,
    ) || null,
  }
}

export async function syncLecturePipelineResult(
  fileId: string,
  payload: DocumentPipelineStatus,
) {
  const file = getKnowledgeFile(fileId)
  if (!file) return
  await upsertKnowledgeFile({
    fileId,
    sourceKey: file.sourceKey,
    fileName: file.fileName,
    pageCount: Number(payload.page_count || file.pageCount),
    byteSize: file.byteSize,
    markdown: payload.status === 'completed' ? String(payload.markdown || file.markdown) : file.markdown,
    layoutBlocks: payload.status === 'completed'
      ? ((payload.layout_blocks as StructuredDocumentBlock[] | undefined) ?? file.layoutBlocks)
      : file.layoutBlocks,
    courseId: file.courseId,
    ...pipelineFields(payload),
  })
}
