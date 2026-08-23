export type TsinghuaSyncStage =
  | 'awaiting_login'
  | 'awaiting_2fa'
  | 'navigating'
  | 'ready'
  | 'completed'
  | 'closed'

export type TsinghuaSemesterOption = {
  id: string
  semesterId: string
  semesterName: string
  startDate?: string | null
  endDate?: string | null
  isCurrent?: boolean
}

export type TsinghuaCourseCandidate = {
  name: string
  href: string
  semesterId?: string
  semesterName?: string
  courseCode?: string
  wlkcid?: string
  teacherName?: string
}

export type TsinghuaSyncStatus = {
  sessionId: string
  stage: TsinghuaSyncStage
  currentUrl: string
  title: string
  courseSample: TsinghuaCourseCandidate[]
  importedCourses?: TsinghuaCourseCandidate[]
  targetUrl?: string
  message?: string
  lastError?: string | null
  createdAt: string
  updatedAt: string
}

export type TsinghuaSyncImportResult = {
  sessionId: string
  stage: 'completed'
  courses: TsinghuaCourseCandidate[]
  semesterId?: string
  semesterName?: string
  count: number
  updatedAt: string
}

export type TsinghuaSyncSemesterResult = {
  sessionId: string
  semesters: TsinghuaSemesterOption[]
  currentSemesterId?: string
  updatedAt: string
}

export type TsinghuaSyncConfig = {
  configured: boolean
  username: string
  hasPassword: boolean
  autoLoginEnabled: boolean
}

export type TsinghuaCoursewareFile = {
  id: string
  courseName: string
  courseCode?: string
  wlkcid?: string
  semesterId?: string
  semesterName?: string
  fileName: string
  displayName: string
  byteSize: number
  mimeType: string
  kind: 'pdf' | 'office' | 'archive' | 'other'
  downloadedAt: string
  batchId: string
}

export type TsinghuaCoursewarePullResult = {
  sessionId: string
  batchId: string
  semesterId?: string
  semesterName?: string
  files: TsinghuaCoursewareFile[]
  skipped: Array<{
    courseName: string
    fileName: string
    reason: string
  }>
  count: number
  updatedAt: string
}

export type TsinghuaCoursewarePullByCourseResult = TsinghuaCoursewarePullResult & {
  courseName: string
}

export type TsinghuaCoursewareAutoSyncState = {
  suppressed: Array<{
    sourceKey: string
    courseId: string
    fileName: string
    deletedAt: string
  }>
}

type TsinghuaCourseIdentity = {
  courseName: string
  semesterId?: string | null
  courseCode?: string | null
  wlkcid?: string | null
  knownFileIds?: string[]
  knownFileNames?: string[]
  strictIdentity?: boolean
  requestedFileIds?: string[]
}

function resolveTsinghuaSyncApiUrl(path = '') {
  if (typeof window === 'undefined') {
    return `/api/tsinghua-sync${path}`
  }

  const runtime = (window as typeof window & {
    __OCTOPUS_SERVICE__?: { apiBase?: string; serviceId?: string; uuid?: string }
  }).__OCTOPUS_SERVICE__
  const apiBase = typeof runtime?.apiBase === 'string' ? runtime.apiBase.trim() : ''
  if (apiBase.startsWith('/')) {
    return `${apiBase.replace(/\/+$/, '')}/api/tsinghua-sync${path}`
  }

  const serviceKey =
    (typeof runtime?.uuid === 'string' && runtime.uuid.trim()) ||
    (typeof runtime?.serviceId === 'string' && runtime.serviceId.trim()) ||
    ''
  return serviceKey
    ? `/api/v1/service/${serviceKey}/api/tsinghua-sync${path}`
    : `/api/tsinghua-sync${path}`
}

async function parseResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as T & { detail?: string }
  if (!response.ok) {
    throw new Error(payload.detail || `网络学堂同步失败 (HTTP ${response.status})`)
  }
  return payload
}

export async function startTsinghuaSync() {
  const response = await fetch(resolveTsinghuaSyncApiUrl('/start'), {
    method: 'POST',
  })
  return parseResponse<TsinghuaSyncStatus>(response)
}

export async function getTsinghuaSyncStatus(sessionId: string) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}`))
  return parseResponse<TsinghuaSyncStatus>(response)
}

export async function loadTsinghuaSemesters(sessionId: string) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}/semesters`))
  return parseResponse<TsinghuaSyncSemesterResult>(response)
}

export async function importTsinghuaCourses(sessionId: string, semesterId?: string) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}/import`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ semesterId: semesterId || '' }),
  })
  return parseResponse<TsinghuaSyncImportResult>(response)
}

export async function closeTsinghuaSync(sessionId: string) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}`), {
    method: 'DELETE',
  })
  return parseResponse<{ closed: boolean }>(response)
}

export async function pullTsinghuaCourseware(sessionId: string, semesterId?: string) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}/courseware/pull`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ semesterId: semesterId || '' }),
  })
  return parseResponse<TsinghuaCoursewarePullResult>(response)
}

export async function pullTsinghuaCoursewareByCourse(
  sessionId: string,
  course: TsinghuaCourseIdentity,
) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}/courseware/pull-by-course`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      courseName: course.courseName,
      semesterId: course.semesterId || '',
      courseCode: course.courseCode || '',
      wlkcid: course.wlkcid || '',
      knownFileIds: course.knownFileIds || [],
      knownFileNames: course.knownFileNames || [],
      requestedFileIds: course.requestedFileIds || [],
      strictIdentity: Boolean(course.strictIdentity),
    }),
  })
  return parseResponse<TsinghuaCoursewarePullByCourseResult>(response)
}

export async function listTsinghuaCoursewareByCourse(
  sessionId: string,
  course: TsinghuaCourseIdentity,
) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}/courseware/list-by-course`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      courseName: course.courseName,
      semesterId: course.semesterId || '',
      courseCode: course.courseCode || '',
      wlkcid: course.wlkcid || '',
      strictIdentity: Boolean(course.strictIdentity),
    }),
  })
  return parseResponse<TsinghuaCoursewarePullByCourseResult>(response)
}

export async function restoreTsinghuaCourseware(sourceKeys: string[]) {
  const response = await fetch(resolveTsinghuaSyncApiUrl('/courseware/restore'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceKeys }),
  })
  return parseResponse<{ restored: number }>(response)
}

export async function fetchTsinghuaCoursewareFile(sessionId: string, downloadId: string) {
  const response = await fetch(resolveTsinghuaSyncApiUrl(`/${sessionId}/courseware/${downloadId}`))
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || `课件下载读取失败 (HTTP ${response.status})`)
  }
  return response.blob()
}

export async function loadTsinghuaCoursewareAutoSyncState() {
  const response = await fetch(resolveTsinghuaSyncApiUrl('/courseware/auto-sync-state'))
  return parseResponse<TsinghuaCoursewareAutoSyncState>(response)
}

export async function loadTsinghuaSyncConfig() {
  const response = await fetch(resolveTsinghuaSyncApiUrl('/config'))
  return parseResponse<TsinghuaSyncConfig>(response)
}

export async function saveTsinghuaSyncConfig(payload: {
  username: string
  password: string
  autoLoginEnabled: boolean
}) {
  const response = await fetch(resolveTsinghuaSyncApiUrl('/config'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return parseResponse<TsinghuaSyncConfig>(response)
}
