import type {
  ApiConfig,
  ChatCompactionPoint,
  ChatMessage,
  ChatReference,
  DoubtChatSession,
  ReaderChatSession,
  StoredDoubtAnnotation,
} from '../types'
import { resolveModelContextBudget } from './modelCapabilities'
import { estimateChatMessageTokens } from './tokenEstimator'

// A summary carries long-term memory; only the recent turns need to be sent verbatim.
export const CHAT_MEMORY_CONTEXT_MESSAGE_LIMIT = 10

function isConversationMessage(message: ChatMessage) {
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    Boolean(message.content.trim())
  )
}

function normalizeMessage(value: unknown): ChatMessage | null {
  if (!value || typeof value !== 'object') return null
  const partial = value as Partial<ChatMessage>
  const role = partial.role
  if (role !== 'assistant' && role !== 'user' && role !== 'system' && role !== 'teacher') {
    return null
  }
  const content = String(partial.content || '')
  const id = String(partial.id || '').trim()
  if (!id) return null
  return {
    id,
    role,
    content,
    ...(typeof partial.createdAt === 'string' ? { createdAt: partial.createdAt } : {}),
    ...(partial.isSummary === true ? { isSummary: true } : {}),
    ...(Array.isArray(partial.references)
      ? {
          references: partial.references
            .map(normalizeChatReference)
            .filter((reference): reference is ChatReference => reference !== null),
        }
      : {}),
  }
}

function normalizeChatReference(value: unknown): ChatReference | null {
  if (!value || typeof value !== 'object') return null
  const partial = value as Partial<ChatReference>
  const sourceType = partial.sourceType
  const documentId = String(partial.documentId || '').trim()
  if (
    !documentId ||
    (sourceType !== 'lecture' && sourceType !== 'homework' && sourceType !== 'past-exam')
  ) {
    return null
  }
  return {
    id: String(partial.id || `reference-${documentId}-${partial.pageNumber ?? 'unknown'}`),
    sourceType,
    documentId,
    documentName: String(partial.documentName || '未命名文档'),
    pageNumber: Number.isFinite(Number(partial.pageNumber)) ? Number(partial.pageNumber) : null,
    ...(typeof partial.blockId === 'string' || partial.blockId === null
      ? { blockId: partial.blockId }
      : {}),
    ...(typeof partial.label === 'string' ? { label: partial.label } : {}),
    ...(partial.kind ? { kind: partial.kind } : {}),
    excerpt: String(partial.excerpt || '').trim(),
  }
}

function normalizeCompactionPoint(value: unknown): ChatCompactionPoint | null {
  if (!value || typeof value !== 'object') return null
  const partial = value as Partial<ChatCompactionPoint>
  const summaryMessageId = String(partial.summaryMessageId || '').trim()
  const boundaryMessageId = String(partial.boundaryMessageId || '').trim()
  const createdAt = Number(partial.createdAt)
  if (!summaryMessageId || !boundaryMessageId || !Number.isFinite(createdAt)) return null
  return { summaryMessageId, boundaryMessageId, createdAt }
}

export function normalizeReaderChatSession(
  value: unknown,
  sessionId: string,
  legacyMessages: ChatMessage[] = [],
  fallbackTitle = '新对话',
): ReaderChatSession {
  const partial = value && typeof value === 'object'
    ? value as Partial<ReaderChatSession>
    : null
  const messages = Array.isArray(partial?.messages)
    ? partial.messages.map(normalizeMessage).filter((message): message is ChatMessage => message !== null)
    : legacyMessages.map((message) => ({ ...message }))
  const compactionPoints = Array.isArray(partial?.compactionPoints)
    ? partial.compactionPoints
        .map(normalizeCompactionPoint)
        .filter((point): point is ChatCompactionPoint => point !== null)
    : []

  const now = new Date().toISOString()
  return {
    id: String(partial?.id || sessionId).trim() || sessionId,
    title: String(partial?.title || fallbackTitle).trim() || fallbackTitle,
    messages,
    compactionPoints,
    createdAt: typeof partial?.createdAt === 'string'
      ? partial.createdAt
      : typeof partial?.updatedAt === 'string'
        ? partial.updatedAt
        : now,
    updatedAt: typeof partial?.updatedAt === 'string'
      ? partial.updatedAt
      : now,
  }
}

export const normalizeDoubtChatSession = normalizeReaderChatSession

export function createReaderChatSession(documentId: string, title = '新对话'): ReaderChatSession {
  const now = new Date().toISOString()
  return {
    id: `${documentId}-reader-chat-${crypto.randomUUID()}`,
    title,
    messages: [],
    compactionPoints: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function deriveReaderChatTitle(question: string) {
  const normalized = question.replace(/\s+/g, ' ').trim()
  if (!normalized) return '新对话'
  return normalized.length > 28 ? `${normalized.slice(0, 28)}…` : normalized
}

export function migrateReaderChatSessions({
  documentId,
  sessions,
  activeSessionId,
  annotations = [],
  legacyMessages = [],
}: {
  documentId: string
  sessions?: ReaderChatSession[] | null
  activeSessionId?: string | null
  annotations?: StoredDoubtAnnotation[]
  legacyMessages?: ChatMessage[]
}) {
  const migrated: ReaderChatSession[] = []
  const seenIds = new Set<string>()
  const push = (session: ReaderChatSession) => {
    if (!session.id || seenIds.has(session.id)) return
    seenIds.add(session.id)
    migrated.push(session)
  }

  for (const session of sessions ?? []) {
    push(normalizeReaderChatSession(session, session.id || `${documentId}-reader-chat-default`))
  }

  for (const annotation of annotations) {
    if (!annotation.chatSession) continue
    const sessionId = `legacy-annotation-${annotation.id}`
    push({
      ...normalizeReaderChatSession(annotation.chatSession, sessionId, [], annotation.question),
      id: sessionId,
    })
  }

  const realLegacyMessages = legacyMessages.filter(isConversationMessage)
  const hasUserMessage = realLegacyMessages.some((message) => message.role === 'user')
  if (hasUserMessage) {
    push(normalizeReaderChatSession(
      null,
      `legacy-chat-${documentId}`,
      realLegacyMessages,
      '历史对话',
    ))
  }

  if (!migrated.length) {
    push(normalizeReaderChatSession(null, `${documentId}-reader-chat-default`))
  }

  return {
    sessions: migrated,
    activeSessionId: migrated.some((session) => session.id === activeSessionId)
      ? activeSessionId!
      : migrated[0].id,
  }
}

export function appendDoubtChatMessages(
  session: DoubtChatSession,
  messages: ChatMessage[],
): DoubtChatSession {
  const existingIds = new Set(session.messages.map((message) => message.id))
  return {
    ...session,
    messages: [
      ...session.messages,
      ...messages.filter((message) => !existingIds.has(message.id)).map((message) => ({ ...message })),
    ],
    updatedAt: new Date().toISOString(),
  }
}

export const appendReaderChatMessages = appendDoubtChatMessages

export function updateDoubtChatMessage(
  session: DoubtChatSession,
  messageId: string,
  content: string,
): DoubtChatSession {
  return {
    ...session,
    messages: session.messages.map((message) =>
      message.id === messageId ? { ...message, content } : message,
    ),
    updatedAt: new Date().toISOString(),
  }
}

export const updateReaderChatMessage = updateDoubtChatMessage

export function findLatestApplicableCompactionPoint(
  session: DoubtChatSession,
): ChatCompactionPoint | null {
  const messageIds = new Set(session.messages.map((message) => message.id))
  let latest: ChatCompactionPoint | null = null
  for (const point of session.compactionPoints) {
    if (!messageIds.has(point.summaryMessageId) || !messageIds.has(point.boundaryMessageId)) {
      continue
    }
    if (!latest || point.createdAt > latest.createdAt) latest = point
  }
  return latest
}

export function buildDoubtChatContext(
  session: DoubtChatSession,
  maxMessages = CHAT_MEMORY_CONTEXT_MESSAGE_LIMIT,
): ChatMessage[] {
  const completed = session.messages.filter(isConversationMessage)
  const point = findLatestApplicableCompactionPoint(session)
  let context: ChatMessage[]

  if (!point) {
    context = completed.filter((message) => !message.isSummary)
  } else {
    const boundaryIndex = completed.findIndex((message) => message.id === point.boundaryMessageId)
    const summary = completed.find((message) => message.id === point.summaryMessageId)
    context = boundaryIndex >= 0 && summary
      ? [summary, ...completed.slice(boundaryIndex + 1).filter((message) => !message.isSummary)]
      : completed.filter((message) => !message.isSummary)
  }

  if (maxMessages >= context.length) return context.map(withReferenceContext)
  const summary = context[0]?.isSummary ? context[0] : null
  const tailLimit = Math.max(1, maxMessages - (summary ? 1 : 0))
  const tail = context.filter((message) => !message.isSummary).slice(-tailLimit)
  return summary ? [withReferenceContext(summary), ...tail.map(withReferenceContext)] : tail.map(withReferenceContext)
}

function withReferenceContext(message: ChatMessage): ChatMessage {
  if (!message.references?.length) return { ...message }
  const referenceContext = message.references
    .map((reference) => {
      const page = reference.pageNumber === null ? '页码未知' : `第 ${reference.pageNumber} 页`
      const location = [reference.documentName, page, reference.label].filter(Boolean).join(' · ')
      return `- ${location}${reference.excerpt ? `\n  ${reference.excerpt}` : ''}`
    })
    .join('\n')
  return {
    ...message,
    content: `${message.content}\n\n[本条消息的显式引用]\n${referenceContext}`,
  }
}

export const buildReaderChatContext = buildDoubtChatContext

export function getDoubtChatCompactionDecision(
  session: DoubtChatSession,
  config: ApiConfig,
  modelId = config.doubtModel,
) {
  const context = buildDoubtChatContext(session, Number.MAX_SAFE_INTEGER)
  const model = resolveModelContextBudget(config, modelId, 'chat')
  const tokens = estimateChatMessageTokens(context, model.tokenizer)
  return {
    shouldCompact: tokens >= model.compactionThresholdTokens,
    tokens,
    thresholdTokens: model.compactionThresholdTokens,
    contextWindow: model.contextWindow,
    modelSource: model.source,
  }
}

export function shouldCompactDoubtChatSession(
  session: DoubtChatSession,
  config: ApiConfig,
  modelId = config.doubtModel,
) {
  return getDoubtChatCompactionDecision(session, config, modelId).shouldCompact
}

export const shouldCompactReaderChatSession = shouldCompactDoubtChatSession

export function commitDoubtChatSummary(
  session: DoubtChatSession,
  summary: string,
): DoubtChatSession {
  const boundaryIndex = [...session.messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => isConversationMessage(message) && !message.isSummary)?.index
  if (boundaryIndex === undefined) return session

  const boundaryMessage = session.messages[boundaryIndex]
  const summaryMessage: ChatMessage = {
    id: `memory-summary-${crypto.randomUUID()}`,
    role: 'assistant',
    content: summary.trim(),
    createdAt: new Date().toISOString(),
    isSummary: true,
  }
  const point: ChatCompactionPoint = {
    summaryMessageId: summaryMessage.id,
    boundaryMessageId: boundaryMessage.id,
    createdAt: Date.now(),
  }

  return {
    ...session,
    messages: [
      ...session.messages.slice(0, boundaryIndex + 1),
      summaryMessage,
      ...session.messages.slice(boundaryIndex + 1),
    ],
    compactionPoints: [...session.compactionPoints, point],
    updatedAt: new Date().toISOString(),
  }
}

export const commitReaderChatSummary = commitDoubtChatSummary
