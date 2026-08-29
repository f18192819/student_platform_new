import { resolveBackendApiUrl } from './apiConfig'

export type ResumePendingQuestionsResult = {
  checked: boolean
  pending_count: number
  message: string
}

export async function resumePendingQuestionDocuments(): Promise<ResumePendingQuestionsResult> {
  const response = await fetch(resolveBackendApiUrl('/api/questions/resume-pending'), {
    method: 'POST',
  })
  if (!response.ok) {
    throw new Error(`检查未处理题目失败 (HTTP ${response.status})`)
  }
  return await response.json() as ResumePendingQuestionsResult
}
