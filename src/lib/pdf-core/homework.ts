import type { HomeworkQuestion } from '../../types'

function normalizeInlineText(text: string) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([，。！？；：“”‘’（）《》【】])\s+/g, '$1')
    .replace(/\s+([，。！？；：“”‘’）》】])/g, '$1')
    .trim()
}

function normalizeHomeworkSearchText(text: string) {
  return normalizeInlineText(text)
    .toLowerCase()
    .replace(/\s+/g, '')
}

function normalizeHomeworkLooseText(text: string) {
  return normalizeHomeworkSearchText(text).replace(/[^\p{L}\p{N}]+/gu, '')
}

function extractQuestionNumberMarker(title: string) {
  const dotted = title.match(/(\d+(?:\.\d+)+)/)
  if (dotted?.[1]) {
    return dotted[1]
  }

  const simple = title.match(/第\s*(\d+)\s*题/u)
  if (simple?.[1]) {
    return `第${simple[1]}题`
  }

  return null
}

function buildHomeworkQuestionCandidates(question: HomeworkQuestion) {
  const candidates = new Set<string>()
  const push = (value: string | null | undefined) => {
    const normalized = String(value ?? '').trim()
    if (normalized.length >= 2) {
      candidates.add(normalized)
    }
  }

  push(question.anchorText)
  push(question.title)

  const content = normalizeInlineText(question.content || '')
  if (content) {
    push(content.slice(0, 120))
    content
      .split(/[。！？；\n]/)
      .map((part) => normalizeInlineText(part))
      .filter((part) => part.length >= 6)
      .slice(0, 4)
      .forEach(push)
  }

  push(extractQuestionNumberMarker(question.title))
  return Array.from(candidates)
}

function findQuestionStartPage(
  question: HomeworkQuestion,
  pageTexts: Array<{ compact: string; loose: string }>,
  startIndex: number,
) {
  const candidates = buildHomeworkQuestionCandidates(question)
  if (!candidates.length) {
    return null
  }

  const normalizedCandidates = candidates.map((candidate) => ({
    compact: normalizeHomeworkSearchText(candidate),
    loose: normalizeHomeworkLooseText(candidate),
  }))

  const matchFrom = (fromIndex: number) => {
    for (let pageIndex = fromIndex; pageIndex < pageTexts.length; pageIndex += 1) {
      const page = pageTexts[pageIndex]
      const matched = normalizedCandidates.some(
        (candidate) =>
          (candidate.compact.length >= 2 && page.compact.includes(candidate.compact)) ||
          (candidate.loose.length >= 2 && page.loose.includes(candidate.loose)),
      )

      if (matched) {
        return pageIndex
      }
    }

    return null
  }

  return matchFrom(startIndex) ?? matchFrom(0)
}

export function resolveHomeworkQuestionPages(
  questions: HomeworkQuestion[],
  pageTexts: string[],
  pageCount: number,
) {
  const normalizedPages = pageTexts.map((text) => ({
    compact: normalizeHomeworkSearchText(text),
    loose: normalizeHomeworkLooseText(text),
  }))

  let cursor = 0

  return questions.map((question) => {
    const matchedPageIndex = findQuestionStartPage(question, normalizedPages, cursor)
    const fallbackPageNumber =
      typeof question.pageNumber === 'number' &&
      Number.isFinite(question.pageNumber) &&
      question.pageNumber >= 1 &&
      question.pageNumber <= pageCount
        ? question.pageNumber
        : Math.min(pageCount, Math.max(1, cursor + 1))
    const resolvedPageNumber =
      matchedPageIndex !== null ? matchedPageIndex + 1 : fallbackPageNumber

    if (matchedPageIndex !== null) {
      cursor = matchedPageIndex + 1
    } else {
      cursor = Math.min(pageCount - 1, Math.max(cursor, resolvedPageNumber - 1))
    }

    return resolvedPageNumber === question.pageNumber
      ? question
      : {
          ...question,
          pageNumber: resolvedPageNumber,
        }
  })
}
