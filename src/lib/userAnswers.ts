import { resolveBackendApiUrl } from './apiConfig'

export type UserAnswerAsset = {
  id: string
  filename: string
  content_type: string
  kind: 'image' | 'pdf'
  order: number
  byte_size: number
}

export type AnswerUnderstanding = {
  transcription: string
  steps: string[]
  final_answer: string
  uncertain_parts: string[]
  confidence: number
}

export type UserAnswerGrading = {
  score: number
  correct: boolean
  confidence: number
  needs_review: boolean
  summary: string
  feedback: string
  error_types: string[]
  errors: Array<{
    type: string
    location: string
    student_reasoning: string
    problem: string
    correction: string
    severity: 'low' | 'medium' | 'high'
  }>
  knowledge_points: Array<{
    name: string
    status: 'strong' | 'partial' | 'weak' | 'unknown'
    evidence: string
  }>
  correct_parts: string[]
  improvement_suggestions: string[]
  is_wrong: boolean
}

export type UserQuestionAnswer = {
  id: string
  attempt_number: number
  course_id: string
  source_document_id: string
  question_id: string
  source_type: 'homework' | 'past-exam'
  assets: UserAnswerAsset[]
  created_at: string
  updated_at: string
  processing_status: 'pending' | 'processing' | 'completed' | 'failed' | 'needs_review'
  grading: UserAnswerGrading | null
  understanding: AnswerUnderstanding | null
  grading_model: string
  grading_version: string
  graded_at: string
  grading_error: string
}

export type QuestionAnswerIdentity = {
  courseId: string
  sourceDocumentId: string
  questionId: string
}

function answerPath(identity: QuestionAnswerIdentity) {
  return resolveBackendApiUrl([
    '/api/user-answers/courses', encodeURIComponent(identity.courseId),
    'documents', encodeURIComponent(identity.sourceDocumentId),
    'questions', encodeURIComponent(identity.questionId),
  ].join('/'))
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { detail?: string } | null
  return payload?.detail || `请求失败（${response.status}）`
}

export async function loadUserQuestionAnswerAttempts(identity: QuestionAnswerIdentity, signal?: AbortSignal) {
  const response = await fetch(`${answerPath(identity)}/attempts`, { signal })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { attempts: UserQuestionAnswer[] }
  return payload.attempts
}

export async function uploadUserQuestionAnswer(
  identity: QuestionAnswerIdentity,
  sourceType: 'homework' | 'past-exam',
  files: File[],
) {
  const body = new FormData()
  body.append('source_type', sourceType)
  files.forEach((file) => body.append('files', file, file.name))
  const response = await fetch(answerPath(identity), { method: 'POST', body })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { answer: UserQuestionAnswer }
  return payload.answer
}

export async function retryUserAnswerGrading(identity: QuestionAnswerIdentity, attemptId: string) {
  const response = await fetch(`${answerPath(identity)}/attempts/${encodeURIComponent(attemptId)}/grade`, {
    method: 'POST',
  })
  if (!response.ok) throw new Error(await responseError(response))
}

export async function deleteUserQuestionAnswer(identity: QuestionAnswerIdentity) {
  const response = await fetch(answerPath(identity), { method: 'DELETE' })
  if (!response.ok) throw new Error(await responseError(response))
}

export function userAnswerAssetUrl(identity: QuestionAnswerIdentity, assetId: string, attemptId?: string) {
  const attempt = attemptId ? `/attempts/${encodeURIComponent(attemptId)}` : ''
  return `${answerPath(identity)}${attempt}/assets/${encodeURIComponent(assetId)}`
}
