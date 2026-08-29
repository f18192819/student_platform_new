import { resolveBackendApiUrl } from './apiConfig'

export type AdaptiveTestQuestionImage = {
  id: string
  page_number: number
  alt: string
  url: string
}

export type AssessmentOption = {
  id: string
  content: string
}

export type AssessmentPart = {
  id: string
  type: 'choice' | 'numeric' | 'text'
  prompt: string
  weight: number
  required: boolean
  options: AssessmentOption[]
}

export type AssessmentResponse = {
  part_id: string
  value: string
}

export type ReferenceAnswerInfo = {
  source: 'original' | 'ai_generated' | 'user_corrected'
  confidence: number
  needs_review: boolean
  updated_at: string
}

export type PartGradingResult = {
  part_id: string
  type: 'choice' | 'numeric' | 'text' | string
  score: number
  correct: boolean
  confidence: number
  feedback: string
  method: string
}

export type AdaptiveTestQuestion = {
  question_id: string
  source_type: string
  source_document_id: string
  source_document_name: string
  source_page_number: number | null
  title: string
  prompt: string
  difficulty: number
  knowledge_points: string[]
  images: AdaptiveTestQuestionImage[]
  assessment_spec?: {
    question_id: string
    reference_answer_info: ReferenceAnswerInfo
    parts: AssessmentPart[]
  }
  reference_answer?: string
}

export type AdaptiveTestSession = {
  id: string
  course_id: string
  lecture_document_id: string
  status: 'active' | 'completed' | 'cancelled'
  target_question_count: number
  candidate_question_ids: string[]
  asked_question_ids: string[]
  current_question_id: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

export type AdaptiveTestAnswer = {
  event_id: string
  question_id: string
  response_text: string
  responses: AssessmentResponse[]
  part_grading_results: PartGradingResult[]
  score: number
  correct: boolean
  confidence: number
  feedback: string
  method: string
  revision: number
  reference_answer: string
  updated_at: string
}

export type ConceptMastery = {
  knowledge_point: string
  mastery: number
  confidence: number
  evidence_count: number
  weighted_evidence: number
  correct_streak: number
}

export type RecommendedLecturePage = {
  document_id: string
  document_name: string
  page_id: string
  page_number: number
  title: string
  knowledge_points: string[]
  relation_score: number
}

export type WrongQuestion = {
  question_id: string
  source_type: string
  source_document_id: string
  title: string
  page_number: number | null
  score: number
  answer: string
  structured_responses: AssessmentResponse[]
  part_grading_results: PartGradingResult[]
  feedback: string
  reference_answer: string
  images: AdaptiveTestQuestionImage[]
}

export type AdaptiveTestResult = {
  overall_mastery: number
  confidence: number
  questions_answered: number
  questions_correct: number
  concept_mastery: ConceptMastery[]
  weak_concepts: ConceptMastery[]
  wrong_questions: WrongQuestion[]
  recommended_pages: RecommendedLecturePage[]
  mastery_scope: 'lecture_history'
}

export type AdaptiveTestPayload = {
  session: AdaptiveTestSession
  progress: {
    answered: number
    target: number
    correct: number
  }
  current_question: AdaptiveTestQuestion | null
  questions: AdaptiveTestQuestion[]
  answers: AdaptiveTestAnswer[]
  grading?: {
    score: number
    correct: boolean
    confidence: number
    feedback: string
    method: string
    parts: PartGradingResult[]
  }
  answered_question?: AdaptiveTestQuestion
  saved_answer?: AdaptiveTestAnswer
  result?: AdaptiveTestResult
  skipped_ungradable_questions?: number
  reference_answer_update?: ReferenceAnswerInfo & { question_id: string }
}

async function readPayload(response: Response): Promise<AdaptiveTestPayload> {
  if (!response.ok) {
    let message = `请求失败 (HTTP ${response.status})`
    try {
      const payload = await response.json() as { detail?: string }
      if (payload.detail) {
        message = payload.detail
      }
    } catch {
      // Keep the HTTP fallback when a provider returns a non-JSON error.
    }
    throw new Error(message)
  }
  return await response.json() as AdaptiveTestPayload
}

export async function startAdaptiveTest(
  courseId: string,
  lectureDocumentId: string,
  targetQuestionCount = 7,
) {
  return readPayload(await fetch(resolveBackendApiUrl('/api/adaptive-tests'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      course_id: courseId,
      lecture_document_id: lectureDocumentId,
      target_question_count: targetQuestionCount,
    }),
  }))
}

export async function getActiveAdaptiveTest(
  courseId: string,
  lectureDocumentId: string,
  signal?: AbortSignal,
): Promise<AdaptiveTestPayload | null> {
  const query = new URLSearchParams({
    course_id: courseId,
    lecture_document_id: lectureDocumentId,
  })
  const response = await fetch(
    resolveBackendApiUrl(`/api/adaptive-tests/active?${query.toString()}`),
    { signal },
  )
  if (!response.ok) {
    throw new Error(`读取测试进度失败 (HTTP ${response.status})`)
  }
  const payload = await response.json() as { session: AdaptiveTestSession | null } | AdaptiveTestPayload
  return payload.session ? payload as AdaptiveTestPayload : null
}

export async function submitAdaptiveAnswer(
  sessionId: string,
  questionId: string,
  responses: AssessmentResponse[],
  responseTimeMs: number,
  legacyAnswer?: string,
) {
  return readPayload(await fetch(
    resolveBackendApiUrl(`/api/adaptive-tests/${encodeURIComponent(sessionId)}/answers`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(legacyAnswer === undefined
        ? { question_id: questionId, responses, response_time_ms: responseTimeMs }
        : { question_id: questionId, answer: legacyAnswer, response_time_ms: responseTimeMs }),
    },
  ))
}

export async function correctAdaptiveReferenceAnswer(
  sessionId: string,
  questionId: string,
  answerText: string,
) {
  return readPayload(await fetch(
    resolveBackendApiUrl(
      `/api/adaptive-tests/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}/reference-answer`,
    ),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer_text: answerText }),
    },
  ))
}

export async function cancelAdaptiveTest(sessionId: string) {
  return readPayload(await fetch(
    resolveBackendApiUrl(`/api/adaptive-tests/${encodeURIComponent(sessionId)}`),
    { method: 'DELETE' },
  ))
}

