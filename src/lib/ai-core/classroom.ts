import type {
  AsrTranscriptPayload,
  ClassroomLectureSegment,
  ClassroomSession,
  TranscriptSentence,
} from '../../types'

const CLASSROOM_TRANSCRIPT_WINDOW_CHARS = 500
const CLASSROOM_TRANSCRIPT_WINDOW_STRIDE = 380

type LecturePage = {
  pageNumber: number
  content: string
}

export type TranscriptMappingWindow = {
  id: string
  index: number
  text: string
  sentenceIds: string[]
  startSeconds: number | null
  endSeconds: number | null
  startSentenceOrder: number
  endSentenceOrder: number
}

export type SlidingWindowCandidatePage = {
  pageIndex: number
  pageNumber: number
  content: string
  role: 'buffer' | 'current'
  score: number
}

export function normalizeSearchText(text: string) {
  return text
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function splitLectureMarkdownPages(lectureMarkdown: string): LecturePage[] {
  const matches = Array.from(lectureMarkdown.matchAll(/^##\s*[^\n\r]*?(\d+)[^\n\r]*$/gm))

  if (!matches.length) {
    return []
  }

  return matches
    .map((match, index) => {
      const pageNumber = Number(match[1])
      if (!Number.isFinite(pageNumber)) {
        return null
      }

      const start = match.index ?? 0
      const end =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? lectureMarkdown.length)
          : lectureMarkdown.length

      const content = lectureMarkdown
        .slice(start, end)
        .replace(/^##\s*[^\n\r]*$/m, '')
        .replace(/\s+/g, ' ')
        .trim()

      return { pageNumber, content }
    })
    .filter((page): page is LecturePage => page !== null)
}

export function buildLecturePageDigest(lectureMarkdown: string) {
  const pages = splitLectureMarkdownPages(lectureMarkdown)
  if (!pages.length) {
    return lectureMarkdown.slice(0, 36000)
  }

  return pages
    .map((page) => `Page ${page.pageNumber}: ${page.content.slice(0, 420)}`)
    .join('\n')
    .slice(0, 36000)
}

export function buildLecturePageAnchors(lectureMarkdown: string): LecturePage[] {
  const pages = splitLectureMarkdownPages(lectureMarkdown)
  if (!pages.length) {
    return [{ pageNumber: 1, content: lectureMarkdown.trim() }].filter((page) => page.content)
  }

  return pages
    .map((page) => ({
      pageNumber: page.pageNumber,
      content: page.content.trim(),
    }))
    .filter((page) => page.content)
}

export function buildTranscriptMappingWindows(
  transcriptSentences: TranscriptSentence[],
  windowChars = CLASSROOM_TRANSCRIPT_WINDOW_CHARS,
  strideChars = CLASSROOM_TRANSCRIPT_WINDOW_STRIDE,
) {
  const usableSentences = transcriptSentences.filter((sentence) => sentence.text.trim())
  if (!usableSentences.length) {
    return [] as TranscriptMappingWindow[]
  }

  let cursor = 0
  const sentenceRanges = usableSentences.map((sentence) => {
    const text = sentence.text.trim()
    const start = cursor
    const end = start + text.length
    cursor = end + 1
    return {
      sentence,
      text,
      start,
      end,
    }
  })

  const totalLength = Math.max(0, cursor - 1)
  const windows: TranscriptMappingWindow[] = []
  const seenRanges = new Set<string>()

  for (let startChar = 0, windowIndex = 0; startChar < totalLength; startChar += strideChars, windowIndex += 1) {
    const endChar = Math.min(totalLength, startChar + windowChars)
    const included = sentenceRanges.filter((entry) => entry.end > startChar && entry.start < endChar)
    if (!included.length) {
      if (endChar >= totalLength) {
        break
      }
      continue
    }

    const startSentenceOrder = included[0]?.sentence.order ?? 0
    const endSentenceOrder = included[included.length - 1]?.sentence.order ?? startSentenceOrder
    const rangeKey = `${startSentenceOrder}-${endSentenceOrder}`
    if (seenRanges.has(rangeKey)) {
      if (endChar >= totalLength) {
        break
      }
      continue
    }
    seenRanges.add(rangeKey)

    windows.push({
      id: `window-${windowIndex + 1}`,
      index: windowIndex,
      text: included.map((entry) => entry.text).join('\n').trim(),
      sentenceIds: included.map((entry) => entry.sentence.id),
      startSeconds: included.find((entry) => entry.sentence.startSeconds !== null)?.sentence.startSeconds ?? null,
      endSeconds:
        [...included].reverse().find((entry) => entry.sentence.endSeconds !== null)?.sentence.endSeconds ?? null,
      startSentenceOrder,
      endSentenceOrder,
    })

    if (endChar >= totalLength) {
      break
    }
  }

  return windows
}

export function summarizeLectureSegmentText(text: string) {
  return text.replace(/\s+/g, ' ').trim().slice(0, 96)
}

function mergeLectureSegmentText(current: string, next: string) {
  const normalizedCurrent = current.trim()
  const normalizedNext = next.trim()
  if (!normalizedCurrent) {
    return normalizedNext
  }
  if (!normalizedNext) {
    return normalizedCurrent
  }
  if (normalizedCurrent.includes(normalizedNext)) {
    return normalizedCurrent
  }
  if (normalizedNext.includes(normalizedCurrent)) {
    return normalizedNext
  }
  return `${normalizedCurrent}\n${normalizedNext}`.trim()
}

export function mergeSequentialClassroomSegments(segments: ClassroomLectureSegment[]) {
  const merged: ClassroomLectureSegment[] = []

  for (const segment of segments) {
    const previous = merged[merged.length - 1]
    const samePages =
      previous &&
      previous.pageNumbers.length === segment.pageNumbers.length &&
      previous.pageNumbers.every((pageNumber, index) => pageNumber === segment.pageNumbers[index])
    const hasOverlappingSourceIds =
      previous &&
      previous.sourceSentenceIds.some((sentenceId) => segment.sourceSentenceIds.includes(sentenceId))

    if (previous && samePages && hasOverlappingSourceIds) {
      previous.polishedText = mergeLectureSegmentText(previous.polishedText, segment.polishedText)
      previous.summary = summarizeLectureSegmentText(previous.polishedText)
      previous.anchorText = previous.anchorText || segment.anchorText
      previous.endSeconds = segment.endSeconds ?? previous.endSeconds
      previous.sourceSentenceIds = Array.from(
        new Set([...previous.sourceSentenceIds, ...segment.sourceSentenceIds]),
      )
      continue
    }

    merged.push({
      ...segment,
      pageNumbers: [...segment.pageNumbers],
      sourceSentenceIds: [...segment.sourceSentenceIds],
    })
  }

  return merged
}

export function splitTranscriptTextIntoSentences(transcript: string): TranscriptSentence[] {
  const normalized = transcript.replace(/\r\n/g, '\n').trim()
  if (!normalized) {
    return []
  }

  const fragments =
    normalized.match(/[^。！？?!\n]+[。！？?!\n]*/gu)?.map((fragment) => fragment.trim()).filter(Boolean) ??
    [normalized]

  return fragments.map((fragment, index) => ({
    id: `text-sentence-${index + 1}`,
    text: fragment,
    startSeconds: null,
    endSeconds: null,
    order: index,
  }))
}

export function normalizeTranscriptSentences(rawSentences: unknown, transcript: string): TranscriptSentence[] {
  if (!Array.isArray(rawSentences) || !rawSentences.length) {
    return splitTranscriptTextIntoSentences(transcript)
  }

  const normalized = rawSentences
    .map((item, index) => {
      const partial = item as Record<string, unknown>
      const text = String(partial.text || '').trim()
      if (!text) {
        return null
      }

      const startSeconds = Number(partial.startSeconds)
      const endSeconds = Number(partial.endSeconds)
      return {
        id: String(partial.id || `sentence-${index + 1}`),
        text,
        startSeconds: Number.isFinite(startSeconds) ? startSeconds : null,
        endSeconds: Number.isFinite(endSeconds) ? endSeconds : null,
        order:
          Number.isFinite(Number(partial.order)) && Number(partial.order) >= 0
            ? Number(partial.order)
            : index,
      } satisfies TranscriptSentence
    })
    .filter((item): item is TranscriptSentence => item !== null)
    .sort((left, right) => left.order - right.order)

  return normalized.length ? normalized : splitTranscriptTextIntoSentences(transcript)
}

export function deriveLecturePageFromAnchor(lectureMarkdown: string, anchorText: string) {
  const normalizedAnchor = anchorText.trim()
  if (!normalizedAnchor) {
    return null
  }

  const anchorIndex = lectureMarkdown.indexOf(normalizedAnchor)
  if (anchorIndex < 0) {
    return null
  }

  const preceding = lectureMarkdown.slice(0, anchorIndex)
  const pageMarkers = Array.from(preceding.matchAll(/^##\s*[^\n\r]*?(\d+)[^\n\r]*$/gm))
  const lastMatch = pageMarkers.at(-1)
  if (!lastMatch) {
    return null
  }

  const pageNumber = Number(lastMatch[1])
  return Number.isFinite(pageNumber) ? pageNumber : null
}

export function deriveLecturePageFromSignals(
  lectureMarkdown: string,
  signals: Array<string | null | undefined>,
) {
  const pages = splitLectureMarkdownPages(lectureMarkdown)
  if (!pages.length) {
    return null
  }

  const normalizedSignals = signals
    .map((signal) => normalizeSearchText(String(signal ?? '').trim()))
    .filter((signal) => signal.length >= 2)

  if (!normalizedSignals.length) {
    return null
  }

  let bestPageNumber: number | null = null
  let bestScore = 0

  pages.forEach((page) => {
    const haystack = normalizeSearchText(page.content)
    if (!haystack) {
      return
    }

    let score = 0
    normalizedSignals.forEach((signal) => {
      if (haystack.includes(signal)) {
        score += Math.max(signal.length, 1)
      }
    })

    if (score > bestScore) {
      bestScore = score
      bestPageNumber = page.pageNumber
    }
  })

  return bestScore > 0 ? bestPageNumber : null
}

export function normalizeClassroomSegmentsPayload(
  payload: Record<string, unknown>,
  lectureMarkdown: string,
  fallbackPageNumbers: number[] = [],
): ClassroomLectureSegment[] {
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : []
  const fallbackRetrievedPages = Array.from(
    new Set(
      fallbackPageNumbers.filter(
        (pageNumber) => Number.isFinite(pageNumber) && pageNumber > 0,
      ),
    ),
  ).slice(0, 3)

  return rawSegments
    .map((item) => {
      const partial = item as Record<string, unknown>
      const title = String(partial.title || 'Lecture Segment').trim()
      const summary = String(partial.summary || '').trim()
      const polishedText = String(partial.polishedText || partial.content || '').trim()
      const anchorText = String(partial.anchorText || '').trim()
      const modelPages = Array.isArray(partial.pageNumbers)
        ? partial.pageNumbers
            .map((pageNumber) => Number(pageNumber))
            .filter((pageNumber) => Number.isFinite(pageNumber) && pageNumber > 0)
        : []
      const derivedPage =
        deriveLecturePageFromAnchor(lectureMarkdown, anchorText) ??
        deriveLecturePageFromSignals(lectureMarkdown, [
          anchorText,
          title,
          summary,
          polishedText.slice(0, 220),
        ])
      const pageNumbers = Array.from(
        new Set(
          [...modelPages, ...(derivedPage ? [derivedPage] : []), ...fallbackRetrievedPages].filter(
            (pageNumber) => Number.isFinite(pageNumber) && pageNumber > 0,
          ),
        ),
      )

      if (!polishedText) {
        return null
      }

      const segment: ClassroomLectureSegment = {
        id: crypto.randomUUID(),
        recordingId: null,
        title: title || 'Lecture Segment',
        summary,
        polishedText,
        anchorText: anchorText || null,
        pageNumbers,
        startSeconds:
          Number.isFinite(Number(partial.startSeconds)) ? Number(partial.startSeconds) : null,
        endSeconds:
          Number.isFinite(Number(partial.endSeconds)) ? Number(partial.endSeconds) : null,
        sourceSentenceIds: Array.isArray(partial.sourceSentenceIds)
          ? partial.sourceSentenceIds
              .map((sentenceId) => String(sentenceId || '').trim())
              .filter(Boolean)
          : [],
        createdAt: new Date().toISOString(),
      }

      return segment
    })
    .filter((segment): segment is ClassroomLectureSegment => segment !== null)
}

export function buildFallbackClassroomSession(
  transcript: string,
  lectureMarkdown: string,
): ClassroomSession {
  const pageNumber =
    deriveLecturePageFromSignals(lectureMarkdown, [transcript.slice(0, 240)]) ?? null

  return {
    id: crypto.randomUUID(),
    transcript,
    polishedOverview: transcript,
    segments: [
      {
        id: crypto.randomUUID(),
        recordingId: null,
        title: 'Lecture Notes',
        summary: transcript.slice(0, 120),
        polishedText: transcript,
        anchorText: null,
        pageNumbers: pageNumber ? [pageNumber] : [],
        startSeconds: null,
        endSeconds: null,
        sourceSentenceIds: [],
        createdAt: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export function normalizeTranscriptPayload(
  transcriptInput: string | AsrTranscriptPayload,
): AsrTranscriptPayload {
  return typeof transcriptInput === 'string'
    ? ({
        text: transcriptInput,
        sentences: splitTranscriptTextIntoSentences(transcriptInput),
      } satisfies AsrTranscriptPayload)
    : transcriptInput
}
