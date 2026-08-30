import { useEffect, useState } from 'react'
import {
  getLecturePageRelations,
  getQuestionRelations,
  type QuestionRelation,
} from '../../../lib/questionRelations'
import type { RelatedMaterialCard } from '../types'

export function mapQuestionRelationCards(relations: QuestionRelation[]): RelatedMaterialCard[] {
  return relations
    .map((relation) => {
      const target = relation.target
      const documentType = String(target.document_type || '')
      return {
        id: relation.relation_id,
        kind: documentType === 'lecture' ? ('lecture' as const) : ('question' as const),
        documentId: String(target.document_id || ''),
        documentName: String(target.document_name || ''),
        documentType,
        pageNumber: Number(target.page_number) || null,
        questionId: target.question_id ? String(target.question_id) : null,
        title: String(target.title || ''),
        content: String(target.content || ''),
        chapter: '',
        confidence: typeof relation.confidence === 'number' ? relation.confidence : null,
      }
    })
    .filter((card) => Boolean(card.documentId))
}

export function mapLecturePageRelationCards(
  relations: QuestionRelation[],
  lectureDocumentId: string,
  pageNumber: number,
): RelatedMaterialCard[] {
  return relations
    .map<RelatedMaterialCard | null>((relation) => {
      const { question, target } = relation
      if (
        !question?.document_id ||
        String(target.document_id || '') !== lectureDocumentId ||
        Number(target.page_number) !== pageNumber
      ) {
        return null
      }
      return {
        id: relation.relation_id,
        kind: 'question',
        documentId: String(question.document_id),
        documentName: String(question.document_name || ''),
        documentType: String(question.document_type || ''),
        pageNumber: Number(question.page_number) || null,
        questionId: question.question_id ? String(question.question_id) : null,
        title: String(question.title || ''),
        content: String(question.content || ''),
        chapter: String(question.analysis?.chapter || ''),
        confidence: typeof relation.confidence === 'number' ? relation.confidence : null,
      }
    })
    .filter((card): card is RelatedMaterialCard => card !== null)
}

function waitForNextPoll(signal: AbortSignal, delayMs: number) {
  return new Promise<void>((resolve) => {
    const timeoutId = window.setTimeout(resolve, delayMs)
    signal.addEventListener('abort', () => {
      window.clearTimeout(timeoutId)
      resolve()
    }, { once: true })
  })
}

export function useRelatedMaterials({
  courseId,
  sourceKind,
  questionId,
  lectureDocumentId,
  pageNumber,
}: {
  courseId: string | null
  sourceKind: 'lecture' | 'homework'
  questionId: string | null
  lectureDocumentId: string | null
  pageNumber: number
}) {
  const [cards, setCards] = useState<RelatedMaterialCard[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const sourceQuestionId = sourceKind === 'homework' ? questionId : null
    const sourceLectureId = sourceKind === 'lecture' ? lectureDocumentId : null
    if (!courseId || (!sourceQuestionId && !sourceLectureId)) {
      setCards([])
      setIsLoading(false)
      return () => controller.abort()
    }

    setIsLoading(true)
    void (async () => {
      try {
        for (let attempt = 0; attempt < 120 && !controller.signal.aborted; attempt += 1) {
          const record = sourceQuestionId
            ? await getQuestionRelations(sourceQuestionId, controller.signal)
            : await getLecturePageRelations(courseId, sourceLectureId!, pageNumber, controller.signal)
          if (controller.signal.aborted) return
          setCards(sourceQuestionId
            ? mapQuestionRelationCards(record.relations)
            : mapLecturePageRelationCards(record.relations, sourceLectureId!, pageNumber))
          if (!sourceQuestionId || !['missing', 'processing'].includes(record.status)) break
          await waitForNextPoll(controller.signal, 5_000)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.warn('Unable to load related materials:', error)
          setCards([])
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false)
      }
    })()
    return () => controller.abort()
  }, [courseId, lectureDocumentId, pageNumber, questionId, sourceKind])

  const removeRelatedMaterial = (cardId: string) => {
    setCards((current) => current.filter((candidate) => candidate.id !== cardId))
  }

  return {
    relatedMaterialCards: cards,
    isLoadingRelatedMaterials: isLoading,
    removeRelatedMaterial,
  }
}
