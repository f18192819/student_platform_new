export type UserAnswerAsset = {
  id: string
  filename: string
  content_type: string
  kind: 'image' | 'pdf'
  order: number
  byte_size: number
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
  grading: Record<string, unknown> | null
}

export type QuestionAnswerIdentity = {
  courseId: string
  sourceDocumentId: string
  questionId: string
}

function answerPath(identity: QuestionAnswerIdentity) {
  return [
    '/api/user-answers/courses',
    encodeURIComponent(identity.courseId),
    'documents',
    encodeURIComponent(identity.sourceDocumentId),
    'questions',
    encodeURIComponent(identity.questionId),
  ].join('/')
}

async function responseError(response: Response) {
  const payload = await response.json().catch(() => null) as { detail?: string } | null
  return payload?.detail || `请求失败（${response.status}）`
}

export async function loadUserQuestionAnswer(
  identity: QuestionAnswerIdentity,
  signal?: AbortSignal,
) {
  const response = await fetch(answerPath(identity), { signal })
  if (!response.ok) throw new Error(await responseError(response))
  const payload = await response.json() as { answer: UserQuestionAnswer | null }
  return payload.answer
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

export async function deleteUserQuestionAnswer(identity: QuestionAnswerIdentity) {
  const response = await fetch(answerPath(identity), { method: 'DELETE' })
  if (!response.ok) throw new Error(await responseError(response))
}

export function userAnswerAssetUrl(identity: QuestionAnswerIdentity, assetId: string) {
  return `${answerPath(identity)}/assets/${encodeURIComponent(assetId)}`
}
