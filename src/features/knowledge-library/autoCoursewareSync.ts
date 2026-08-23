import type { KnowledgeCourse, KnowledgeFile } from '../../types'
import { parseTsinghuaCourseDisplayName } from '../../lib/tsinghuaCourseLabels'
import {
  closeTsinghuaSync,
  fetchTsinghuaCoursewareFile,
  getTsinghuaSyncStatus,
  importTsinghuaCourses,
  loadTsinghuaSemesters,
  loadTsinghuaCoursewareAutoSyncState,
  pullTsinghuaCoursewareByCourse,
  startTsinghuaSync,
  type TsinghuaCourseCandidate,
} from '../../lib/tsinghuaCourses'
import {
  ensureKnowledgeLibraryLoaded,
  getKnowledgeCourse,
  getKnowledgeFilesByCourse,
} from '../../lib/knowledgeBase'
import {
  buildCoursewareImportName,
  importCoursewareFiles,
} from './coursewareImport'
import {
  COURSEWARE_AUTO_SYNC_DELETION_EVENT,
  notifyCoursewareAutoSyncStatus,
  type CoursewareAutoSyncDeletionDetail,
} from './coursewareSyncEvents'

const DEFAULT_COURSE_ID = 'general-course'
const SOURCE_KEY_PREFIX = 'tsinghua-courseware:'
const READY_TIMEOUT_MS = 180_000

let runningAutoCoursewareSync: Promise<void> | null = null

function normalizeFileName(value: string) {
  return value.trim().toLowerCase()
}

function remoteSourceKey(remoteFileId: string) {
  return `${SOURCE_KEY_PREFIX}${remoteFileId}`
}

function getKnownRemoteFileIds(files: KnowledgeFile[], suppressedSourceKeys: Set<string>) {
  const known = new Set<string>()
  for (const sourceKey of suppressedSourceKeys) {
    if (sourceKey.startsWith(SOURCE_KEY_PREFIX)) {
      known.add(sourceKey.slice(SOURCE_KEY_PREFIX.length))
    }
  }
  for (const file of files) {
    if (file.sourceKey.startsWith(SOURCE_KEY_PREFIX)) {
      known.add(file.sourceKey.slice(SOURCE_KEY_PREFIX.length))
    }
  }
  return [...known]
}

function getKnownRemoteFileNames(
  files: KnowledgeFile[],
  suppressed: Array<{ fileName: string }>,
) {
  return [...new Set([
    ...files.map((file) => file.fileName),
    ...suppressed.map((item) => item.fileName),
  ].map((fileName) => String(fileName || '').trim()).filter(Boolean))]
}

async function waitUntilTsinghuaSyncReady(sessionId: string) {
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await getTsinghuaSyncStatus(sessionId)
    if (status.stage === 'ready' || status.stage === 'completed') {
      return true
    }
    if (status.stage === 'closed') {
      return false
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2500))
  }
  return false
}

function isSynchronizableCourse(course: KnowledgeCourse) {
  return course.id !== DEFAULT_COURSE_ID && Boolean(course.name.trim())
}

function getCourseSemesterId(course: KnowledgeCourse) {
  const parsed = parseTsinghuaCourseDisplayName(course.name)
  return String(course.semesterId || parsed.semesterId || '').trim()
}

function normalizeCourseName(value: string) {
  return parseTsinghuaCourseDisplayName(value).courseName.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function resolveRemoteCourse(
  course: KnowledgeCourse,
  candidates: TsinghuaCourseCandidate[],
): TsinghuaCourseCandidate | null {
  const courseName = normalizeCourseName(course.name)
  const courseWlkcid = String(course.wlkcid || '').trim()
  const courseCode = String(course.courseCode || '').trim().toLocaleLowerCase()
  if (courseWlkcid) {
    const matchedById = candidates.filter(
      (candidate) => String(candidate.wlkcid || '').trim() === courseWlkcid,
    )
    return matchedById.length === 1 ? matchedById[0] : null
  }

  const exactNameMatches = candidates.filter(
    (candidate) => normalizeCourseName(candidate.name) === courseName,
  )
  // Local course names are sometimes concise names (for example “Web前端”),
  // while the learning platform stores the full teaching-course name. This is
  // safe only when the concise name identifies exactly one remote course.
  const matchedByName = exactNameMatches.length
    ? exactNameMatches
    : candidates.filter((candidate) => {
        const candidateName = normalizeCourseName(candidate.name)
        return Boolean(courseName) && (candidateName.startsWith(courseName) || courseName.startsWith(candidateName))
      })
  const matchedByCode = courseCode
    ? matchedByName.filter((candidate) => String(candidate.courseCode || '').trim().toLocaleLowerCase() === courseCode)
    : matchedByName

  return matchedByCode.length === 1 && String(matchedByCode[0].wlkcid || '').trim()
    ? matchedByCode[0]
    : null
}

function remoteCourseIdentity(course: TsinghuaCourseCandidate) {
  return [course.semesterId || '', course.wlkcid || ''].map((value) => String(value).trim()).join('::')
}

function isPreferredRemoteBinding(
  candidate: KnowledgeCourse,
  current: KnowledgeCourse,
  remoteCourse: TsinghuaCourseCandidate,
) {
  const remoteId = String(remoteCourse.wlkcid || '').trim()
  const candidateMatchesId = String(candidate.wlkcid || '').trim() === remoteId
  const currentMatchesId = String(current.wlkcid || '').trim() === remoteId
  if (candidateMatchesId !== currentMatchesId) {
    return candidateMatchesId
  }
  if (candidate.source !== current.source) {
    return candidate.source === 'tsinghua-sync'
  }
  const remoteName = normalizeCourseName(remoteCourse.name)
  const candidateExactName = normalizeCourseName(candidate.name) === remoteName
  const currentExactName = normalizeCourseName(current.name) === remoteName
  return candidateExactName && !currentExactName
}

async function resolveRemoteCoursesForLibrary(
  sessionId: string,
  courses: KnowledgeCourse[],
  semesterId: string,
) {
  const resolved = new Map<string, TsinghuaCourseCandidate>()
  const proposed = new Map<string, TsinghuaCourseCandidate>()
  // Startup checks must never walk historical semesters. The explicit current
  // term is also passed to the API rather than relying on its current-term default.
  const remote = await importTsinghuaCourses(sessionId, semesterId)
  for (const course of courses) {
    const match = resolveRemoteCourse(course, remote.courses)
    if (match) {
      proposed.set(course.id, match)
      continue
    }
    notifyCoursewareAutoSyncStatus({
      state: 'syncing',
      message: `跳过《${course.name}》：未找到唯一的网络学堂课程，未导入任何文件。`,
    })
  }

  const ownerByRemoteCourse = new Map<string, KnowledgeCourse>()
  for (const course of courses) {
    const remoteCourse = proposed.get(course.id)
    if (!remoteCourse) {
      continue
    }
    const identity = remoteCourseIdentity(remoteCourse)
    const currentOwner = ownerByRemoteCourse.get(identity)
    if (!currentOwner || isPreferredRemoteBinding(course, currentOwner, remoteCourse)) {
      ownerByRemoteCourse.set(identity, course)
    }
  }

  for (const course of courses) {
    const remoteCourse = proposed.get(course.id)
    if (!remoteCourse) {
      continue
    }
    const owner = ownerByRemoteCourse.get(remoteCourseIdentity(remoteCourse))
    if (owner?.id === course.id) {
      resolved.set(course.id, remoteCourse)
      continue
    }
    notifyCoursewareAutoSyncStatus({
      state: 'syncing',
      message: `跳过《${course.name}》：该网络学堂课程已绑定到《${owner?.name || '其他课程'}》。`,
    })
  }
  return resolved
}

async function syncCoursewareForCourse(
  sessionId: string,
  course: KnowledgeCourse,
  remoteCourse: TsinghuaCourseCandidate,
  suppressed: Array<{ sourceKey: string; courseId: string; fileName: string }>,
  suppressedDuringRun: Set<string>,
) {
  const currentFiles = getKnowledgeFilesByCourse(course.id)
  // Course ids change when a user deletes and later re-imports a course. A
  // source-key suppression therefore applies globally, not only to its old id.
  const suppressedForCourse = suppressed
  const suppressedSourceKeys = new Set(suppressedForCourse.map((item) => item.sourceKey))
  const suppressedFileNames = new Set(
    suppressedForCourse.map((item) => normalizeFileName(item.fileName)).filter(Boolean),
  )
  const existingSourceKeys = new Set(currentFiles.map((file) => file.sourceKey))
  const existingFileNames = new Set(currentFiles.map((file) => normalizeFileName(file.fileName)))

  const result = await pullTsinghuaCoursewareByCourse(sessionId, {
    courseName: remoteCourse.name,
    semesterId: remoteCourse.semesterId || course.semesterId || '',
    courseCode: remoteCourse.courseCode || '',
    wlkcid: remoteCourse.wlkcid || '',
    knownFileIds: getKnownRemoteFileIds(currentFiles, suppressedSourceKeys),
    knownFileNames: getKnownRemoteFileNames(currentFiles, suppressedForCourse),
    strictIdentity: true,
  })

  const newFiles = result.files.filter((remoteFile) => {
    const sourceKey = remoteSourceKey(remoteFile.id)
    const importName = normalizeFileName(buildCoursewareImportName(remoteFile))
    return (
      !suppressedSourceKeys.has(sourceKey) &&
      !suppressedFileNames.has(importName) &&
      !existingSourceKeys.has(sourceKey) &&
      !existingFileNames.has(importName)
    )
  })

  if (!newFiles.length) {
    notifyCoursewareAutoSyncStatus({
      state: 'syncing',
      message: `已检查《${course.name}》，没有新的课件。`,
    })
    return
  }

  notifyCoursewareAutoSyncStatus({
    state: 'syncing',
    message: `正在导入《${course.name}》的 ${newFiles.length} 份新课件。`,
  })
  const outcome = await importCoursewareFiles({
    remoteFiles: newFiles,
    fetchFile: (remoteFile) => fetchTsinghuaCoursewareFile(sessionId, remoteFile.id),
    resolveCourseId: () => course.id,
    onProgressMessage: (message) => {
      console.info('[courseware auto sync]', course.name, message)
      notifyCoursewareAutoSyncStatus({ state: 'syncing', message })
    },
    shouldImport: (remoteFile) => (
      Boolean(getKnowledgeCourse(course.id))
      && !suppressedDuringRun.has(remoteSourceKey(remoteFile.id))
    ),
  })
  if (outcome.importFailedCount) {
    console.warn('[courseware auto sync] course import failed:', course.name, outcome.failureReasons)
  }
}

async function runAutoCoursewareSync() {
  const suppressedDuringRun = new Set<string>()
  const handleCoursewareDeletion = (event: Event) => {
    const detail = (event as CustomEvent<CoursewareAutoSyncDeletionDetail>).detail
    if (!detail?.sourceKey.startsWith(SOURCE_KEY_PREFIX)) {
      return
    }
    if (detail.action === 'suppress') {
      suppressedDuringRun.add(detail.sourceKey)
      return
    }
    suppressedDuringRun.delete(detail.sourceKey)
  }
  window.addEventListener(COURSEWARE_AUTO_SYNC_DELETION_EVENT, handleCoursewareDeletion)

  try {
    notifyCoursewareAutoSyncStatus({ state: 'syncing', message: '正在检查网络学堂的新课件…' })
    const library = await ensureKnowledgeLibraryLoaded()
    const courses = library.courses.filter(isSynchronizableCourse)
    if (!courses.length) {
      notifyCoursewareAutoSyncStatus({ state: 'completed', message: '当前没有需要检查的课程课件。' })
      return
    }

    const autoSyncState = await loadTsinghuaCoursewareAutoSyncState()
    let sessionId: string | null = null
    try {
      sessionId = (await startTsinghuaSync()).sessionId
      if (!(await waitUntilTsinghuaSyncReady(sessionId))) {
        console.info('[courseware auto sync] network school session is not ready; will retry next launch.')
        notifyCoursewareAutoSyncStatus({
          state: 'deferred',
          message: '网络学堂尚未完成登录，下一次打开页面会继续检查。',
        })
        return
      }

      const semesterResult = await loadTsinghuaSemesters(sessionId)
      const currentSemesterId = String(
        semesterResult.currentSemesterId
          || semesterResult.semesters.find((semester) => semester.isCurrent)?.semesterId
          || '',
      ).trim()
      if (!currentSemesterId) {
        notifyCoursewareAutoSyncStatus({
          state: 'deferred',
          message: '未能识别网络学堂当前学期，本次不会检查历史课件。',
        })
        return
      }

      const currentSemesterCourses = courses.filter(
        (course) => getCourseSemesterId(course) === currentSemesterId,
      )
      if (!currentSemesterCourses.length) {
        notifyCoursewareAutoSyncStatus({
          state: 'completed',
          message: '当前学期没有已同步的课程，无需检查新课件。',
        })
        return
      }

      const remoteCourses = await resolveRemoteCoursesForLibrary(
        sessionId,
        currentSemesterCourses,
        currentSemesterId,
      )

      for (const course of currentSemesterCourses) {
        const remoteCourse = remoteCourses.get(course.id)
        if (!remoteCourse) {
          continue
        }
        try {
          await syncCoursewareForCourse(
            sessionId,
            course,
            remoteCourse,
            autoSyncState.suppressed,
            suppressedDuringRun,
          )
        } catch (error) {
          console.warn('[courseware auto sync] skipped course after sync error:', course.name, error)
        }
      }
      notifyCoursewareAutoSyncStatus({ state: 'completed', message: '网络学堂课件检查完成。' })
    } finally {
      if (sessionId) {
        await closeTsinghuaSync(sessionId).catch((error) => {
          console.warn('[courseware auto sync] failed to close sync session:', error)
        })
      }
    }
  } catch (error) {
    notifyCoursewareAutoSyncStatus({
      state: 'deferred',
      message: `课件自动检查暂未完成：${error instanceof Error ? error.message : '请稍后重试。'}`,
    })
    throw error
  } finally {
    window.removeEventListener(COURSEWARE_AUTO_SYNC_DELETION_EVENT, handleCoursewareDeletion)
  }
}

export function runAutoCoursewareSyncOnce() {
  if (!runningAutoCoursewareSync) {
    runningAutoCoursewareSync = runAutoCoursewareSync().finally(() => {
      runningAutoCoursewareSync = null
    })
  }
  return runningAutoCoursewareSync
}
