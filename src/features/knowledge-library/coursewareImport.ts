import { resolveBackendApiUrl } from '../../lib/apiConfig'
import { getKnowledgeFileBySourceKey, upsertKnowledgeFile } from '../../lib/knowledgeBase'
import {
  moveLectureDocumentToCourse,
  processLectureDocumentWithPipeline,
} from '../../lib/mineru'
import { extractPdfPreview, probePdfPageCount } from '../../lib/pdf'
import type { TsinghuaCoursewareFile } from '../../lib/tsinghuaCourses'
import type { KnowledgeFile } from '../../types'

export type CoursewareImportOutcome = {
  importedCount: number
  importFailedCount: number
  failureReasons: string[]
}

type ImportCoursewareFilesOptions = {
  remoteFiles: TsinghuaCoursewareFile[]
  fetchFile: (remoteFile: TsinghuaCoursewareFile) => Promise<Blob>
  resolveCourseId: (remoteFile: TsinghuaCoursewareFile) => Promise<string | null> | string | null
  onProgressMessage?: (message: string) => void
  shouldImport?: (remoteFile: TsinghuaCoursewareFile) => boolean
}

type StagedCoursewareFile = {
  remoteFile: TsinghuaCoursewareFile
  importedFile: File
  savedFile: KnowledgeFile
  movedBetweenCourses: boolean
}

export async function convertOfficeToPdf(file: File): Promise<File> {
  const formData = new FormData()
  formData.append('file', file)

  const response = await fetch(resolveBackendApiUrl('/api/office/to-pdf'), {
    method: 'POST',
    body: formData,
  })
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || `Office 转 PDF 失败 (HTTP ${response.status})`)
  }

  const blob = await response.blob()
  const contentType = (response.headers.get('content-type') || blob.type || '').toLowerCase()
  if (contentType && !contentType.includes('application/pdf')) {
    const detail = (await blob.text().catch(() => '')).trim()
    throw new Error(detail || 'Office 转 PDF 失败：后端没有返回 PDF 文件。')
  }

  return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.pdf`, {
    type: 'application/pdf',
  })
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }
  return fallback
}

function inferCoursewareExtension(remoteFile: TsinghuaCoursewareFile) {
  const fromNameMatch = String(remoteFile.fileName || '').match(/(\.[a-zA-Z0-9]+)$/)
  if (fromNameMatch) {
    return fromNameMatch[1]!.toLowerCase()
  }

  const mimeType = String(remoteFile.mimeType || '').toLowerCase()
  if (mimeType === 'application/pdf') {
    return '.pdf'
  }
  if (mimeType.includes('presentationml.presentation')) {
    return '.pptx'
  }
  if (mimeType.includes('ms-powerpoint')) {
    return '.ppt'
  }
  if (mimeType.includes('wordprocessingml.document')) {
    return '.docx'
  }
  if (mimeType === 'application/msword') {
    return '.doc'
  }
  return ''
}

export function buildCoursewareImportName(
  remoteFile: TsinghuaCoursewareFile,
  forceExtension?: string,
) {
  const rawBase = String(remoteFile.displayName || remoteFile.fileName || 'courseware').trim()
  const sanitizedBase = rawBase.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'courseware'
  const currentExtension = sanitizedBase.match(/(\.[a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() || ''
  const extension = (
    forceExtension ||
    currentExtension ||
    inferCoursewareExtension(remoteFile)
  ).toLowerCase()
  const baseWithoutExtension = currentExtension
    ? sanitizedBase.slice(0, -currentExtension.length).trim() || 'courseware'
    : sanitizedBase

  return extension ? `${baseWithoutExtension}${extension}` : sanitizedBase
}

export async function importCoursewareFiles({
  remoteFiles,
  fetchFile,
  resolveCourseId,
  onProgressMessage,
  shouldImport,
}: ImportCoursewareFilesOptions): Promise<CoursewareImportOutcome> {
  let importedCount = 0
  let importFailedCount = 0
  const failureReasons: string[] = []
  const stagedFiles: StagedCoursewareFile[] = []

  for (const [index, remoteFile] of remoteFiles.entries()) {
    if (shouldImport && !shouldImport(remoteFile)) {
      continue
    }
    let importedFile: File | null = null
    try {
      onProgressMessage?.(`正在保存课件 ${index + 1}/${remoteFiles.length}：${buildCoursewareImportName(remoteFile)}...`)
      const blob = await fetchFile(remoteFile)
      if (shouldImport && !shouldImport(remoteFile)) {
        continue
      }
      const courseId = await resolveCourseId(remoteFile)
      importedFile = new File([blob], buildCoursewareImportName(remoteFile), {
        type: remoteFile.mimeType || blob.type || 'application/octet-stream',
      })

      if (remoteFile.kind === 'archive') {
        throw new Error('压缩包暂不支持自动导入')
      }

      if (remoteFile.kind === 'office') {
        onProgressMessage?.(`正在将 ${importedFile.name} 转为 PDF...`)
        const pdfFile = await convertOfficeToPdf(importedFile)
        importedFile = new File([pdfFile], buildCoursewareImportName(remoteFile, '.pdf'), {
          type: 'application/pdf',
        })
      }

      if (remoteFile.kind !== 'pdf' && remoteFile.kind !== 'office') {
        throw new Error('暂不支持该类课件自动导入知识库')
      }

      if (shouldImport && !shouldImport(remoteFile)) {
        continue
      }
      const pdfBuffer = await importedFile.arrayBuffer()
      let markdown = ''
      let pageCount = 0

      try {
        const preview = await extractPdfPreview(importedFile)
        markdown = preview.markdown
        pageCount = preview.pageCount
      } catch (error) {
        console.warn('courseware preview extraction failed, falling back to page count only:', error)
        pageCount = await probePdfPageCount(importedFile).catch((pageCountError) => {
          console.warn('courseware page-count probe failed:', pageCountError)
          return 0
        })
      }

      const sourceKey = `tsinghua-courseware:${remoteFile.id}`
      const existingFile = getKnowledgeFileBySourceKey(sourceKey)
      const savedFile = await upsertKnowledgeFile({
        sourceKey,
        fileName: importedFile.name,
        pageCount,
        byteSize: pdfBuffer.byteLength,
        markdown,
        layoutBlocks: [],
        pdfBuffer,
        courseId,
        pipelineStatus: 'queued',
        mineruStatus: 'pending',
        embeddingStatus: 'pending',
        vectorStatus: 'pending',
        pipelineError: null,
      })
      stagedFiles.push({
        remoteFile,
        importedFile,
        savedFile,
        movedBetweenCourses: Boolean(existingFile && existingFile.courseId !== savedFile.courseId),
      })
    } catch (error) {
      console.error('courseware staging failed:', error)
      importFailedCount += 1
      failureReasons.push(
        `${remoteFile.displayName || remoteFile.fileName || importedFile?.name || '未命名文件'}：${getErrorMessage(error, 'PDF 保存到知识库失败')}`,
      )
    }
  }

  if (stagedFiles.length) {
    onProgressMessage?.(`全部 ${stagedFiles.length} 份课件已保存，可立即预览；现在开始按队列解析。`)
  }

  for (const [index, stagedFile] of stagedFiles.entries()) {
    const { remoteFile, importedFile, savedFile, movedBetweenCourses } = stagedFile
    if (shouldImport && !shouldImport(remoteFile)) {
      continue
    }
    try {
      onProgressMessage?.(
        movedBetweenCourses
          ? `正在调整课件 ${index + 1}/${stagedFiles.length} 的课程归属并重建索引：${importedFile.name}...`
          : `正在提交课件 ${index + 1}/${stagedFiles.length} 到 MinerU 解析队列：${importedFile.name}...`,
      )
      if (!movedBetweenCourses) {
        // Wait for the complete pipeline before advancing the queue. The
        // submit-only API returns "queued" and would enqueue every courseware
        // file in MinerU at once.
        const processed = await processLectureDocumentWithPipeline(
          importedFile,
          savedFile.courseId,
          savedFile.id,
        )
        await upsertKnowledgeFile({
          fileId: savedFile.id,
          sourceKey: savedFile.sourceKey,
          fileName: savedFile.fileName,
          pageCount: processed.pageCount ?? savedFile.pageCount,
          byteSize: savedFile.byteSize,
          markdown: processed.markdown,
          layoutBlocks: processed.layoutBlocks,
          courseId: savedFile.courseId,
          pipelineStatus: 'completed',
          mineruStatus: 'completed',
          embeddingStatus: 'completed',
          vectorStatus: 'completed',
          pipelineError: null,
        })
        importedCount += 1
        continue
      }

      const parsed = await moveLectureDocumentToCourse(savedFile.id, savedFile.courseId)
      if (shouldImport && !shouldImport(remoteFile)) {
        continue
      }
      await upsertKnowledgeFile({
        fileId: savedFile.id,
        sourceKey: savedFile.sourceKey,
        fileName: savedFile.fileName,
        pageCount: parsed.pageCount ?? savedFile.pageCount,
        byteSize: savedFile.byteSize,
        markdown: parsed.markdown,
        layoutBlocks: parsed.layoutBlocks,
        courseId: savedFile.courseId,
        pipelineStatus: 'completed',
        mineruStatus: 'completed',
        embeddingStatus: 'completed',
        vectorStatus: 'completed',
        pipelineError: null,
      })
      importedCount += 1
    } catch (error) {
      console.error('courseware indexing failed:', error)
      importFailedCount += 1
      const reason = getErrorMessage(error, 'MinerU 解析或知识库索引失败')
      failureReasons.push(`${remoteFile.displayName || remoteFile.fileName || importedFile.name}：${reason}`)
      await upsertKnowledgeFile({
        fileId: savedFile.id,
        sourceKey: savedFile.sourceKey,
        fileName: savedFile.fileName,
        pageCount: savedFile.pageCount,
        byteSize: savedFile.byteSize,
        markdown: savedFile.markdown,
        layoutBlocks: savedFile.layoutBlocks,
        courseId: savedFile.courseId,
        pipelineStatus: 'mineru_failed',
        mineruStatus: 'failed',
        embeddingStatus: savedFile.embeddingStatus ?? 'pending',
        vectorStatus: savedFile.vectorStatus ?? 'pending',
        pipelineError: reason,
      }).catch((statusError) => {
        console.warn('failed to persist courseware indexing failure:', statusError)
      })
    }
  }

  return {
    importedCount,
    importFailedCount,
    failureReasons,
  }
}

export function formatCoursewareImportSummary(input: {
  downloadedCount: number
  importedCount: number
  failedCount: number
  failureReasons: string[]
  successLabel: string
}) {
  const { downloadedCount, importedCount, failedCount, failureReasons, successLabel } = input
  if (failedCount > 0) {
    const failureSummary = failureReasons.slice(0, 3).join('；')
    return `网络学堂下载成功 ${downloadedCount} 份课件，导入成功 ${importedCount} 份，失败 ${failedCount} 份。原因：${failureSummary}${failureReasons.length > 3 ? '；其余失败原因已写入控制台日志。' : '。'}`
  }

  return `网络学堂下载成功 ${downloadedCount} 份课件，并已全部导入到${successLabel}。`
}
