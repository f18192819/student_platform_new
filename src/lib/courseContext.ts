const ACTIVE_COURSE_STORAGE_KEY = 'student-platform:active-course-id'

type CourseContextStorage = Pick<Storage, 'getItem' | 'setItem'>

function resolveSessionStorage(): CourseContextStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function readRememberedCourseId(storage = resolveSessionStorage()) {
  if (!storage) return null
  try {
    return storage.getItem(ACTIVE_COURSE_STORAGE_KEY)?.trim() || null
  } catch {
    return null
  }
}

export function rememberCourseId(
  courseId: string | null | undefined,
  storage = resolveSessionStorage(),
) {
  const normalizedCourseId = courseId?.trim() || ''
  if (!normalizedCourseId || !storage) return null
  try {
    storage.setItem(ACTIVE_COURSE_STORAGE_KEY, normalizedCourseId)
  } catch {
    return null
  }
  return normalizedCourseId
}

export function buildCourseScopedPath(path: string, courseId: string | null | undefined) {
  const normalizedCourseId = courseId?.trim() || ''
  if (!normalizedCourseId) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}course=${encodeURIComponent(normalizedCourseId)}`
}
