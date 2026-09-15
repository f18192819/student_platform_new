import {
  addKnowledgeHomeworkDocument,
  getKnowledgeHomeworkDocumentsByCourseFolder,
  saveKnowledgeHomeworkDocuments,
} from '../../lib/knowledgeBase'
import {
  buildPendingHomeworkDocument,
  processHomeworkDocumentWithPipeline,
  readHomeworkAssetPayload,
} from '../../lib/mineru'
import type { TsinghuaHomeworkFile } from '../../lib/tsinghuaCourses'
import type { HomeworkDocument } from '../../types'
import { applyQuestionPipelineResult } from './pipelineProjection'

const SOURCE_KEY_PREFIX = 'tsinghua-homework:'

export type HomeworkImportOutcome = {
  importedCount: number
  importFailedCount: number
  failureReasons: string[]
}

export function homeworkSourceKey(remoteFileId: string) {
  return `${SOURCE_KEY_PREFIX}${remoteFileId}`
}

export function buildHomeworkImportName(remoteFile: TsinghuaHomeworkFile) {
  const raw = String(remoteFile.displayName || remoteFile.fileName || '网络学堂作业.pdf').trim()
  const sanitized = raw.replace(/[<>:"/\\|?*]+/g, '_').trim() || '网络学堂作业.pdf'
  return /\.pdf$/i.test(sanitized) ? sanitized : `${sanitized}.pdf`
}

function replaceDocument(courseId: string, document: HomeworkDocument) {
  const current = getKnowledgeHomeworkDocumentsByCourseFolder(courseId, 'homework')
  saveKnowledgeHomeworkDocuments(courseId, 'homework', [
    document,
    ...current.filter((item) => item.id !== document.id),
  ])
}

export async function importHomeworkFiles({
  remoteFiles,
  fetchFile,
  courseId,
  onProgressMessage,
  shouldImport,
}: {
  remoteFiles: TsinghuaHomeworkFile[]
  fetchFile: (remoteFile: TsinghuaHomeworkFile) => Promise<Blob>
  courseId: string
  onProgressMessage?: (message: string) => void
  shouldImport?: (remoteFile: TsinghuaHomeworkFile) => boolean
}): Promise<HomeworkImportOutcome> {
  let importedCount = 0
  let importFailedCount = 0
  const failureReasons: string[] = []

  for (const [index, remoteFile] of remoteFiles.entries()) {
    if (shouldImport && !shouldImport(remoteFile)) continue
    let document: HomeworkDocument | null = null
    try {
      const name = buildHomeworkImportName(remoteFile)
      onProgressMessage?.(`正在保存作业 ${index + 1}/${remoteFiles.length}：${name}...`)
      const blob = await fetchFile(remoteFile)
      if (shouldImport && !shouldImport(remoteFile)) continue
      const file = new File([blob], name, { type: remoteFile.mimeType || blob.type || 'application/pdf' })
      document = {
        ...buildPendingHomeworkDocument(file),
        sourceKey: homeworkSourceKey(remoteFile.id),
      }
      await addKnowledgeHomeworkDocument(
        courseId,
        'homework',
        document,
        await readHomeworkAssetPayload(file),
      )
      onProgressMessage?.(`正在解析作业 ${index + 1}/${remoteFiles.length}：${name}...`)
      const result = await processHomeworkDocumentWithPipeline(file, courseId, 'homework', document.id)
      replaceDocument(courseId, applyQuestionPipelineResult(document, result))
      importedCount += 1
    } catch (error) {
      importFailedCount += 1
      const reason = error instanceof Error ? error.message : '作业保存或解析失败'
      failureReasons.push(`${remoteFile.displayName || remoteFile.fileName}：${reason}`)
      if (document) {
        replaceDocument(courseId, {
          ...document,
          status: 'error',
          errorMessage: reason,
          updatedAt: new Date().toISOString(),
        })
      }
    }
  }

  return { importedCount, importFailedCount, failureReasons }
}
