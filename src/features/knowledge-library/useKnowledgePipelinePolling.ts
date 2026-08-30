import { useEffect } from 'react'
import {
  getKnowledgeHomeworkDocumentsByCourseFolder,
  saveKnowledgeHomeworkDocuments,
} from '../../lib/knowledgeBase'
import {
  getHomeworkDocumentProcessingStatus,
  getLectureDocumentProcessingStatus,
} from '../../lib/mineru'
import type { HomeworkDocument, KnowledgeFile } from '../../types'
import {
  applyQuestionPipelineResult,
  syncLecturePipelineResult,
} from './pipelineProjection'

function isPipelineFailure(status: string | null | undefined) {
  return Boolean(status && status.endsWith('_failed'))
}

export function useKnowledgePipelinePolling({
  files,
  courseId,
  folderType,
  documents,
}: {
  files: KnowledgeFile[]
  courseId: string
  folderType: 'homework' | 'past-exam' | null
  documents: HomeworkDocument[]
}) {
  const pendingFileIds = files
    .filter((file) => file.pipelineStatus
      && !isPipelineFailure(file.pipelineStatus)
      && file.pipelineStatus !== 'completed')
    .map((file) => file.id)
    .sort()
    .join('|')
  const pendingQuestionIds = documents
    .filter((document) => document.status === 'processing')
    .map((document) => document.id)
    .sort()
    .join('|')

  useEffect(() => {
    const fileIds = pendingFileIds.split('|').filter(Boolean)
    if (!fileIds.length) return
    const controller = new AbortController()
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        for (const fileId of fileIds) {
          if (controller.signal.aborted) return
          try {
            const result = await getLectureDocumentProcessingStatus(fileId)
            if (!controller.signal.aborted) await syncLecturePipelineResult(fileId, result)
          } catch (error) {
            if (!controller.signal.aborted) console.warn('document pipeline status request failed:', error)
          }
        }
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [pendingFileIds])

  useEffect(() => {
    const documentIds = pendingQuestionIds.split('|').filter(Boolean)
    if (!courseId || !folderType || !documentIds.length) return
    const controller = new AbortController()
    let polling = false
    const poll = async () => {
      if (polling) return
      polling = true
      try {
        for (const documentId of documentIds) {
          if (controller.signal.aborted) return
          try {
            const result = await getHomeworkDocumentProcessingStatus(documentId)
            if (controller.signal.aborted) return
            const current = getKnowledgeHomeworkDocumentsByCourseFolder(courseId, folderType)
            const latest = current.find((item) => item.id === documentId)
            if (!latest) continue
            const updated = applyQuestionPipelineResult(latest, result)
            saveKnowledgeHomeworkDocuments(courseId, folderType, [
              updated,
              ...current.filter((item) => item.id !== documentId),
            ])
          } catch (error) {
            if (!controller.signal.aborted) console.warn('question pipeline status request failed:', error)
          }
        }
      } finally {
        polling = false
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [courseId, folderType, pendingQuestionIds])
}
