import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  getKnowledgeFilesByCourse,
  getKnowledgeHomeworkDocumentsByCourseFolder,
} from '../lib/knowledgeBase'
import { getKnowledgeCourseDisplayName } from '../lib/knowledgeBaseCourses'
import { GLOBAL_STUDY_PLAN_ID, loadCourseStudyPlan, saveCourseStudyPlan } from '../lib/studyPlan'
import { useKnowledgeLibraryState } from '../features/knowledge-library/useKnowledgeLibraryState'
import type { StudyPlanItem, StudyPlanResource, StudyPlanResourceType } from '../types'

const START_HOUR = 8
const END_HOUR = 22
const HOUR_HEIGHT = 76
const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

type PlanDraft = {
  id: string | null
  title: string
  date: string
  startTime: string
  endTime: string
  courseIds: string[]
  resourceIds: string[]
}

function localDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfWeek(value: Date) {
  const result = new Date(value)
  result.setHours(0, 0, 0, 0)
  const weekday = result.getDay() || 7
  result.setDate(result.getDate() - weekday + 1)
  return result
}

function addDays(value: Date, amount: number) {
  const result = new Date(value)
  result.setDate(result.getDate() + amount)
  return result
}

function formatWeekRange(start: Date) {
  const end = addDays(start, 6)
  return `${start.getMonth() + 1} 月 ${start.getDate()} 日 - ${end.getMonth() + 1} 月 ${end.getDate()} 日`
}

function formatDayDate(value: Date) {
  return `${String(value.getMonth() + 1).padStart(2, '0')}/${String(value.getDate()).padStart(2, '0')}`
}

function timeFromDateTime(value: string) {
  return value.length >= 16 ? value.slice(11, 16) : '08:00'
}

function dateFromDateTime(value: string) {
  return value.length >= 10 ? value.slice(0, 10) : localDateKey(new Date())
}

function minutesFromTime(value: string) {
  const [hour, minute] = value.split(':').map(Number)
  return (Number.isFinite(hour) ? hour : START_HOUR) * 60 + (Number.isFinite(minute) ? minute : 0)
}

function hoursFromTime(value: string) {
  return minutesFromTime(value) / 60
}

function itemColor(type: StudyPlanResourceType | undefined) {
  if (type === 'homework') return 'is-homework'
  if (type === 'past-exam') return 'is-past-exam'
  return 'is-lecture'
}

function defaultDraft(date: string, startTime = '09:00'): PlanDraft {
  const startMinutes = minutesFromTime(startTime)
  const endMinutes = Math.min(END_HOUR * 60, startMinutes + 60)
  const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
  return { id: null, title: '', date, startTime, endTime, courseIds: [], resourceIds: [] }
}

export function StudyPlanPage() {
  const { knowledgeLibrary, isReady } = useKnowledgeLibraryState()
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()))
  const [items, setItems] = useState<StudyPlanItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<PlanDraft | null>(null)

  const resources = useMemo<StudyPlanResource[]>(() => knowledgeLibrary.courses.flatMap((course) => {
    const courseName = getKnowledgeCourseDisplayName(course)
    const lectureResources = getKnowledgeFilesByCourse(course.id)
      .filter((file) => (file.libraryFolder ?? 'courseware') === 'courseware')
      .map((file) => ({
        id: `${course.id}:lecture:${file.id}`,
        type: 'lecture' as const,
        label: `课件 · ${file.fileName}`,
        courseId: course.id,
        courseName,
      }))
    const homeworkResources = getKnowledgeHomeworkDocumentsByCourseFolder(course.id, 'homework')
      .map((document) => ({
        id: `${course.id}:homework:${document.id}`,
        type: 'homework' as const,
        label: `作业 · ${document.fileName}`,
        courseId: course.id,
        courseName,
      }))
    const pastExamResources = getKnowledgeHomeworkDocumentsByCourseFolder(course.id, 'past-exam')
      .map((document) => ({
        id: `${course.id}:past-exam:${document.id}`,
        type: 'past-exam' as const,
        label: `往年题 · ${document.fileName}`,
        courseId: course.id,
        courseName,
      }))
    return [...lectureResources, ...homeworkResources, ...pastExamResources]
  }), [knowledgeLibrary])
  const resourceById = useMemo(() => new Map(resources.map((resource) => [resource.id, resource])), [resources])
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart])
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart])
  const weekItems = useMemo(() => items.filter((item) => {
    const start = new Date(item.startAt)
    return start >= weekStart && start < weekEnd
  }), [items, weekEnd, weekStart])
  const selectedResources = useMemo(() => (
    draft ? resources.filter((resource) => draft.courseIds.includes(resource.courseId || '')) : []
  ), [draft, resources])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setError('')
    void loadCourseStudyPlan(GLOBAL_STUDY_PLAN_ID)
      .then((plan) => {
        if (!cancelled) setItems(plan.items)
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '加载学习计划失败。')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const openNewItem = (date: Date, startTime?: string) => {
    setError('')
    setDraft(defaultDraft(localDateKey(date), startTime))
  }

  const openItem = (item: StudyPlanItem) => {
    setError('')
    setDraft({
      id: item.id,
      title: item.title,
      date: dateFromDateTime(item.startAt),
      startTime: timeFromDateTime(item.startAt),
      endTime: timeFromDateTime(item.endAt),
      courseIds: [...new Set(item.resources.map((resource) => resource.courseId).filter((courseId): courseId is string => Boolean(courseId)))],
      resourceIds: item.resources.map((resource) => resource.id),
    })
  }

  const handleDayColumnClick = (event: MouseEvent<HTMLDivElement>, day: Date) => {
    if (event.target !== event.currentTarget) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const relativeHour = (event.clientY - bounds.top) / HOUR_HEIGHT
    const roundedMinutes = Math.max(0, Math.min(
      (END_HOUR - START_HOUR) * 60 - 60,
      Math.round((relativeHour * 60) / 30) * 30,
    ))
    const totalMinutes = START_HOUR * 60 + roundedMinutes
    const startTime = `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`
    openNewItem(day, startTime)
  }

  const toggleDraftCourse = (courseId: string) => {
    setDraft((current) => {
      if (!current) return current
      const selected = current.courseIds.includes(courseId)
      return {
        ...current,
        courseIds: selected ? current.courseIds.filter((id) => id !== courseId) : [...current.courseIds, courseId],
        resourceIds: selected
          ? current.resourceIds.filter((resourceId) => resourceById.get(resourceId)?.courseId !== courseId)
          : current.resourceIds,
      }
    })
  }

  const toggleDraftResource = (resourceId: string) => {
    setDraft((current) => {
      if (!current) return current
      const selected = current.resourceIds.includes(resourceId)
      return {
        ...current,
        resourceIds: selected
          ? current.resourceIds.filter((id) => id !== resourceId)
          : [...current.resourceIds, resourceId],
      }
    })
  }

  const saveDraft = async () => {
    if (!draft) return
    if (!draft.title.trim()) {
      setError('请填写安排名称。')
      return
    }
    const linkedResources = draft.resourceIds
      .map((resourceId) => resourceById.get(resourceId))
      .filter((resource): resource is StudyPlanResource => Boolean(resource))
    const startAt = `${draft.date}T${draft.startTime}`
    const endAt = `${draft.date}T${draft.endTime}`
    if (new Date(endAt) <= new Date(startAt)) {
      setError('结束时间需要晚于开始时间。')
      return
    }
    const now = new Date().toISOString()
    const existing = items.find((item) => item.id === draft.id)
    const nextItem: StudyPlanItem = {
      id: draft.id || crypto.randomUUID(),
      title: draft.title.trim(),
      startAt,
      endAt,
      resources: linkedResources,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    const nextItems = existing
      ? items.map((item) => item.id === existing.id ? nextItem : item)
      : [...items, nextItem]
    setIsSaving(true)
    setError('')
    try {
      const plan = await saveCourseStudyPlan(GLOBAL_STUDY_PLAN_ID, nextItems)
      setItems(plan.items)
      setDraft(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '保存学习计划失败。')
    } finally {
      setIsSaving(false)
    }
  }

  const deleteDraft = async () => {
    if (!draft?.id) return
    const nextItems = items.filter((item) => item.id !== draft.id)
    setIsSaving(true)
    setError('')
    try {
      const plan = await saveCourseStudyPlan(GLOBAL_STUDY_PLAN_ID, nextItems)
      setItems(plan.items)
      setDraft(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '删除学习安排失败。')
    } finally {
      setIsSaving(false)
    }
  }

  if (!isReady) {
    return <main className="study-plan-shell"><section className="octopus-empty-card">正在加载课程与资料…</section></main>
  }

  return (
    <main className="study-plan-shell">
      <section className="study-plan-header">
        <div>
          <div className="octopus-breadcrumb">
            <Link to="/">课程知识库</Link>
            <span>/</span>
            <strong>时间规划</strong>
          </div>
          <h1>本周学习安排</h1>
          <p>按时间块安排多门课程的课件、作业和往年题，点击空白时间格即可新建。</p>
        </div>
        <button type="button" className="octopus-primary-button" onClick={() => openNewItem(days[0], '09:00')}>
          + 新建安排
        </button>
      </section>

      <section className="study-plan-week-controls" aria-label="周次切换">
        <button type="button" className="ghost-button" onClick={() => setWeekStart((current) => addDays(current, -7))}>上一周</button>
        <div>
          <strong>{formatWeekRange(weekStart)}</strong>
          <span>{weekStart.getFullYear()} 年第 {Math.ceil((((weekStart.getTime() - new Date(weekStart.getFullYear(), 0, 1).getTime()) / 86400000) + 1) / 7)} 周</span>
        </div>
        <button type="button" className="ghost-button" onClick={() => setWeekStart(startOfWeek(new Date()))}>本周</button>
        <button type="button" className="ghost-button" onClick={() => setWeekStart((current) => addDays(current, 7))}>下一周</button>
      </section>

      {error && !draft ? <p className="study-plan-error" role="alert">{error}</p> : null}

      <section className="study-plan-calendar" aria-label="每周学习计划">
        <div className="study-plan-calendar__days">
          <div className="study-plan-calendar__corner">时间</div>
          {days.map((day, index) => (
            <div key={localDateKey(day)} className={`study-plan-calendar__day-head${localDateKey(day) === localDateKey(new Date()) ? ' is-today' : ''}`}>
              <strong>{WEEKDAY_NAMES[index]}</strong>
              <span>{formatDayDate(day)}</span>
            </div>
          ))}
        </div>
        <div className="study-plan-calendar__body">
          <div className="study-plan-calendar__ruler" aria-hidden="true">
            {Array.from({ length: END_HOUR - START_HOUR }, (_, index) => <span key={index}>{String(START_HOUR + index).padStart(2, '0')}:00</span>)}
          </div>
          {days.map((day) => {
            const dayKey = localDateKey(day)
            const dayItems = weekItems.filter((item) => dateFromDateTime(item.startAt) === dayKey)
            return (
              <div key={dayKey} className="study-plan-calendar__day-column" onClick={(event) => handleDayColumnClick(event, day)}>
                {dayItems.map((item) => {
                  const startHours = hoursFromTime(timeFromDateTime(item.startAt)) - START_HOUR
                  const durationHours = Math.max(0.5, hoursFromTime(timeFromDateTime(item.endAt)) - hoursFromTime(timeFromDateTime(item.startAt)))
                  const firstResource = item.resources[0]
                  const courseNames = [...new Set(item.resources.map((resource) => resource.courseName).filter(Boolean))]
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`study-plan-block ${itemColor(firstResource?.type)}`}
                      style={{ top: `${Math.max(0, startHours * HOUR_HEIGHT + 4)}px`, height: `${Math.max(42, durationHours * HOUR_HEIGHT - 8)}px` }}
                      onClick={(event) => { event.stopPropagation(); openItem(item) }}
                    >
                      <strong>{item.title}</strong>
                      <span>{timeFromDateTime(item.startAt)} - {timeFromDateTime(item.endAt)}</span>
                      {courseNames.length ? <em className="study-plan-block__course">{courseNames.join('、')}</em> : null}
                      {item.resources.slice(0, 2).map((resource) => <em key={resource.id}>{resource.label}</em>)}
                      {item.resources.length > 2 ? <em>另有 {item.resources.length - 2} 份资料</em> : null}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </section>

      {isLoading ? <p className="study-plan-loading">正在加载已保存的安排…</p> : null}

      {draft ? (
        <div className="study-plan-editor-overlay" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !isSaving) setDraft(null)
        }}>
          <section className="study-plan-editor" role="dialog" aria-modal="true" aria-labelledby="study-plan-editor-title">
            <header>
              <div>
                <span>STUDY BLOCK</span>
                <h2 id="study-plan-editor-title">{draft.id ? '编辑学习安排' : '新建学习安排'}</h2>
              </div>
              <button type="button" onClick={() => setDraft(null)} disabled={isSaving} aria-label="关闭">x</button>
            </header>
            <label>
              <span>安排名称</span>
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="例如：完成第 3 章复习" disabled={isSaving} />
            </label>
            <div className="study-plan-editor__times">
              <label><span>日期</span><input type="date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} disabled={isSaving} /></label>
              <label><span>开始</span><input type="time" value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} disabled={isSaving} /></label>
              <label><span>结束</span><input type="time" value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} disabled={isSaving} /></label>
            </div>
            <div className="study-plan-editor__resources">
              <div><strong>选择课程</strong><span>可选，可多选</span></div>
              {knowledgeLibrary.courses.length ? (
                <div className="study-plan-editor__course-list">
                  {knowledgeLibrary.courses.map((course) => (
                    <label key={course.id} className="study-plan-course-option">
                      <input type="checkbox" checked={draft.courseIds.includes(course.id)} onChange={() => toggleDraftCourse(course.id)} disabled={isSaving} />
                      <span>{getKnowledgeCourseDisplayName(course)}</span>
                    </label>
                  ))}
                </div>
              ) : <p>请先在课程知识库中新建或同步课程。</p>}
            </div>
            <div className="study-plan-editor__resources">
              <div><strong>选择复习资料</strong><span>可选，可多选</span></div>
              {selectedResources.length ? (
                <div className="study-plan-editor__resource-list">
                  {selectedResources.map((resource) => (
                    <label key={resource.id} className={`study-plan-resource-option ${itemColor(resource.type)}`}>
                      <input type="checkbox" checked={draft.resourceIds.includes(resource.id)} onChange={() => toggleDraftResource(resource.id)} disabled={isSaving} />
                      <span><small>{resource.courseName}</small>{resource.label}</span>
                    </label>
                  ))}
                </div>
              ) : <p>{draft.courseIds.length ? '所选课程还没有可安排的课件、作业或往年题，也可以直接保存普通安排。' : '无需关联课程也可以直接保存；选择课程后可继续关联复习资料。'}</p>}
            </div>
            {error ? <p className="study-plan-error" role="alert">{error}</p> : null}
            <footer>
              {draft.id ? <button type="button" className="study-plan-delete" onClick={() => void deleteDraft()} disabled={isSaving}>删除安排</button> : <span />}
              <div><button type="button" className="ghost-button" onClick={() => setDraft(null)} disabled={isSaving}>取消</button><button type="button" className="octopus-primary-button" onClick={() => void saveDraft()} disabled={isSaving}>{isSaving ? '保存中…' : '保存安排'}</button></div>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  )
}
