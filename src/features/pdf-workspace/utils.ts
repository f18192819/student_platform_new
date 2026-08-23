import type {
  ApiConfig,
  ChatMessage,
  ClassroomLectureSegment,
  ClassroomSession,
  HomeworkDocument,
  HomeworkKnowledgeLink,
  HomeworkQuestion,
  StructuredDocumentBlock,
  StoredDoubtAnnotation,
} from '../../types'
import type { DraftDoubt, PageQuestionEntry } from './types'

export const LEFT_PANEL_WIDTH_KEY = 'student-platform.reader-left-width'
export const RIGHT_PANEL_WIDTH_KEY = 'student-platform.reader-right-width'
export const LEFT_PANEL_TOP_HEIGHT_KEY = 'student-platform.reader-left-top-height'
export const LEFT_PANEL_MIN = 280
export const LEFT_PANEL_MAX = 520
export const RIGHT_PANEL_MIN = 320
export const RIGHT_PANEL_MAX = 620
export const LEFT_PANEL_VERTICAL_RESIZER_SIZE = 10
export const DEFAULT_DOCUMENT_NAME = '未打开 PDF'

const EXISTING_MATH_PATTERN = /(\$\$[\s\S]*?\$\$|\$[^$\n]+\$)/g
const INLINE_FORMULA_PATTERN =
  /([A-Za-z0-9|][A-Za-z0-9|/().,+\-*×·_ μ₀₁₂₃₄₅₆₇₈₉εωθλδφαβγΩ√≤≥≠^²³]*=[A-Za-z0-9|/().,+\-*×·_ μ₀₁₂₃₄₅₆₇₈₉εωθλδφαβγΩ√≤≥≠^²³]+)/g

export function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: `${role}-${crypto.randomUUID()}`,
    role,
    content,
    createdAt: new Date().toISOString(),
  }
}

export function createDraftDoubt(pageNumber: number | null): DraftDoubt {
  return {
    id: crypto.randomUUID(),
    pageNumber,
  }
}

export function loadPanelWidth(storageKey: string, fallback: number) {
  if (typeof window === 'undefined') {
    return fallback
  }

  const raw = window.localStorage.getItem(storageKey)
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : fallback
}

export function clampPanelWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function clampPanelHeight(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function emitLessonProcessingState(label: string) {
  window.dispatchEvent(
    new CustomEvent('student-platform:lesson-processing-state', {
      detail: { label },
    }),
  )
}

export async function readFileAsDataUrl(file: Blob) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}

export function appendRelatedQuestionId(
  annotations: StoredDoubtAnnotation[],
  annotationId: string,
  questionMessageId: string,
) {
  return annotations.map((annotation) =>
    annotation.id === annotationId
      ? {
          ...annotation,
          relatedQuestionIds: Array.from(
            new Set([...annotation.relatedQuestionIds, questionMessageId]),
          ),
          updatedAt: new Date().toISOString(),
        }
      : annotation,
  )
}

export function updateMessageContent(
  messages: ChatMessage[],
  messageId: string,
  updater: (current: string) => string,
) {
  return messages.map((message) =>
    message.id === messageId
      ? {
          ...message,
          content: updater(message.content),
        }
      : message,
  )
}

function buildAnnotationLedger(annotations: StoredDoubtAnnotation[]) {
  if (!annotations.length) {
    return '## 疑点记录\n\n- 暂无已保存疑点。'
  }

  return [
    '## 疑点记录',
    '',
    ...annotations.flatMap((annotation, index) => {
      const lines = [
        `### 疑点 ${index + 1}`,
        `- 页码：${annotation.pageNumber ?? '未指定'}`,
        `- 问题：${annotation.question}`,
      ]

      if (annotation.imageName) {
        lines.push(`- 图片：${annotation.imageName}`)
      }

      return [...lines, '']
    }),
  ]
    .join('\n')
    .trim()
}

export function buildKnowledgeContextMarkdown(
  documentText: string,
  annotations: StoredDoubtAnnotation[],
) {
  const sections = [documentText.trim()]
  if (annotations.length) {
    sections.push(buildAnnotationLedger(annotations))
  }
  return sections.filter(Boolean).join('\n\n').trim()
}

export function buildHomeworkContextMarkdown(
  homeworkDocument: HomeworkDocument | null,
  homeworkQuestion: HomeworkQuestion | null,
  includeFullDocument = true,
) {
  if (!homeworkDocument) {
    return ''
  }

  const sections = [
    '## 当前练习',
    `- 文件：${homeworkDocument.fileName}`,
    `- 提取状态：${homeworkDocument.status}`,
  ]

  if (homeworkQuestion) {
    sections.push('', '## 当前查看题目')
    sections.push(`- 标题：${homeworkQuestion.title || `第 ${homeworkQuestion.index + 1} 题`}`)
    sections.push(`- 页码：${homeworkQuestion.pageNumber ?? '未定位'}`)
    sections.push('', homeworkQuestion.content.trim())
  }

  if (includeFullDocument && homeworkDocument.extractedMarkdown.trim()) {
    sections.push('', '## 练习 Markdown', '', homeworkDocument.extractedMarkdown.trim())
  }

  return sections.join('\n').trim()
}

export function buildStructuredPageContext(
  blocks: StructuredDocumentBlock[],
  pageNumber: number,
  documentName: string,
) {
  const pageBlocks = blocks
    .filter((block) => block.pageNumber === pageNumber)
    .sort((left, right) => left.bbox[1] - right.bbox[1] || left.bbox[0] - right.bbox[0])
  if (!pageBlocks.length) return ''

  return [
    `文档：${documentName}`,
    `页码：${pageNumber}`,
    '',
    ...pageBlocks.map((block) => {
      const content = block.text.trim() || `[${block.kind}：${block.label || 'MinerU 非文本区块'}]`
      return `### ${block.label || block.kind}\n${content}`
    }),
  ].join('\n\n').trim()
}

export function groupLectureSegmentsByPage(sessions: ClassroomSession[]) {
  const pageMap = new Map<number, ClassroomLectureSegment[]>()

  sessions.forEach((session) => {
    session.segments.forEach((segment) => {
      segment.pageNumbers.forEach((pageNumber) => {
        const current = pageMap.get(pageNumber) ?? []
        current.push(segment)
        pageMap.set(pageNumber, current)
      })
    })
  })

  return pageMap
}

export function buildAnnotationConversation(
  annotation: StoredDoubtAnnotation | null,
  chatMessages: ChatMessage[],
): ChatMessage[] {
  if (!annotation) {
    return []
  }

  if (annotation.chatSession?.messages.length) {
    const latestMessages = new Map(chatMessages.map((message) => [message.id, message]))
    return annotation.chatSession.messages
      .filter((message) => !message.isSummary)
      .map((message) => latestMessages.get(message.id) ?? message)
  }

  const entries: ChatMessage[] = []
  const seenMessageIds = new Set<string>()
  const relatedIndexSet = new Set<number>()

  annotation.relatedQuestionIds.forEach((questionId) => {
    const questionIndex = chatMessages.findIndex((message) => message.id === questionId)
    if (questionIndex >= 0) {
      relatedIndexSet.add(questionIndex)
      if (questionIndex + 1 < chatMessages.length) {
        relatedIndexSet.add(questionIndex + 1)
      }
    }
  })

  Array.from(relatedIndexSet)
    .sort((left, right) => left - right)
    .forEach((index) => {
      const message = chatMessages[index]
      if (!message || message.role === 'system' || seenMessageIds.has(message.id)) {
        return
      }

      seenMessageIds.add(message.id)
      entries.push(message)
    })

  if (!entries.length) {
    return [
      {
        id: `${annotation.id}-seed`,
        role: 'user',
        content: annotation.question,
      },
    ]
  }

  return entries
}

function normalizeLatexExpression(input: string) {
  return input
    .replace(/\s+/g, ' ')
    .replace(/×/g, ' \\times ')
    .replace(/·/g, ' \\cdot ')
    .replace(/≤/g, ' \\le ')
    .replace(/≥/g, ' \\ge ')
    .replace(/≠/g, ' \\ne ')
    .replace(/√/g, '\\sqrt')
    .replace(/μ₀/g, '\\mu_0')
    .replace(/μ/g, '\\mu ')
    .replace(/ε₀/g, '\\varepsilon_0')
    .replace(/ε/g, '\\varepsilon ')
    .replace(/θ/g, '\\theta ')
    .replace(/ω/g, '\\omega ')
    .replace(/λ/g, '\\lambda ')
    .replace(/δ/g, '\\delta ')
    .replace(/φ/g, '\\phi ')
    .replace(/α/g, '\\alpha ')
    .replace(/β/g, '\\beta ')
    .replace(/γ/g, '\\gamma ')
    .replace(/Ω/g, '\\Omega ')
    .replace(/₀/g, '_0')
    .replace(/₁/g, '_1')
    .replace(/₂/g, '_2')
    .replace(/₃/g, '_3')
    .replace(/₄/g, '_4')
    .replace(/₅/g, '_5')
    .replace(/₆/g, '_6')
    .replace(/₇/g, '_7')
    .replace(/₈/g, '_8')
    .replace(/₉/g, '_9')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/\bsin\b/g, '\\sin')
    .replace(/\bcos\b/g, '\\cos')
    .replace(/\btan\b/g, '\\tan')
    .replace(/\blog\b/g, '\\log')
    .replace(/\bln\b/g, '\\ln')
    .replace(/([A-Za-z\\]+)_([0-9]+)/g, '$1_{$2}')
    .replace(/\s+/g, ' ')
    .trim()
}

export function normalizeLectureMarkdownMath(markdown: string) {
  const parts = markdown.split(EXISTING_MATH_PATTERN)
  return parts
    .map((part) =>
      part.startsWith('$$') || (part.startsWith('$') && part.endsWith('$'))
        ? part
        : part.replace(INLINE_FORMULA_PATTERN, (raw) => {
            if (/[\u4e00-\u9fff]/.test(raw)) {
              return raw
            }
            return `$${normalizeLatexExpression(raw)}$`
          }),
    )
    .join('')
}

export function buildLectureConversation(
  pageNumber: number | null,
  lectureSegmentsByPage: Map<number, ClassroomLectureSegment[]>,
): ChatMessage[] {
  if (pageNumber === null) {
    return []
  }

  const segments = lectureSegmentsByPage.get(pageNumber) ?? []
  return segments
    .map((segment, index) => {
      const title = segment.title.trim()
      const polishedText = normalizeLectureMarkdownMath(segment.polishedText.trim())
      const summary = normalizeLectureMarkdownMath(segment.summary.trim())
      const parts = [
        title ? `## ${title}` : `## 课堂讲解 ${index + 1}`,
        polishedText || summary,
      ].filter(Boolean)

      if (!parts.length) {
        return null
      }

      return createMessage('teacher', parts.join('\n\n'))
    })
    .filter((message): message is ChatMessage => message !== null)
}

export function groupHomeworkLinksByLecturePage(links: HomeworkKnowledgeLink[]) {
  const pageMap = new Map<number, HomeworkKnowledgeLink[]>()
  for (const link of links) {
    if (!link.lecturePageNumber) {
      continue
    }

    const current = pageMap.get(link.lecturePageNumber) ?? []
    current.push(link)
    pageMap.set(link.lecturePageNumber, current)
  }

  return pageMap
}

export function buildPageQuestionEntries(
  pageQuestionFilter: number | null,
  lecturePageQuestionLinks: Map<number, HomeworkKnowledgeLink[]>,
  homeworkDocuments: HomeworkDocument[],
): PageQuestionEntry[] {
  if (pageQuestionFilter === null) {
    return []
  }

  const pageLinks = lecturePageQuestionLinks.get(pageQuestionFilter) ?? []
  return pageLinks
    .map((link) => {
      const document = homeworkDocuments.find((item) => item.id === link.homeworkDocumentId)
      const question = document?.questions.find((item) => item.id === link.questionId)
      if (!document || !question) {
        return null
      }

      return {
        linkId: link.id,
        homeworkDocumentId: document.id,
        homeworkFileName: document.fileName,
        questionId: question.id,
        questionTitle: question.title || link.questionTitle || `第 ${(question.index ?? 0) + 1} 题`,
        questionPageNumber: question.pageNumber,
        conceptTitle: link.conceptTitle,
        lecturePageNumber: link.lecturePageNumber,
      }
    })
    .filter((entry): entry is PageQuestionEntry => entry !== null)
}

export function ensureActiveModel(config: ApiConfig) {
  const availableModels = Array.from(new Set(config.models.map((model) => model.trim()).filter(Boolean)))
  if (!availableModels.length || availableModels.includes(config.model)) {
    return null
  }

  return {
    ...config,
    model: availableModels[0],
  }
}
