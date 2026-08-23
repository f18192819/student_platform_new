import type { HomeworkDocument, HomeworkKnowledgeLink, HomeworkQuestion } from '../../types'
import {
  buildLecturePageDigest,
  deriveLecturePageFromAnchor,
  deriveLecturePageFromSignals,
  normalizeSearchText,
} from './classroom'

function formatQuestionTitle(index: number) {
  return `Question ${index}`
}

export function normalizeQuestionListPayload(
  homeworkDocumentId: string,
  payload: Array<Record<string, unknown>>,
) {
  return payload
    .map((item, index) => {
      const content = String(item.content || '').trim()
      if (!content) {
        return null
      }

      const rawTitle = String(item.title || '').trim()
      const anchorText =
        String(item.anchorText || '').trim() ||
        (rawTitle && !/^exercise\s+\d+\s+page/i.test(rawTitle) && !/^page\s+\d+/i.test(rawTitle)
          ? rawTitle
          : '') ||
        null
      const isPageMarkerOnly =
        /^exercise\s+\d+\s+page/i.test(rawTitle) ||
        /^page\s+\d+/i.test(rawTitle) ||
        /^exercise\s+\d+\s+page/i.test(content) ||
        /^page\s+\d+/i.test(content)

      if (isPageMarkerOnly) {
        return null
      }

      const rawPage = item.pageNumber
      const pageNumber =
        rawPage === null || rawPage === undefined || rawPage === ''
          ? null
          : Number.isFinite(Number(rawPage))
            ? Number(rawPage)
            : null

      const question: HomeworkQuestion = {
        id: crypto.randomUUID(),
        homeworkDocumentId,
        index: index + 1,
        title: formatQuestionTitle(index + 1),
        content,
        pageNumber: pageNumber && pageNumber > 0 ? pageNumber : null,
        anchorText,
      }

      return question
    })
    .filter((item): item is HomeworkQuestion => item !== null)
    .map((question, index) => ({
      ...question,
      index: index + 1,
      title: formatQuestionTitle(index + 1),
    }))
}

export function extractHomeworkQuestionContext(homeworkDocument: HomeworkDocument, question: HomeworkQuestion) {
  const fullText = homeworkDocument.extractedMarkdown || ''
  if (!fullText.trim()) {
    return question.content
  }

  const anchor = (question.anchorText || question.title || '').trim()
  const index = anchor ? fullText.indexOf(anchor) : -1
  if (index < 0) {
    return question.content
  }

  const start = Math.max(0, index - 600)
  const end = Math.min(fullText.length, index + Math.max(anchor.length, 1) + 1800)
  return fullText.slice(start, end).trim()
}

export function dedupeKnowledgeLinks(links: HomeworkKnowledgeLink[]) {
  const seen = new Set<string>()
  return links.filter((link) => {
    const key = [
      link.questionId,
      link.lecturePageNumber ?? 'null',
      normalizeSearchText(link.conceptTitle),
      normalizeSearchText(link.lectureAnchorText),
    ].join('::')
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

export function buildQuestionFallbackKnowledgeLink(
  lectureMarkdown: string,
  homeworkDocument: HomeworkDocument,
  question: HomeworkQuestion,
) {
  const fallbackPage =
    deriveLecturePageFromSignals(lectureMarkdown, [
      question.anchorText,
      question.title,
      question.content.slice(0, 120),
    ]) ?? null

  if (!fallbackPage) {
    return null
  }

  const link: HomeworkKnowledgeLink = {
      id: crypto.randomUUID(),
      homeworkDocumentId: homeworkDocument.id,
      lectureDocumentId: null,
      questionId: question.id,
    questionTitle: question.title,
    questionIndex: question.index,
    conceptTitle: question.title || formatQuestionTitle(question.index),
    lecturePageNumber: fallbackPage,
    lectureAnchorText: question.anchorText || question.title || '',
    lectureSnippet: 'Fallback mapping based on anchor text and nearby lecture content.',
  }

  return link
}

export function buildFallbackHomeworkKnowledgeLinks(
  lectureMarkdown: string,
  homeworkDocument: HomeworkDocument,
) {
  const fallbackLinks = homeworkDocument.questions
    .map((question) => buildQuestionFallbackKnowledgeLink(lectureMarkdown, homeworkDocument, question))
    .filter((link): link is HomeworkKnowledgeLink => Boolean(link))

  return dedupeKnowledgeLinks(fallbackLinks)
}

export function normalizeKnowledgeLinksPayload(
  lectureMarkdown: string,
  homeworkDocument: HomeworkDocument,
  question: HomeworkQuestion,
  payload: Array<Record<string, unknown>>,
) {
  const normalized = payload
    .map((item) => {
      const pageNumber = Number(item.lecturePageNumber)
      const fallbackPage =
        deriveLecturePageFromAnchor(lectureMarkdown, String(item.lectureAnchorText || '')) ??
        deriveLecturePageFromSignals(lectureMarkdown, [
          String(item.conceptTitle || ''),
          String(item.lectureAnchorText || ''),
          String(item.lectureSnippet || ''),
          question.anchorText,
          question.title,
        ])

      const resolvedPage =
        Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : (fallbackPage ?? null)

      if (!resolvedPage) {
        return null
      }

      const link: HomeworkKnowledgeLink = {
            id: crypto.randomUUID(),
            homeworkDocumentId: homeworkDocument.id,
            lectureDocumentId: null,
            questionId: question.id,
        questionTitle: question.title,
        questionIndex: question.index,
        conceptTitle: String(item.conceptTitle || question.title || formatQuestionTitle(question.index)).trim(),
        lecturePageNumber: resolvedPage,
        lectureAnchorText: String(item.lectureAnchorText || question.anchorText || question.title || '').trim(),
        lectureSnippet: String(item.lectureSnippet || '').trim() || null,
      }

      return link
    })
    .filter((item): item is HomeworkKnowledgeLink => item !== null)

  if (!normalized.length) {
    const fallback = buildQuestionFallbackKnowledgeLink(lectureMarkdown, homeworkDocument, question)
    return fallback ? [fallback] : []
  }

  return dedupeKnowledgeLinks(normalized)
}

export { buildLecturePageDigest }
