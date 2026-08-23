import type { KnowledgeCourse } from '../types'
import { formatTsinghuaCourseDisplayName } from './tsinghuaCourseLabels'

export type KnowledgeCourseInput =
  | string
  | {
      name: string
      source?: KnowledgeCourse['source']
      semesterId?: string | null
      semesterName?: string | null
      courseCode?: string | null
      wlkcid?: string | null
    }

export type NormalizedKnowledgeCourseInput = {
  name: string
  source: 'manual' | 'tsinghua-sync'
  semesterId: string | null
  semesterName: string | null
  courseCode: string | null
  wlkcid: string | null
}

export function normalizeKnowledgeCourseInput(
  input: KnowledgeCourseInput,
): NormalizedKnowledgeCourseInput {
  if (typeof input === 'string') {
    return {
      name: input,
      source: 'manual',
      semesterId: null,
      semesterName: null,
      courseCode: null,
      wlkcid: null,
    }
  }

  const inferredSync =
    input.source === 'tsinghua-sync' ||
    Boolean(input.semesterId || input.semesterName || input.courseCode || input.wlkcid)

  return {
    name: String(input.name || '').trim(),
    source: inferredSync ? 'tsinghua-sync' : 'manual',
    semesterId: String(input.semesterId || '').trim() || null,
    semesterName: String(input.semesterName || '').trim() || null,
    courseCode: String(input.courseCode || '').trim() || null,
    wlkcid: String(input.wlkcid || '').trim() || null,
  }
}

export function buildKnowledgeCourseDisplayName(
  input: KnowledgeCourseInput | NormalizedKnowledgeCourseInput,
) {
  const normalized = normalizeKnowledgeCourseInput(input)
  if (normalized.source === 'tsinghua-sync') {
    return formatTsinghuaCourseDisplayName(normalized.name, normalized.semesterId)
  }
  return normalized.name
}

export function getKnowledgeCourseDisplayName(course: Pick<KnowledgeCourse, 'name' | 'displayName'>) {
  return String(course.displayName || course.name || '').trim() || '未命名课程'
}

export function sameKnowledgeCourseName(left: string, right: string) {
  return (
    left.trim().localeCompare(right.trim(), 'zh-CN', {
      sensitivity: 'base',
    }) === 0
  )
}

export function buildSyncedKnowledgeCourseIdentity(input: {
  semesterId?: string | null
  wlkcid?: string | null
}) {
  const semesterId = String(input.semesterId || '').trim()
  const wlkcid = String(input.wlkcid || '').trim()
  if (!semesterId || !wlkcid) {
    return ''
  }
  return `${semesterId}::${wlkcid}`
}

export function findKnowledgeCourseByInput(
  courses: KnowledgeCourse[],
  input: KnowledgeCourseInput | NormalizedKnowledgeCourseInput,
) {
  const normalized = normalizeKnowledgeCourseInput(input)
  if (!normalized.name) {
    return null
  }

  const syncedIdentity =
    normalized.source === 'tsinghua-sync'
      ? buildSyncedKnowledgeCourseIdentity({
          semesterId: normalized.semesterId,
          wlkcid: normalized.wlkcid,
        })
      : ''

  if (syncedIdentity) {
    const syncedCourse =
      courses.find(
        (course) =>
          buildSyncedKnowledgeCourseIdentity({
            semesterId: course.semesterId,
            wlkcid: course.wlkcid,
          }) === syncedIdentity,
      ) ?? null
    if (syncedCourse) {
      return syncedCourse
    }
  }

  const displayName = buildKnowledgeCourseDisplayName(normalized)
  return courses.find((course) => sameKnowledgeCourseName(course.name, displayName)) ?? null
}

export function findKnowledgeCourseByName(courses: KnowledgeCourse[], name: string) {
  const normalizedName = String(name || '').trim()
  if (!normalizedName) {
    return null
  }

  return courses.find((course) => sameKnowledgeCourseName(course.name, normalizedName)) ?? null
}

export function createKnowledgeCourseRecord(
  input: KnowledgeCourseInput | NormalizedKnowledgeCourseInput,
  now = new Date().toISOString(),
): KnowledgeCourse {
  const normalized = normalizeKnowledgeCourseInput(input)
  if (!normalized.name) {
    throw new Error('璇剧▼鍚嶇О涓嶈兘涓虹┖')
  }

  return {
    id: crypto.randomUUID(),
    name: normalized.name,
    displayName: buildKnowledgeCourseDisplayName(normalized),
    source: normalized.source,
    semesterId: normalized.source === 'tsinghua-sync' ? normalized.semesterId : null,
    semesterName: normalized.source === 'tsinghua-sync' ? normalized.semesterName : null,
    courseCode: normalized.source === 'tsinghua-sync' ? normalized.courseCode : null,
    wlkcid: normalized.source === 'tsinghua-sync' ? normalized.wlkcid : null,
    homeworkFolders: [],
    createdAt: now,
    updatedAt: now,
  }
}

export function normalizeKnowledgeCourse(
  course: Partial<KnowledgeCourse>,
  now = new Date().toISOString(),
): KnowledgeCourse {
  const normalized = normalizeKnowledgeCourseInput({
    name: String(course.name || '').trim() || '鏈懡鍚嶈绋?',
    source: course.source,
    semesterId: course.semesterId,
    semesterName: course.semesterName,
    courseCode: course.courseCode,
    wlkcid: course.wlkcid,
  })

  return {
    id: course.id ?? crypto.randomUUID(),
    name: buildKnowledgeCourseDisplayName(normalized) || '鏈懡鍚嶈绋?',
    displayName: String(course.displayName || '').trim() || buildKnowledgeCourseDisplayName(normalized),
    source: normalized.source,
    semesterId: normalized.source === 'tsinghua-sync' ? normalized.semesterId : null,
    semesterName: normalized.source === 'tsinghua-sync' ? normalized.semesterName : null,
    courseCode: normalized.source === 'tsinghua-sync' ? normalized.courseCode : null,
    wlkcid: normalized.source === 'tsinghua-sync' ? normalized.wlkcid : null,
    homeworkFolders: Array.isArray((course as Partial<KnowledgeCourse>).homeworkFolders)
      ? ((course as Partial<KnowledgeCourse>).homeworkFolders as KnowledgeCourse['homeworkFolders'])
      : [],
    createdAt: course.createdAt ?? now,
    updatedAt: course.updatedAt ?? course.createdAt ?? now,
  }
}

function buildKnowledgeCourseDedupeKey(normalized: NormalizedKnowledgeCourseInput) {
  return (
    (normalized.source === 'tsinghua-sync'
      ? buildSyncedKnowledgeCourseIdentity({
          semesterId: normalized.semesterId,
          wlkcid: normalized.wlkcid,
        })
      : '') || buildKnowledgeCourseDisplayName(normalized).toLocaleLowerCase('zh-CN')
  )
}

export function planKnowledgeCourseSync(
  existingCourses: KnowledgeCourse[],
  inputs: KnowledgeCourseInput[],
) {
  const created: KnowledgeCourse[] = []
  const existing: KnowledgeCourse[] = []
  const seen = new Set<string>()
  const nextCourses = [...existingCourses]

  inputs.forEach((input) => {
    const normalized = normalizeKnowledgeCourseInput(input)
    if (!normalized.name) {
      return
    }

    const dedupeKey = buildKnowledgeCourseDedupeKey(normalized)
    if (seen.has(dedupeKey)) {
      return
    }
    seen.add(dedupeKey)

    const matched = findKnowledgeCourseByInput(nextCourses, normalized)
    if (matched) {
      existing.push(matched)
      return
    }

    const createdCourse = createKnowledgeCourseRecord(normalized)
    nextCourses.push(createdCourse)
    created.push(createdCourse)
  })

  return {
    created,
    existing,
    courses: [...existing, ...created],
    nextCourses,
  }
}
