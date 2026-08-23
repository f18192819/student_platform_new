import type { ApiConfig, ChatMessage } from '../types'
import {
  resolveModelContextBudget,
  type ContextTask,
  type ModelContextBudget,
} from './modelCapabilities'
import { estimateChatMessageTokens, estimateTextTokens } from './tokenEstimator'

export type PromptSourceSection = {
  id: string
  title: string
  content: string
  priority?: number
  trimMode?: 'head' | 'head-tail'
}

export type PromptContextPlan = {
  model: ModelContextBudget
  history: ChatMessage[]
  sourceText: string
  includedSourceIds: string[]
  omittedSourceIds: string[]
  estimatedInputTokens: number
  rawInputTokens: number
  historyTokens: number
  sourceTokens: number
  droppedHistoryMessages: number
  wasTruncated: boolean
}

type BuildPromptContextPlanOptions = {
  config: ApiConfig
  modelId: string
  task: ContextTask
  systemPrompt: string
  currentInstruction: string
  history: ChatMessage[]
  sourceSections: PromptSourceSection[]
  imageCount?: number
}

const SOURCE_SHARE_WHEN_OVERFLOWING = 0.7
const IMAGE_TOKEN_ESTIMATE = 4_096
const MIN_TRUNCATED_SECTION_TOKENS = 96
const TRUNCATION_MARKER = '\n\n[内容因模型上下文限制已截断]\n\n'

function renderSection(section: PromptSourceSection, content = section.content.trim()) {
  return `## ${section.title.trim()}\n\n${content}`.trim()
}

export function truncateTextToTokenBudget(
  text: string,
  maxTokens: number,
  tokenizer: ModelContextBudget['tokenizer'],
  mode: 'head' | 'head-tail' = 'head-tail',
) {
  const normalized = text.trim()
  if (!normalized || maxTokens <= 0) return ''
  const originalTokens = estimateTextTokens(normalized, tokenizer)
  if (originalTokens <= maxTokens) return normalized

  let length = Math.max(1, Math.floor(normalized.length * (maxTokens / originalTokens) * 0.92))
  let best = ''
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const headLength = mode === 'head' ? length : Math.max(1, Math.floor(length * 0.8))
    const tailLength = mode === 'head' ? 0 : Math.max(0, length - headLength)
    const candidate = tailLength
      ? `${normalized.slice(0, headLength)}${TRUNCATION_MARKER}${normalized.slice(-tailLength)}`
      : `${normalized.slice(0, headLength)}${TRUNCATION_MARKER}`
    const candidateTokens = estimateTextTokens(candidate, tokenizer)
    if (candidateTokens <= maxTokens) {
      best = candidate
      if (candidateTokens >= maxTokens * 0.9) break
    }
    const scale = maxTokens / Math.max(1, candidateTokens)
    const nextLength = Math.max(1, Math.min(normalized.length, Math.floor(length * scale * 0.96)))
    if (nextLength === length) break
    length = nextLength
  }
  return best
}

function fitHistory(
  history: ChatMessage[],
  maxTokens: number,
  tokenizer: ModelContextBudget['tokenizer'],
) {
  if (!history.length || maxTokens <= 0) return []
  const summary = history.find((message) => message.isSummary && message.content.trim())
  let remaining = maxTokens
  let fittedSummary: ChatMessage | null = null

  if (summary) {
    const summaryBudget = Math.min(remaining, Math.max(256, Math.floor(maxTokens * 0.25)))
    const content = truncateTextToTokenBudget(summary.content, summaryBudget - 4, tokenizer, 'head-tail')
    if (content) {
      fittedSummary = { ...summary, content }
      remaining -= 4 + estimateTextTokens(content, tokenizer)
    }
  }

  const recent: ChatMessage[] = []
  const candidates = history.filter((message) => message !== summary && message.content.trim())
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index]
    const tokens = 4 + estimateTextTokens(message.content, tokenizer)
    if (tokens <= remaining) {
      recent.unshift({ ...message })
      remaining -= tokens
      continue
    }
    if (!recent.length && remaining > 64) {
      const content = truncateTextToTokenBudget(message.content, remaining - 4, tokenizer, 'head-tail')
      if (content) recent.unshift({ ...message, content })
    }
    break
  }

  return fittedSummary ? [fittedSummary, ...recent] : recent
}

function fitSources(
  sourceSections: PromptSourceSection[],
  maxTokens: number,
  tokenizer: ModelContextBudget['tokenizer'],
) {
  const prioritized = sourceSections
    .map((section, index) => ({ section, index }))
    .filter(({ section }) => section.content.trim())
    .sort((left, right) =>
      (right.section.priority ?? 0) - (left.section.priority ?? 0) || left.index - right.index,
    )
  const rendered: string[] = []
  const includedSourceIds: string[] = []
  const omittedSourceIds: string[] = []
  let remaining = maxTokens

  for (const { section } of prioritized) {
    const complete = renderSection(section)
    const completeTokens = estimateTextTokens(complete, tokenizer)
    if (completeTokens <= remaining) {
      rendered.push(complete)
      includedSourceIds.push(section.id)
      remaining -= completeTokens
      continue
    }

    const headingTokens = estimateTextTokens(`## ${section.title}\n\n`, tokenizer)
    const contentBudget = remaining - headingTokens
    if (contentBudget >= MIN_TRUNCATED_SECTION_TOKENS) {
      const truncated = truncateTextToTokenBudget(
        section.content,
        contentBudget,
        tokenizer,
        section.trimMode ?? 'head-tail',
      )
      if (truncated) {
        rendered.push(renderSection(section, truncated))
        includedSourceIds.push(section.id)
        remaining = 0
        continue
      }
    }
    omittedSourceIds.push(section.id)
  }

  return {
    sourceText: rendered.join('\n\n'),
    includedSourceIds,
    omittedSourceIds,
  }
}

function estimateSources(
  sourceSections: PromptSourceSection[],
  tokenizer: ModelContextBudget['tokenizer'],
) {
  return sourceSections.reduce(
    (total, section) =>
      total + (section.content.trim() ? estimateTextTokens(renderSection(section), tokenizer) : 0),
    0,
  )
}

export function buildPromptContextPlan(options: BuildPromptContextPlanOptions): PromptContextPlan {
  const model = resolveModelContextBudget(options.config, options.modelId, options.task)
  const history = options.history.filter((message) =>
    (message.role === 'user' || message.role === 'assistant') && message.content.trim(),
  )
  const fixedTokens =
    estimateTextTokens(options.systemPrompt, model.tokenizer) +
    estimateTextTokens(options.currentInstruction, model.tokenizer) +
    (options.imageCount ?? 0) * IMAGE_TOKEN_ESTIMATE +
    32
  const rawHistoryTokens = estimateChatMessageTokens(history, model.tokenizer)
  const rawSourceTokens = estimateSources(options.sourceSections, model.tokenizer)
  const rawInputTokens = fixedTokens + rawHistoryTokens + rawSourceTokens
  const available = Math.max(0, model.inputBudgetTokens - fixedTokens)

  if (rawHistoryTokens + rawSourceTokens <= available) {
    const sourceText = options.sourceSections
      .filter((section) => section.content.trim())
      .map((section) => renderSection(section))
      .join('\n\n')
    return {
      model,
      history: history.map((message) => ({ ...message })),
      sourceText,
      includedSourceIds: options.sourceSections
        .filter((section) => section.content.trim())
        .map((section) => section.id),
      omittedSourceIds: [],
      estimatedInputTokens: rawInputTokens,
      rawInputTokens,
      historyTokens: rawHistoryTokens,
      sourceTokens: rawSourceTokens,
      droppedHistoryMessages: 0,
      wasTruncated: false,
    }
  }

  let sourceBudget = Math.min(rawSourceTokens, Math.floor(available * SOURCE_SHARE_WHEN_OVERFLOWING))
  let historyBudget = Math.min(rawHistoryTokens, Math.max(0, available - sourceBudget))
  if (rawHistoryTokens < historyBudget) {
    sourceBudget += historyBudget - rawHistoryTokens
    historyBudget = rawHistoryTokens
  }

  let fittedHistory = fitHistory(history, historyBudget, model.tokenizer)
  const fittedHistoryTokens = estimateChatMessageTokens(fittedHistory, model.tokenizer)
  sourceBudget += Math.max(0, historyBudget - fittedHistoryTokens)
  let fittedSources = fitSources(options.sourceSections, sourceBudget, model.tokenizer)
  let fittedSourceTokens = estimateTextTokens(fittedSources.sourceText, model.tokenizer)

  const unusedSourceBudget = Math.max(0, sourceBudget - fittedSourceTokens)
  if (unusedSourceBudget && fittedHistory.length < history.length) {
    fittedHistory = fitHistory(history, historyBudget + unusedSourceBudget, model.tokenizer)
  }

  const finalHistoryTokens = estimateChatMessageTokens(fittedHistory, model.tokenizer)
  const finalAvailableSourceBudget = Math.max(0, available - finalHistoryTokens)
  if (finalAvailableSourceBudget !== sourceBudget) {
    fittedSources = fitSources(options.sourceSections, finalAvailableSourceBudget, model.tokenizer)
    fittedSourceTokens = estimateTextTokens(fittedSources.sourceText, model.tokenizer)
  }

  return {
    model,
    history: fittedHistory,
    sourceText: fittedSources.sourceText,
    includedSourceIds: fittedSources.includedSourceIds,
    omittedSourceIds: fittedSources.omittedSourceIds,
    estimatedInputTokens: fixedTokens + finalHistoryTokens + fittedSourceTokens,
    rawInputTokens,
    historyTokens: finalHistoryTokens,
    sourceTokens: fittedSourceTokens,
    droppedHistoryMessages: Math.max(0, history.length - fittedHistory.length),
    wasTruncated:
      fittedHistory.length < history.length ||
      fittedSources.omittedSourceIds.length > 0 ||
      fittedSourceTokens < rawSourceTokens,
  }
}

export function splitMessagesByTokenBudget(
  messages: ChatMessage[],
  maxTokens: number,
  tokenizer: ModelContextBudget['tokenizer'],
) {
  const batches: ChatMessage[][] = []
  let current: ChatMessage[] = []
  let currentTokens = 0

  for (const message of messages) {
    const messageTokens = 4 + estimateTextTokens(message.content, tokenizer)
    if (current.length && currentTokens + messageTokens > maxTokens) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    if (messageTokens > maxTokens) {
      const content = truncateTextToTokenBudget(message.content, maxTokens - 4, tokenizer, 'head-tail')
      if (content) batches.push([{ ...message, content }])
      continue
    }
    current.push({ ...message })
    currentTokens += messageTokens
  }
  if (current.length) batches.push(current)
  return batches
}
