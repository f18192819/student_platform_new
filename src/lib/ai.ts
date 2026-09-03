import type {
  ApiConfig,
  AsrTranscriptPayload,
  AskAnswer,
  AskImageAttachment,
  AskStreamHandlers,
  ChatMessage,
  ClassroomLectureSegment,
  ClassroomSession,
  HomeworkDocument,
  HomeworkKnowledgeLink,
  HomeworkQuestion,
} from '../types'
import { hasUsableApiConfig, resolveBackendApiUrl } from './apiConfig'
import {
  buildFallbackHomeworkKnowledgeLinks,
  buildLecturePageDigest,
  buildQuestionFallbackKnowledgeLink,
  dedupeKnowledgeLinks,
  extractHomeworkQuestionContext,
  normalizeKnowledgeLinksPayload,
  normalizeQuestionListPayload,
} from './ai-core/homework'
import { cosineSimilarity, fetchEmbeddings } from './ai-core/embeddings'
import {
  buildFallbackClassroomSession,
  buildLecturePageAnchors,
  buildTranscriptMappingWindows,
  mergeSequentialClassroomSegments,
  normalizeClassroomSegmentsPayload,
  normalizeTranscriptPayload,
  normalizeTranscriptSentences,
  type SlidingWindowCandidatePage,
  summarizeLectureSegmentText,
  type TranscriptMappingWindow,
} from './ai-core/classroom'
import { emitDeltaText, parseJsonArrayFromModel, parseJsonObjectFromModel } from './ai-core/json'
import { normalizeBaseUrl, resolveAudioDebugApiUrl, resolveAudioDebugMappingApiUrl } from './ai-core/urls'
import {
  buildPromptContextPlan,
  splitMessagesByTokenBudget,
  truncateTextToTokenBudget,
  type PromptSourceSection,
} from './contextBudget'
import { resolveModelContextBudget } from './modelCapabilities'
import { estimateTextTokens } from './tokenEstimator'

const STREAM_IDLE_TIMEOUT_MS = 90000
const CLASSROOM_SLIDING_MATCH_SCORE_THRESHOLD = 0.1
const CLASSROOM_SLIDING_SKIP_MISS_LIMIT = 4

type StoredLectureRecording = {
  id: string
  course_id: string
  document_id: string
  audio_path: string
  duration: number
}

type PageTranscriptPayload = {
  page_id: string
  page_number: number
  title?: string
  start_time: number
  end_time: number
  text: string
  segment_ids: string[]
  confidence: number
  alignment_type: 'direct' | 'transition' | 'reference'
}

export type AsrTranscriptionResult = AsrTranscriptPayload & {
  recording?: StoredLectureRecording
}

async function fetchChatCompletionJson(
  config: ApiConfig,
  messages: Array<Record<string, unknown>>,
  modelOverride?: string,
  maxTokens?: number,
) {
  const response = await fetch(normalizeBaseUrl(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: modelOverride?.trim() || config.model.trim(),
      temperature: 0.2,
      messages,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }),
  })

  const payload = (await response.json().catch(() => ({}))) as {
    choices?: Array<{
      message?: {
        content?: string
      }
    }>
    error?: {
      message?: string
    }
    detail?: string
  }

  if (!response.ok) {
    const reason = payload.error?.message || payload.detail || `HTTP ${response.status}`
    throw new Error(`Chat completion failed: ${reason}`)
  }

  return payload.choices?.[0]?.message?.content ?? ''
}

export async function summarizeChatMemoryWithConfiguredApi(
  messages: ChatMessage[],
  config: ApiConfig,
) {
  if (!hasUsableApiConfig(config)) {
    throw new Error('Please configure a valid text API before compacting chat memory.')
  }

  const eligibleMessages = messages
    .filter((message) =>
      (message.role === 'user' || message.role === 'assistant') && message.content.trim(),
    )
  if (!eligibleMessages.length) return ''

  const model = resolveModelContextBudget(config, config.model, 'summary')
  const batches = splitMessagesByTokenBudget(
    eligibleMessages,
    Math.max(2_048, Math.floor(model.inputBudgetTokens * 0.7)),
    model.tokenizer,
  )
  let rollingSummary = ''
  for (const batch of batches) {
    const transcript = batch
      .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content.trim()}`)
      .join('\n\n')
    const summary = await fetchChatCompletionJson(
      config,
      [
        {
          role: 'system',
          content: [
            '你负责压缩学习辅导会话，输出供后续模型继续对话使用的长期记忆。',
            '保留用户真正的问题、已经确认的结论、推导中的关键条件、公式、页码引用、用户偏好和仍未解决的问题。',
            '不得虚构信息，不要继续回答问题，不要写寒暄。',
            '使用简洁 Markdown，并明确区分已确认内容与待解决内容。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            rollingSummary ? `已有长期记忆：\n\n${rollingSummary}` : '',
            `需要继续合并的历史会话：\n\n${transcript}`,
            '请输出合并、去重后的完整长期记忆。',
          ].filter(Boolean).join('\n\n'),
        },
      ],
      config.model,
      model.outputReserveTokens,
    )
    rollingSummary = summary.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  }

  return rollingSummary
}

async function requestSlidingWindowPageMapping(
  window: TranscriptMappingWindow,
  candidates: SlidingWindowCandidatePage[],
  config: ApiConfig,
) {
  if (!candidates.length) {
    return {
      polishedText: '',
      anchorText: '',
      matchedPageNumbers: [] as number[],
      sourceSentenceIds: [] as string[],
    }
  }

  const candidateContext = candidates
    .map((candidate) =>
      [
        `${candidate.role === 'buffer' ? 'Buffer page' : 'Current page'}: ${candidate.pageNumber}`,
        `scoreHint: ${candidate.score.toFixed(4)}`,
        `content:\n${candidate.content.slice(0, 5000)}`,
      ].join('\n'),
    )
    .join('\n\n')

  const content = await fetchChatCompletionJson(config, [
    {
      role: 'system',
      content: [
        'You map a forward-moving classroom transcript window onto slides.',
        'The lecture generally moves forward.',
        'Candidates include at most one buffer slide from the previous confirmed page and one current slide.',
        'Keep the transcript wording nearly verbatim and only lightly clean it.',
        'Return JSON only.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        'Return a JSON object in this shape:',
        '{"polishedText":"","anchorText":"","matchedPageNumbers":[1],"sourceSentenceIds":["id-1"]}',
        'Rules:',
        '1. matchedPageNumbers must be a subset of the provided candidate slide page numbers.',
        '2. If the transcript window still belongs to the previous slide, keep the buffer page in matchedPageNumbers.',
        '3. If the transcript window has clearly moved onto the current slide, include the current slide page number.',
        '4. During slide transition, matchedPageNumbers may contain both buffer and current page.',
        '5. If this transcript window matches neither candidate page, return matchedPageNumbers as an empty array.',
        '6. polishedText must stay close to the original transcript wording and should not summarize away content.',
        '7. anchorText should be a short phrase from the lecture page content or transcript window that helps locate the page.',
        '8. sourceSentenceIds must be chosen only from the provided sourceSentenceIds list and kept in order.',
        `sourceSentenceIds: ${window.sentenceIds.join(', ')}`,
        `Transcript window:\n${window.text}`,
        `Candidate pages:\n${candidateContext}`,
      ].join('\n\n'),
    },
  ])

  return parseJsonObjectFromModel(content)
}

async function readStreamedMarkdownAnswer(
  response: Response,
  handlers: AskStreamHandlers | undefined,
  onDelta: (delta: string) => void,
) {
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  if (!response.body) {
    throw new Error('Response body is empty.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let content = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    onDelta('')
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) {
        continue
      }

      const payloadText = trimmed.slice(5).trim()
      if (!payloadText || payloadText === '[DONE]') {
        continue
      }

      try {
        const payload = JSON.parse(payloadText) as {
          choices?: Array<{
            delta?: {
              content?: string
            }
          }>
        }
        const delta = payload.choices?.[0]?.delta?.content ?? ''
        if (!delta) {
          continue
        }
        content += delta
        emitDeltaText(delta, handlers)
      } catch {
        continue
      }
    }
  }

  return content.trim()
}

export async function askWithConfiguredVisionApi(
  question: string,
  documentContext: string | PromptSourceSection[],
  config: ApiConfig,
  attachments?: AskImageAttachment[],
  handlers?: AskStreamHandlers,
  modelOverride?: string,
  conversationHistory: ChatMessage[] = [],
): Promise<AskAnswer> {
  if (config.doubtProvider !== 'deepseek-web' && !hasUsableApiConfig(config)) {
    throw new Error('Please configure a valid text API first.')
  }

  const controller = new AbortController()
  let timeout = 0
  let content = ''
  const imageAttachments = attachments ?? []
  const hasImageAttachments = imageAttachments.length > 0
  const responseModel = modelOverride?.trim() || config.doubtModel.trim() || config.model.trim()
  const responseBudget = resolveModelContextBudget(config, responseModel, 'chat')

  const resetTimeout = () => {
    window.clearTimeout(timeout)
    timeout = window.setTimeout(() => controller.abort('stream-idle-timeout'), STREAM_IDLE_TIMEOUT_MS)
  }

  const baseInstruction = [
    hasImageAttachments
      ? `This request includes ${imageAttachments.length} screenshots or images. Inspect the visible text, formulas, diagrams and handwritten notes before answering.`
      : '',
    hasImageAttachments
      ? 'If the image content conflicts with the lecture text, prefer the visible image content first.'
      : '',
    hasImageAttachments
      ? 'If any image is blurred, cropped or blocked, explicitly say which part is unclear.'
      : '',
    `User question: ${question}`,
    'Return Markdown only. Keep the answer concise, structured and grounded in the provided material.',
  ]
    .filter(Boolean)
    .join('\n\n')
  // Keep the fixed part of the prompt bounded too, so an unusually long pasted
  // question cannot consume the space reserved for selected course material.
  const fixedTextBudget = Math.max(384, Math.floor(responseBudget.inputBudgetTokens * 0.25))
  const originalSystemPrompt = config.systemPrompt.trim()
  const safeSystemPrompt = truncateTextToTokenBudget(
    originalSystemPrompt,
    Math.max(256, Math.floor(fixedTextBudget * 0.35)),
    responseBudget.tokenizer,
    'head',
  )
  const safeInstructionBudget = Math.max(
    128,
    fixedTextBudget - estimateTextTokens(safeSystemPrompt, responseBudget.tokenizer),
  )
  const safeBaseInstruction = truncateTextToTokenBudget(
    baseInstruction,
    safeInstructionBudget,
    responseBudget.tokenizer,
    'head-tail',
  )
  const fixedInputWasTruncated =
    safeSystemPrompt !== originalSystemPrompt || safeBaseInstruction !== baseInstruction
  const rawFixedTokenDelta = Math.max(
    0,
    estimateTextTokens(originalSystemPrompt, responseBudget.tokenizer) +
      estimateTextTokens(baseInstruction, responseBudget.tokenizer) -
      estimateTextTokens(safeSystemPrompt, responseBudget.tokenizer) -
      estimateTextTokens(safeBaseInstruction, responseBudget.tokenizer),
  )
  const sourceSections = typeof documentContext === 'string'
    ? [{ id: 'document', title: 'Course material', content: documentContext, priority: 10 }]
    : documentContext
  const contextPlan = buildPromptContextPlan({
    config,
    modelId: responseModel,
    task: 'chat',
    systemPrompt: safeSystemPrompt,
    currentInstruction: safeBaseInstruction,
    history: conversationHistory,
    sourceSections,
    imageCount: imageAttachments.length,
  })
  const userInstruction = [
    safeBaseInstruction,
    contextPlan.sourceText
      ? `Course material and selected context:\n\n${contextPlan.sourceText}`
      : 'No usable course material fits in the current model context.',
  ].join('\n\n')

  if (config.doubtProvider === 'deepseek-web') {
    if (imageAttachments.length) {
      throw new Error('DeepSeek 网页疑点回答暂不接收附件，请移除附件或切换到 API 模式。')
    }
    const prompt = [
      safeSystemPrompt,
      ...contextPlan.history.map((message) =>
        `${message.role === 'user' ? '用户' : '助手'}：${message.content.trim()}`,
      ),
      userInstruction,
    ].filter(Boolean).join('\n\n')
    const response = await fetch(resolveBackendApiUrl('/api/deepseek-web/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    })
    const payload = (await response.json().catch(() => ({}))) as {
      text?: string
      detail?: string | { message?: string }
    }
    if (!response.ok || !payload.text?.trim()) {
      const detail = payload.detail
      const message = typeof detail === 'string' ? detail : detail?.message
      throw new Error(message || `DeepSeek Web Bridge request failed (HTTP ${response.status}).`)
    }
    emitDeltaText(payload.text, handlers)
    return {
      answer: payload.text.trim(),
      evidence: [],
      keyword: null,
      mode: 'api',
      note: 'Answered through the local DeepSeek Web Bridge.',
      contextUsage: {
        model: 'deepseek-web',
        contextWindow: contextPlan.model.contextWindow,
        estimatedInputTokens: contextPlan.estimatedInputTokens,
        rawInputTokens: contextPlan.rawInputTokens + rawFixedTokenDelta,
        wasTruncated: contextPlan.wasTruncated || fixedInputWasTruncated,
      },
    }
  }

  try {
    resetTimeout()

    const response = await fetch(normalizeBaseUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: responseModel,
        stream: true,
        messages: [
          {
            role: 'system',
            content: safeSystemPrompt,
          },
          ...contextPlan.history
            .map((message) => ({
              role: message.role,
              content: message.isSummary
                ? `【此前会话记忆摘要】\n${message.content.trim()}`
                : message.content.trim(),
            })),
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: userInstruction,
              },
              ...imageAttachments.map((attachment) => ({
                type: 'image_url',
                image_url: {
                  url: attachment.dataUrl,
                  detail: 'high',
                },
              })),
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: contextPlan.model.outputReserveTokens,
      }),
    })

    content = await readStreamedMarkdownAnswer(response, handlers, resetTimeout)
    if (!content) {
      throw new Error('No answer content returned.')
    }

    return {
      answer: content,
      evidence: [],
      keyword: null,
      mode: 'api',
      note: `Answered with model ${responseModel}.`,
      contextUsage: {
        model: responseModel,
        contextWindow: contextPlan.model.contextWindow,
        estimatedInputTokens: contextPlan.estimatedInputTokens,
        rawInputTokens: contextPlan.rawInputTokens + rawFixedTokenDelta,
        wasTruncated: contextPlan.wasTruncated || fixedInputWasTruncated,
      },
    }
  } catch (error) {
    if (content.trim()) {
      const reason = error instanceof Error && error.message ? error.message : 'stream interrupted'
      return {
        answer: content.trim(),
        evidence: [],
        keyword: null,
        mode: 'api',
        note: `Partial streamed answer kept. Reason: ${reason}`,
        contextUsage: {
          model: responseModel,
          contextWindow: contextPlan.model.contextWindow,
          estimatedInputTokens: contextPlan.estimatedInputTokens,
          rawInputTokens: contextPlan.rawInputTokens + rawFixedTokenDelta,
          wasTruncated: contextPlan.wasTruncated || fixedInputWasTruncated,
        },
      }
    }

    const message = error instanceof Error ? error.message : 'request failed'
    throw new Error(`API request failed: ${message}`)
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function splitHomeworkQuestionsWithApi(
  markdown: string,
  homeworkDocumentId: string,
  config: ApiConfig,
): Promise<HomeworkQuestion[]> {
  if (!hasUsableApiConfig(config)) {
    throw new Error('Please configure a valid text model before splitting homework.')
  }

  const splitModel = config.model.trim()

  try {
    const content = await fetchChatCompletionJson(
      config,
      [
        {
          role: 'system',
          content: [
            'Split the provided homework markdown into independent questions.',
            'Return JSON array only.',
            'Do not include explanations or markdown fences.',
            'You must rely only on the original markdown content.',
          ].join(' '),
        },
        {
          role: 'user',
          content: [
            'Return a JSON array in this shape:',
            '{"questions":[{"title":"","content":"","pageNumber":1,"anchorText":""}]}',
            'Rules:',
            '1. Each question must stay separate. Do not merge multiple questions into one item.',
            '2. If a single question spans multiple paragraphs, keep them in the same item.',
            '3. If the document contains answers or explanations, still split by question, not by answer paragraph.',
            '4. pageNumber must be the page where the question starts. Infer it from markdown page markers when available.',
            '5. anchorText should be the shortest distinctive phrase that marks the start of that question.',
            '6. Do not drop any question. Do not invent questions that are not in the markdown.',
            `Homework markdown:\n${markdown.slice(0, 120000)}`,
          ].join('\n'),
        },
      ],
      splitModel,
    )

    const parsed = parseJsonArrayFromModel(content)
    const questions = normalizeQuestionListPayload(homeworkDocumentId, parsed)
    if (!questions.length) {
      throw new Error(`Model ${splitModel} returned no valid questions.`)
    }
    return questions
  } catch (error) {
    console.error('splitHomeworkQuestionsWithApi model parse failed:', error)
    const message = error instanceof Error ? error.message : 'Unknown model response error'
    throw new Error(`Homework splitting with ${splitModel} failed: ${message}`)
  }
}

export async function resolveHomeworkQuestionPagesWithApi(
  questions: HomeworkQuestion[],
  pageTexts: string[],
  pageCount: number,
  config: ApiConfig,
): Promise<HomeworkQuestion[]> {
  if (!questions.length || !pageTexts.length || !hasUsableApiConfig(config)) {
    return questions
  }

  const pageDigest = pageTexts
    .map((text, index) => `Page ${index + 1}:\n${text.slice(0, 2200)}`)
    .join('\n\n')
    .slice(0, 36000)

  try {
    const resolvedQuestions = await Promise.all(
      questions.map(async (question) => {
        try {
          const content = await fetchChatCompletionJson(config, [
            {
              role: 'system',
              content: [
                'You locate one homework question on the correct source PDF page.',
                'Return JSON array only.',
                'Decide the start page from the complete page text.',
                'Do not guess from numbering alone.',
              ].join(' '),
            },
            {
              role: 'user',
              content: [
                'Return this shape:',
                '[{"pageNumber":1,"reason":"short evidence phrase"}]',
                'Rules:',
                '1. Select the page where the question statement starts.',
                '2. Match the body of this question, not only its title or number.',
                '3. If the question spans pages, use the first page where its statement begins.',
                `Question:\n${JSON.stringify({
                  questionId: question.id,
                  title: question.title,
                  anchorText: question.anchorText,
                  pageNumber: question.pageNumber,
                  content: question.content.slice(0, 1400),
                })}`,
                `Page texts:\n${pageDigest}`,
              ].join('\n\n'),
            },
          ])
          const parsed = parseJsonArrayFromModel(content)
          const pageNumber = Number(parsed[0]?.pageNumber)
          if (!Number.isFinite(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
            return question
          }

          return { ...question, pageNumber }
        } catch (error) {
          console.warn(`Question page validation failed for ${question.id}:`, error)
          return question
        }
      }),
    )

    return resolvedQuestions
  } catch (error) {
    console.error('resolveHomeworkQuestionPagesWithApi failed:', error)
    return questions
  }
}

export async function mapHomeworkKnowledgeLinks(
  lectureMarkdown: string,
  homeworkDocument: HomeworkDocument,
  config: ApiConfig,
): Promise<HomeworkKnowledgeLink[]> {
  if (!hasUsableApiConfig(config)) {
    return buildFallbackHomeworkKnowledgeLinks(lectureMarkdown, homeworkDocument)
  }

  if (!lectureMarkdown.trim() || !homeworkDocument.questions.length) {
    return []
  }

  const lectureDigest = buildLecturePageDigest(lectureMarkdown)

  try {
    const links = await Promise.all(
      homeworkDocument.questions.map(async (question) => {
        try {
          const questionContext = extractHomeworkQuestionContext(homeworkDocument, question)
          const content = await fetchChatCompletionJson(config, [
            {
              role: 'system',
              content: [
                'Map one homework question to all relevant lecture pages using only the homework question markdown and the lecture PDF markdown.',
                'Return JSON array only.',
                'A question may map to multiple lecture pages if it uses multiple knowledge points from the lecture.',
                'Do not rely on transcript content or any source outside the provided lecture markdown.',
              ].join(' '),
            },
            {
              role: 'user',
              content: [
                'Return a JSON array in this shape:',
                '[{"questionId":"","conceptTitle":"","lecturePageNumber":1,"lectureAnchorText":"","lectureSnippet":""}]',
                'A question may map to multiple lecture pages if multiple knowledge points are used.',
                `Question:\n${JSON.stringify({
                  questionId: question.id,
                  title: question.title,
                  pageNumber: question.pageNumber,
                  anchorText: question.anchorText,
                  content: question.content.slice(0, 1200),
                })}`,
                `Question context:\n${questionContext}`,
                `Lecture digest:\n${lectureDigest}`,
                `Lecture markdown:\n${lectureMarkdown.slice(0, 36000)}`,
              ].join('\n\n'),
            },
          ])

          const parsed = parseJsonArrayFromModel(content)
          return normalizeKnowledgeLinksPayload(lectureMarkdown, homeworkDocument, question, parsed)
        } catch {
          const fallback = buildQuestionFallbackKnowledgeLink(lectureMarkdown, homeworkDocument, question)
          return fallback ? [fallback] : []
        }
      }),
    )

    return dedupeKnowledgeLinks(links.flat().filter(Boolean) as HomeworkKnowledgeLink[])
  } catch {
    return buildFallbackHomeworkKnowledgeLinks(lectureMarkdown, homeworkDocument)
  }
}

export async function askWithConfiguredApi(
  question: string,
  documentText: string,
  config: ApiConfig,
  attachments?: AskImageAttachment[],
  handlers?: AskStreamHandlers,
): Promise<AskAnswer> {
  if (!hasUsableApiConfig(config)) {
    throw new Error('Please configure a valid text API first.')
  }

  const controller = new AbortController()
  let timeout = 0
  let content = ''

  const resetTimeout = () => {
    window.clearTimeout(timeout)
    timeout = window.setTimeout(() => controller.abort('stream-idle-timeout'), STREAM_IDLE_TIMEOUT_MS)
  }

  try {
    resetTimeout()

    const response = await fetch(normalizeBaseUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model.trim(),
        stream: true,
        messages: [
          {
            role: 'system',
            content: config.systemPrompt.trim(),
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: [
                  `Lecture material:\n${documentText}`,
                  `User question: ${question}`,
                  'Return Markdown only. Keep it structured and grounded in the provided material.',
                ].join('\n\n'),
              },
              ...(attachments ?? []).map((attachment) => ({
                type: 'image_url',
                image_url: {
                  url: attachment.dataUrl,
                },
              })),
            ],
          },
        ],
        temperature: 0.2,
      }),
    })

    content = await readStreamedMarkdownAnswer(response, handlers, resetTimeout)
    if (!content) {
      throw new Error('No answer content returned.')
    }

    return {
      answer: content,
      evidence: [],
      keyword: null,
      mode: 'api',
      note: `Answered with model ${config.model.trim()}.`,
    }
  } catch (error) {
    if (content.trim()) {
      const reason = error instanceof Error && error.message ? error.message : 'stream interrupted'

      return {
        answer: content.trim(),
        evidence: [],
        keyword: null,
        mode: 'api',
        note: `Partial streamed answer kept. Reason: ${reason}`,
      }
    }

    const message = error instanceof Error ? error.message : 'request failed'
    throw new Error(`API request failed: ${message}`)
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function transcribeAudioWithConfiguredAsr(
  audioBlob: Blob,
  _config: ApiConfig,
  context?: { courseId: string; documentId: string },
): Promise<AsrTranscriptionResult> {
  const formData = new FormData()
  const extension = audioBlob.type.includes('mpeg')
    ? 'mp3'
    : audioBlob.type.includes('mp4')
      ? 'm4a'
      : audioBlob.type.includes('wav')
        ? 'wav'
        : audioBlob.type.includes('ogg')
          ? 'ogg'
          : 'webm'
  const originalName =
    audioBlob instanceof File && audioBlob.name.trim()
      ? audioBlob.name.trim()
      : `classroom-${Date.now()}.${extension}`
  const file =
    audioBlob instanceof File
      ? audioBlob
      : new File([audioBlob], originalName, {
          type: audioBlob.type || 'application/octet-stream',
        })

  formData.append('file', file, originalName)
  if (context?.courseId.trim() && context.documentId.trim()) {
    formData.append('course_id', context.courseId.trim())
    formData.append('document_id', context.documentId.trim())
  }

  const response = await fetch(resolveAudioDebugApiUrl(), {
    method: 'POST',
    body: formData,
  })

  const payload = (await response.json().catch(() => ({}))) as {
    text?: string
    chunks?: Array<{
      text?: string
      start_seconds?: number
      end_seconds?: number
      segments?: Array<{
        start?: number
        end?: number
        start_seconds?: number
        end_seconds?: number
        text?: string
      }>
    }>
    detail?: string
    recording?: StoredLectureRecording
  }

  if (!response.ok) {
    throw new Error(String(payload.detail || `ASR HTTP ${response.status}`))
  }

  const transcript = String(payload.text || '').trim()
  if (!transcript) {
    throw new Error('Local ASR returned no usable transcript.')
  }

  const sentencePayload = Array.isArray(payload.chunks)
    ? payload.chunks.flatMap((chunk, chunkIndex) => {
        const chunkSegments = Array.isArray(chunk.segments) ? chunk.segments : []
        if (chunkSegments.length) {
          return chunkSegments.map((segment, segmentIndex) => ({
            id: `chunk-${chunkIndex + 1}-sentence-${segmentIndex + 1}`,
            text: String(segment.text || '').trim(),
            startSeconds:
              Number.isFinite(Number(segment.start_seconds))
                ? Number(segment.start_seconds)
                : Number.isFinite(Number(segment.start))
                  ? Number(chunk.start_seconds || 0) + Number(segment.start) / 1000
                  : null,
            endSeconds:
              Number.isFinite(Number(segment.end_seconds))
                ? Number(segment.end_seconds)
                : Number.isFinite(Number(segment.end))
                  ? Number(chunk.start_seconds || 0) + Number(segment.end) / 1000
                  : null,
            order: chunkIndex * 1000 + segmentIndex,
          }))
        }

        const fallbackText = String(chunk.text || '').trim()
        if (!fallbackText) {
          return []
        }

        return [
          {
            id: `chunk-${chunkIndex + 1}`,
            text: fallbackText,
            startSeconds:
              Number.isFinite(Number(chunk.start_seconds)) ? Number(chunk.start_seconds) : null,
            endSeconds:
              Number.isFinite(Number(chunk.end_seconds)) ? Number(chunk.end_seconds) : null,
            order: chunkIndex,
          },
        ]
      })
    : []

  return {
    text: transcript,
    sentences: normalizeTranscriptSentences(sentencePayload, transcript),
    recording: payload.recording,
  }
}

export async function buildClassroomSessionFromSequentialAlignment(
  transcript: AsrTranscriptionResult,
  courseId: string,
  documentId: string,
): Promise<ClassroomSession> {
  const recording = transcript.recording
  if (!recording) {
    throw new Error('ASR response did not create a persistent lecture recording.')
  }
  if (recording.course_id !== courseId || recording.document_id !== documentId) {
    throw new Error('The recording does not belong to the currently open lecture.')
  }

  const response = await fetch(
    resolveBackendApiUrl(`/api/audio/recordings/${encodeURIComponent(recording.id)}/align`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ course_id: courseId, document_id: documentId }),
    },
  )
  const payload = (await response.json().catch(() => ({}))) as {
    page_transcripts?: PageTranscriptPayload[]
    detail?: string
  }
  if (!response.ok) {
    throw new Error(String(payload.detail || `Audio page alignment HTTP ${response.status}`))
  }

  const segments = (payload.page_transcripts ?? [])
    .filter((item) => Number.isFinite(item.page_number) && item.page_number > 0 && item.text.trim())
    .map((item, index) => ({
      id: `${recording.id}:page-transcript:${index + 1}`,
      recordingId: recording.id,
      title: item.title?.trim() || `课堂原文 · 第 ${item.page_number} 页`,
      summary: item.text.trim().slice(0, 120),
      polishedText: item.text.trim(),
      anchorText: null,
      pageNumbers: [item.page_number],
      startSeconds: Number.isFinite(item.start_time) ? item.start_time : null,
      endSeconds: Number.isFinite(item.end_time) ? item.end_time : null,
      sourceSentenceIds: item.segment_ids,
      createdAt: new Date().toISOString(),
    }))
  if (!segments.length) {
    throw new Error('Sequential alignment did not produce any page transcript excerpts.')
  }

  const now = new Date().toISOString()
  return {
    id: recording.id,
    transcript: transcript.text,
    polishedOverview: '',
    segments,
    createdAt: now,
    updatedAt: now,
  }
}

export async function loadLatestDebugClassroomSession() {
  const response = await fetch(resolveAudioDebugMappingApiUrl(), {
    method: 'GET',
  })

  const payload = (await response.json().catch(() => ({}))) as {
    transcript?: string
    lectureMarkdown?: string
    session?: Record<string, unknown>
    detail?: string
  }

  if (!response.ok) {
    throw new Error(String(payload.detail || `Debug mapping HTTP ${response.status}`))
  }

  const lectureMarkdown = String(payload.lectureMarkdown || '')
  const sessionPayload =
    payload.session && typeof payload.session === 'object'
      ? normalizeClassroomSegmentsPayload(payload.session, lectureMarkdown)
      : []

  const rawSession = (payload.session ?? {}) as Record<string, unknown>
  return {
    transcript: String(payload.transcript || ''),
    lectureMarkdown,
    session: {
      id: String(rawSession.id || crypto.randomUUID()),
      transcript: String(rawSession.transcript || payload.transcript || ''),
      polishedOverview: String(rawSession.polishedOverview || ''),
      segments: sessionPayload,
      createdAt: String(rawSession.createdAt || new Date().toISOString()),
      updatedAt: String(rawSession.updatedAt || new Date().toISOString()),
    } satisfies ClassroomSession,
  }
}

export async function buildClassroomSessionWithApi(
  transcriptInput: string | AsrTranscriptPayload,
  lectureMarkdown: string,
  config: ApiConfig,
): Promise<ClassroomSession> {
  const transcriptPayload = normalizeTranscriptPayload(transcriptInput)
  const transcript = transcriptPayload.text.trim()
  if (!transcript.trim()) {
    throw new Error('Transcript is empty.')
  }

  if (!hasUsableApiConfig(config)) {
    return buildFallbackClassroomSession(transcript, lectureMarkdown)
  }

  try {
    const lecturePages = buildLecturePageAnchors(lectureMarkdown)
    const transcriptSentences = normalizeTranscriptSentences(transcriptPayload.sentences, transcript)
    const transcriptWindows = buildTranscriptMappingWindows(transcriptSentences)
    if (!lecturePages.length || !transcriptWindows.length) {
      return buildFallbackClassroomSession(transcript, lectureMarkdown)
    }

    const lecturePageEmbeddings = await fetchEmbeddings(
      config,
      lecturePages.map((page) => page.content.slice(0, 4000)),
      config.embeddingModel,
    )
    const transcriptWindowEmbeddings = await fetchEmbeddings(
      config,
      transcriptWindows.map((window) => window.text.slice(0, 2000)),
      config.embeddingModel,
    )
    const collectedSegments: ClassroomLectureSegment[] = []
    let currentPageIndex = 0
    let bufferPageIndex: number | null = null
    let currentPageMisses = 0

    for (const window of transcriptWindows) {
      if (currentPageIndex >= lecturePages.length && bufferPageIndex === null) {
        break
      }

      const candidatePageIndices: number[] = Array.from(
        new Set(
          [bufferPageIndex, currentPageIndex].filter(
            (pageIndex): pageIndex is number =>
              typeof pageIndex === 'number' && pageIndex >= 0 && pageIndex < lecturePages.length,
          ),
        ),
      )
      if (!candidatePageIndices.length) {
        continue
      }

      const windowEmbedding = transcriptWindowEmbeddings[window.index] ?? []
      const candidates: SlidingWindowCandidatePage[] = candidatePageIndices.map((pageIndex: number) => {
        const page = lecturePages[pageIndex]!
        return {
          pageIndex,
          pageNumber: page.pageNumber,
          content: page.content,
          role: pageIndex === currentPageIndex ? 'current' : 'buffer',
          score: cosineSimilarity(windowEmbedding, lecturePageEmbeddings[pageIndex] ?? []),
        } satisfies SlidingWindowCandidatePage
      })

      const currentCandidate: SlidingWindowCandidatePage | null =
        candidates.find((candidate: SlidingWindowCandidatePage) => candidate.role === 'current') ?? null
      const bufferCandidate: SlidingWindowCandidatePage | null =
        candidates.find((candidate: SlidingWindowCandidatePage) => candidate.role === 'buffer') ?? null
      const bestCandidateScore = candidates.reduce(
        (maxScore: number, candidate: SlidingWindowCandidatePage) => Math.max(maxScore, candidate.score),
        -1,
      )

      let matchedPageNumbers: number[] = []
      let polishedText = ''
      let anchorText = ''
      let sourceSentenceIds = [...window.sentenceIds]

      if (bestCandidateScore >= CLASSROOM_SLIDING_MATCH_SCORE_THRESHOLD) {
        const parsed = await requestSlidingWindowPageMapping(window, candidates, config)
        const rawMatchedPages = Array.isArray(parsed.matchedPageNumbers)
          ? parsed.matchedPageNumbers
          : Array.isArray(parsed.pageNumbers)
            ? parsed.pageNumbers
            : []
        matchedPageNumbers = Array.from(
          new Set(
            rawMatchedPages
              .map((pageNumber) => Number(pageNumber))
              .filter(
                (pageNumber) =>
                  Number.isFinite(pageNumber) &&
                  candidates.some((candidate: SlidingWindowCandidatePage) => candidate.pageNumber === pageNumber),
              ),
          ),
        ).sort((left, right) => left - right)
        polishedText = String(parsed.polishedText || '').trim()
        anchorText = String(parsed.anchorText || '').trim()
        if (Array.isArray(parsed.sourceSentenceIds)) {
          const allowedIds = new Set(window.sentenceIds)
          const filteredIds = parsed.sourceSentenceIds
            .map((sentenceId) => String(sentenceId || '').trim())
            .filter((sentenceId) => sentenceId && allowedIds.has(sentenceId))
          if (filteredIds.length) {
            sourceSentenceIds = filteredIds
          }
        }
      }

      const bufferMatched = bufferCandidate
        ? matchedPageNumbers.includes(bufferCandidate.pageNumber)
        : false
      const currentMatched = currentCandidate
        ? matchedPageNumbers.includes(currentCandidate.pageNumber)
        : false

      if (matchedPageNumbers.length) {
        const nextText = polishedText || window.text
        collectedSegments.push({
          id: crypto.randomUUID(),
          recordingId: null,
          title: `课堂讲解 · 第 ${matchedPageNumbers.join(' / ')} 页`,
          summary: summarizeLectureSegmentText(nextText),
          polishedText: nextText,
          anchorText: anchorText || null,
          pageNumbers: matchedPageNumbers,
          startSeconds: window.startSeconds,
          endSeconds: window.endSeconds,
          sourceSentenceIds,
          createdAt: new Date().toISOString(),
        })
      }

      if (bufferCandidate && !bufferMatched) {
        bufferPageIndex = null
      }

      if (currentMatched && currentCandidate) {
        bufferPageIndex = currentCandidate.pageIndex
        currentPageIndex = currentCandidate.pageIndex + 1
        currentPageMisses = 0
        continue
      }

      if (bufferMatched) {
        currentPageMisses = 0
        continue
      }

      if (currentCandidate && currentCandidate.score < CLASSROOM_SLIDING_MATCH_SCORE_THRESHOLD) {
        currentPageMisses += 1
        if (currentPageMisses >= CLASSROOM_SLIDING_SKIP_MISS_LIMIT) {
          currentPageIndex = Math.min(currentPageIndex + 1, lecturePages.length)
          currentPageMisses = 0
        }
      } else {
        currentPageMisses = 0
      }
    }

    const mergedSegments = mergeSequentialClassroomSegments(collectedSegments)
    if (!mergedSegments.length) {
      return buildFallbackClassroomSession(transcript, lectureMarkdown)
    }

    return {
      id: crypto.randomUUID(),
      transcript,
      polishedOverview: '',
      segments: mergedSegments,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  } catch {
    return buildFallbackClassroomSession(transcript, lectureMarkdown)
  }
}
