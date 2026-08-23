import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  createKnowledgeCourse,
  deleteKnowledgeCourse,
  getKnowledgeFilesByCourse,
  syncKnowledgeCourses,
} from '../lib/knowledgeBase'
import {
  closeTsinghuaSync,
  getTsinghuaSyncStatus,
  importTsinghuaCourses,
  loadTsinghuaSemesters,
  startTsinghuaSync,
  type TsinghuaCourseCandidate,
  type TsinghuaSemesterOption,
} from '../lib/tsinghuaCourses'
import { useKnowledgeLibraryState } from '../features/knowledge-library/useKnowledgeLibraryState'
import { getKnowledgeCourseDisplayName } from '../lib/knowledgeBaseCourses'

function formatCourseMeta(fileCount: number) {
  return `${fileCount} 份资料`
}

type CourseSyncPickerItem = {
  id: string
  course: TsinghuaCourseCandidate
}

export function DashboardPage() {
  const navigate = useNavigate()
  const { knowledgeLibrary, isReady } = useKnowledgeLibraryState()
  const [courseName, setCourseName] = useState('')
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const [semesters, setSemesters] = useState<TsinghuaSemesterOption[]>([])
  const [selectedSemesterId, setSelectedSemesterId] = useState('')
  const [isCourseSyncPickerOpen, setIsCourseSyncPickerOpen] = useState(false)
  const [courseSyncPickerItems, setCourseSyncPickerItems] = useState<CourseSyncPickerItem[]>([])
  const [selectedCourseSyncIds, setSelectedCourseSyncIds] = useState<Set<string>>(() => new Set())
  const [courseSyncSemesterName, setCourseSyncSemesterName] = useState('')
  const [deletingCourseId, setDeletingCourseId] = useState<string | null>(null)
  const [courseDeleteError, setCourseDeleteError] = useState('')
  const syncSessionRef = useRef<string | null>(null)

  const courseCards = useMemo(
    () =>
      knowledgeLibrary.courses.map((course) => {
        const files = getKnowledgeFilesByCourse(course.id)
        return {
          course,
          fileCount: files.length,
          latestUpdatedAt: files[0]?.updatedAt ?? course.updatedAt,
        }
      }),
    [knowledgeLibrary],
  )

  const handleCreateCourse = () => {
    const normalized = courseName.trim()
    if (!normalized) {
      return
    }

    const nextCourse = createKnowledgeCourse(normalized)
    setCourseName('')
    navigate(`/library?course=${nextCourse.id}`)
  }

  useEffect(() => () => {
    const sessionId = syncSessionRef.current
    syncSessionRef.current = null
    if (sessionId) {
      void closeTsinghuaSync(sessionId).catch((error) => {
        console.warn('close tsinghua sync session failed:', error)
      })
    }
  }, [])

  const handleDeleteCourse = async (courseId: string, courseNameValue: string) => {
    const confirmed = window.confirm(`确认删除“${courseNameValue}”知识库吗？其中的全部讲义也会一起删除。`)
    if (!confirmed) {
      return
    }

    setCourseDeleteError('')
    setDeletingCourseId(courseId)
    try {
      const deleted = await deleteKnowledgeCourse(courseId)
      if (!deleted) {
        setCourseDeleteError(`未找到“${courseNameValue}”，请刷新页面后重试。`)
      }
    } catch (error) {
      setCourseDeleteError(error instanceof Error ? error.message : `删除“${courseNameValue}”失败。`)
    } finally {
      setDeletingCourseId(null)
    }
  }

  const ensureSyncSession = async () => {
    if (syncSessionRef.current) {
      return syncSessionRef.current
    }

    setSyncMessage('正在启动网络学堂同步窗口，请稍候。')
    const status = await startTsinghuaSync()
    syncSessionRef.current = status.sessionId
    return status.sessionId
  }

  const waitUntilReady = async (sessionId: string) => {
    const deadline = Date.now() + 180_000

    while (Date.now() < deadline) {
      const status = await getTsinghuaSyncStatus(sessionId)
      if (status.stage === 'ready' || status.stage === 'completed') {
        return true
      }

      if (status.stage === 'awaiting_2fa') {
        setSyncMessage('请在弹出的网络学堂窗口中完成二次认证，完成后会自动继续导入。')
      } else if (status.stage === 'awaiting_login') {
        setSyncMessage('请在弹出的网络学堂窗口中完成登录，完成后会自动继续导入。')
      } else {
        setSyncMessage('正在等待网络学堂进入课程列表页。')
      }

      await new Promise((resolve) => window.setTimeout(resolve, 2500))
    }

    setSyncMessage('等待网络学堂登录超时。登录完成后再点击一次“从网络学堂同步”即可继续。')
    return false
  }

  const closeCurrentSyncSession = async () => {
    const sessionId = syncSessionRef.current
    syncSessionRef.current = null
    if (!sessionId) return
    try {
      await closeTsinghuaSync(sessionId)
    } catch (error) {
      console.warn('close tsinghua sync session failed:', error)
    }
  }

  const closeCourseSyncPicker = () => {
    setIsCourseSyncPickerOpen(false)
    setCourseSyncPickerItems([])
    setSelectedCourseSyncIds(new Set())
  }

  const handleLoadSemesters = async () => {
    setSyncBusy(true)
    setSyncMessage('正在读取网络学堂的可选学期…')
    try {
      const sessionId = await ensureSyncSession()
      if (!sessionId || !(await waitUntilReady(sessionId))) return
      const result = await loadTsinghuaSemesters(sessionId)
      setSemesters(result.semesters)
      const defaultSemesterId = result.currentSemesterId || result.semesters[0]?.semesterId || ''
      setSelectedSemesterId((current) => (
        result.semesters.some((semester) => semester.semesterId === current)
          ? current
          : defaultSemesterId
      ))
      setSyncMessage(`已读取 ${result.semesters.length} 个学期，请选择后同步课程。`)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '读取网络学堂学期失败。')
    } finally {
      setSyncBusy(false)
      await closeCurrentSyncSession()
    }
  }

  const handleLoadCoursesForSemester = async () => {
    if (!selectedSemesterId) {
      setSyncMessage('请先点击“选择学期”，再同步该学期的课程。')
      return
    }
    setSyncBusy(true)

    try {
      const sessionId = await ensureSyncSession()
      if (!sessionId) {
        return
      }

      const ready = await waitUntilReady(sessionId)
      if (!ready) {
        return
      }

      const selectedSemester = semesters.find((semester) => semester.semesterId === selectedSemesterId)
      setSyncMessage(`正在导入 ${selectedSemester?.semesterName || selectedSemesterId} 的课程…`)
      const result = await importTsinghuaCourses(sessionId, selectedSemesterId)
      const pickerItems = result.courses.map((course, index) => ({
        id: `${course.wlkcid || course.href || course.name}::${index}`,
        course,
      }))
      setCourseSyncPickerItems(pickerItems)
      setSelectedCourseSyncIds(new Set())
      setCourseSyncSemesterName(result.semesterName || selectedSemester?.semesterName || selectedSemesterId)
      setSyncMessage(`已读取 ${result.count} 门课程，请勾选后确认同步。`)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '网络学堂同步失败。')
    } finally {
      setSyncBusy(false)
      await closeCurrentSyncSession()
    }
  }

  const toggleCourseSyncSelection = (courseId: string) => {
    setSelectedCourseSyncIds((current) => {
      const next = new Set(current)
      if (next.has(courseId)) next.delete(courseId)
      else next.add(courseId)
      return next
    })
  }

  const toggleSelectAllCourses = () => {
    setSelectedCourseSyncIds((current) => (
      current.size === courseSyncPickerItems.length
        ? new Set()
        : new Set(courseSyncPickerItems.map((item) => item.id))
    ))
  }

  const handleConfirmSelectedCourses = () => {
    const selectedCourses = courseSyncPickerItems
      .filter((item) => selectedCourseSyncIds.has(item.id))
      .map((item) => item.course)
    if (!selectedCourses.length) {
      setSyncMessage('请至少选择一门课程后再确认同步。')
      return
    }
    const synced = syncKnowledgeCourses(
      selectedCourses.map((course) => ({
        name: course.name,
        source: 'tsinghua-sync',
        semesterId: selectedSemesterId || course.semesterId || '',
        semesterName: courseSyncSemesterName || course.semesterName || '',
        courseCode: course.courseCode || '',
        wlkcid: course.wlkcid || '',
      })),
    )
    setCourseSyncPickerItems([])
    setSelectedCourseSyncIds(new Set())
    setIsCourseSyncPickerOpen(false)
    setSyncMessage(
      `${courseSyncSemesterName}：已同步 ${selectedCourses.length} 门课程，新增 ${synced.created.length} 个知识库，跳过 ${synced.existing.length} 个已存在课程。`,
    )
  }

  return (
    <main className="octopus-library-shell">
      <section className="octopus-library-toolbar">
        <div className="octopus-library-toolbar__title">
          <h2>课程知识库</h2>
          <p>按课程管理资料，也可以选择网络学堂中的任意学期同步课程。</p>
        </div>
        <div className="octopus-library-toolbar__actions">
          <Link to="/study-plan" className="octopus-ghost-button octopus-ghost-button--link">
            时间规划
          </Link>
          <label className="octopus-input-shell">
            <input
              value={courseName}
              onChange={(event) => setCourseName(event.target.value)}
              placeholder="新建课程，例如：算法分析"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  handleCreateCourse()
                }
              }}
            />
          </label>
          <div className="octopus-course-sync-control">
            <button
              type="button"
              className="octopus-ghost-button"
              onClick={() => {
                if (isCourseSyncPickerOpen) {
                  closeCourseSyncPicker()
                  return
                }
                setIsCourseSyncPickerOpen(true)
                if (!semesters.length) void handleLoadSemesters()
              }}
              disabled={syncBusy}
              aria-expanded={isCourseSyncPickerOpen}
              aria-controls="course-sync-picker"
            >
              {syncBusy ? '读取中...' : '读取学期课程'}
            </button>
            {isCourseSyncPickerOpen ? (
              <section id="course-sync-picker" className="octopus-course-sync-picker" aria-label="选择要同步的课程">
                {courseSyncPickerItems.length ? (
                  <>
                    <div className="octopus-course-sync-picker__head">
                      <div>
                        <strong>选择课程</strong>
                        <p>{courseSyncSemesterName}，请选择要创建到课程知识库的课程。</p>
                      </div>
                      <button type="button" onClick={closeCourseSyncPicker} aria-label="关闭课程选择">×</button>
                    </div>
                    <div className="octopus-course-sync-picker__tools">
                      <button type="button" onClick={toggleSelectAllCourses}>
                        {selectedCourseSyncIds.size === courseSyncPickerItems.length ? '取消全选' : '一键全选'}
                      </button>
                      <span>{courseSyncPickerItems.length} 门可选</span>
                    </div>
                    <div className="octopus-course-sync-picker__list">
                      {courseSyncPickerItems.map((item) => (
                        <label key={item.id} className="octopus-course-sync-picker__item">
                          <input
                            type="checkbox"
                            checked={selectedCourseSyncIds.has(item.id)}
                            onChange={() => toggleCourseSyncSelection(item.id)}
                          />
                          <span>
                            <strong>{item.course.name}</strong>
                            <small>{[item.course.courseCode, item.course.teacherName].filter(Boolean).join(' · ') || '网络学堂课程'}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="octopus-course-sync-picker__footer">
                      <span>已选 {selectedCourseSyncIds.size} 门</span>
                      <button
                        type="button"
                        className="octopus-primary-button"
                        disabled={!selectedCourseSyncIds.size}
                        onClick={handleConfirmSelectedCourses}
                      >
                        同步所选课程
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="octopus-course-sync-picker__head">
                      <div>
                        <strong>选择学期</strong>
                        <p>先选择要读取课程的网络学堂学期。</p>
                      </div>
                      <button type="button" onClick={closeCourseSyncPicker} aria-label="关闭学期选择">×</button>
                    </div>
                    <label className="octopus-course-sync-picker__semester">
                      <span>学期</span>
                      <select
                        className="octopus-semester-select"
                        value={selectedSemesterId}
                        onChange={(event) => {
                          setSelectedSemesterId(event.target.value)
                          setCourseSyncPickerItems([])
                          setSelectedCourseSyncIds(new Set())
                        }}
                        disabled={syncBusy || !semesters.length}
                      >
                        {!semesters.length ? <option value="">正在读取可选学期…</option> : null}
                        {semesters.map((semester) => (
                          <option key={semester.semesterId} value={semester.semesterId}>
                            {semester.semesterName}{semester.isCurrent ? '（当前）' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="octopus-course-sync-picker__footer">
                      <span>{semesters.length ? `已找到 ${semesters.length} 个学期` : '正在连接网络学堂…'}</span>
                      <button
                        type="button"
                        className="octopus-primary-button"
                        disabled={syncBusy || !selectedSemesterId}
                        onClick={handleLoadCoursesForSemester}
                      >
                        {syncBusy ? '读取中...' : '读取课程'}
                      </button>
                    </div>
                  </>
                )}
              </section>
            ) : null}
          </div>
          <button
            type="button"
            className="octopus-primary-button"
            onClick={handleCreateCourse}
            disabled={!courseName.trim()}
          >
            新建课程
          </button>
        </div>
      </section>

      {syncMessage ? (
        <p className="octopus-sync-card__message" role="status" aria-live="polite">
          {syncMessage}
        </p>
      ) : null}

      {courseDeleteError ? <p className="octopus-upload-error" role="alert">{courseDeleteError}</p> : null}

      <section className="octopus-folder-grid">
        {isReady && courseCards.length ? (
          courseCards.map(({ course, fileCount, latestUpdatedAt }) => (
            <Link key={course.id} to={`/library?course=${course.id}`} className="octopus-folder-card">
              <button
                type="button"
                className="octopus-card-close"
                aria-label={`删除课程 ${getKnowledgeCourseDisplayName(course)}`}
                disabled={deletingCourseId === course.id}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void handleDeleteCourse(course.id, getKnowledgeCourseDisplayName(course))
                }}
              >
                {deletingCourseId === course.id ? '…' : 'x'}
              </button>
              <div className="octopus-folder-card__icon" aria-hidden="true">
                <div className="octopus-folder-glyph">
                  <div className="octopus-folder-glyph__tab" />
                  <div className="octopus-folder-glyph__body" />
                </div>
              </div>
              <div className="octopus-folder-card__content">
                <strong>{getKnowledgeCourseDisplayName(course)}</strong>
                <span>{formatCourseMeta(fileCount)}</span>
              </div>
              <div className="octopus-folder-card__meta">
                <span>{new Date(latestUpdatedAt).toLocaleDateString('zh-CN')}</span>
              </div>
            </Link>
          ))
        ) : isReady ? (
          <div className="octopus-empty-card">
            <strong>还没有课程知识库</strong>
            <p>你可以先手动创建课程，或者直接从网络学堂同步课程列表。</p>
          </div>
        ) : (
          <div className="octopus-empty-card">
            <strong>正在加载知识库</strong>
            <p>项目目录中的课程与讲义正在同步到当前页面。</p>
          </div>
        )}
      </section>
    </main>
  )
}
