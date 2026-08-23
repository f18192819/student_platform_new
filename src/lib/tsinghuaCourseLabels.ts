const SEMESTER_TAG_PATTERN = /\s*\[([0-9]{4}-[0-9]{4}-\d+)\]\s*$/
const SEMESTER_TAGS_SUFFIX_PATTERN = /(?:\s*\[[0-9]{4}-[0-9]{4}-\d+\]\s*)+$/

export function stripTsinghuaCourseSemesterTags(displayName: string) {
  return String(displayName || '').trim().replace(SEMESTER_TAGS_SUFFIX_PATTERN, '').trim()
}

export function formatTsinghuaCourseDisplayName(
  courseName: string,
  _semesterId?: string | null,
) {
  return stripTsinghuaCourseSemesterTags(courseName)
}

export function parseTsinghuaCourseDisplayName(displayName: string) {
  const normalized = String(displayName || '').trim()
  const matched = normalized.match(SEMESTER_TAG_PATTERN)
  if (!matched) {
    return {
      courseName: stripTsinghuaCourseSemesterTags(normalized),
      semesterId: '',
    }
  }

  const semesterId = matched[1] || ''
  return {
    courseName: stripTsinghuaCourseSemesterTags(normalized.replace(SEMESTER_TAG_PATTERN, '').trim()),
    semesterId,
  }
}
