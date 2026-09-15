import { resolveBackendApiUrl } from '../../lib/apiConfig'

export type LectureRecordingView = {
  recording: {
    id: string
    course_id: string
    document_id: string | null
    duration: number
    created_at?: number
  }
  transcript_segments: Array<{
    id: string
    start_time: number
    end_time: number
    text: string
  }>
  status: 'transcribed' | 'aligning' | 'aligned' | 'alignment_failed' | string
  alignment_error?: string
  updated_at?: number
}

export async function fetchLectureRecordings(courseId: string | null, signal?: AbortSignal) {
  const query = courseId ? `?course_id=${encodeURIComponent(courseId)}` : ''
  const response = await fetch(resolveBackendApiUrl(`/api/audio/recordings${query}`), { signal })
  const payload = (await response.json().catch(() => ({}))) as {
    recordings?: LectureRecordingView[]
    detail?: string
  }
  if (!response.ok) {
    throw new Error(String(payload.detail || `Lecture recording HTTP ${response.status}`))
  }
  return Array.isArray(payload.recordings) ? payload.recordings : []
}

export function lectureRecordingMediaUrl(recording: LectureRecordingView['recording']) {
  return resolveBackendApiUrl(
    `/api/audio/recordings/${encodeURIComponent(recording.id)}/media?course_id=${encodeURIComponent(recording.course_id)}`,
  )
}
