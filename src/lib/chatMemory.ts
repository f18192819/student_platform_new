import type {
  ApiConfig,
  ChatCompactionPoint,
  ChatMessage,
  DoubtChatSession,
} from '../types'
import { resolveModelContextBudget } from './modelCapabilities'
import { estimateChatMessageTokens } from './tokenEstimator'

export const CHAT_MEMORY_CONTEXT_MESSAGE_LIMIT = Number.MAX_SAFE_INTEGER

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

export function normalizeDoubtChatSession(
  value: unknown,
  sessionId: string,
  legacyMessages: ChatMessage[] = [],
): DoubtChatSession {
  const partial = value && typeof value === 'object'
    ? value as Partial<DoubtChatSession>
    : null
  const messages = Array.isArray(partial?.messages)
    ? partial.messages.map(normalizeMessage).filter((message): message is ChatMessage => message !== null)
    : legacyMessages.map((message) => ({ ...message }))
  const compactionPoints = Array.isArray(partial?.compactionPoints)
    ? partial.compactionPoints
        .map(normalizeCompactionPoint)
        .filter((point): point is ChatCompactionPoint => point !== null)
    : []

  return {
    id: String(partial?.id || sessionId).trim() || sessionId,
    messages,
    compactionPoints,
    updatedAt: typeof partial?.updatedAt === 'string'
      ? partial.updatedAt
      : new Date().toISOString(),
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

  if (maxMessages >= context.length) return context.map((message) => ({ ...message }))
  const summary = context[0]?.isSummary ? context[0] : null
  const tailLimit = Math.max(1, maxMessages - (summary ? 1 : 0))
  const tail = context.filter((message) => !message.isSummary).slice(-tailLimit)
  return summary ? [{ ...summary }, ...tail.map((message) => ({ ...message }))] : tail
}

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
