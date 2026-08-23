import type { CourseStudyPlan, StudyPlanItem } from '../types'
import { resolveBackendApiUrl } from './apiConfig'

export const GLOBAL_STUDY_PLAN_ID = '__all_courses__'

async function readError(response: Response, fallback: string) {
  const payload = (await response.json().catch(() => ({}))) as { detail?: string }
  return payload.detail || fallback
}

export async function loadCourseStudyPlan(courseId: string) {
  const response = await fetch(
    resolveBackendApiUrl(`/api/study-plans/courses/${encodeURIComponent(courseId)}`),
  )
  if (!response.ok) {
    throw new Error(await readError(response, `加载学习计划失败 (HTTP ${response.status})`))
  }
  return await response.json() as CourseStudyPlan
}

export async function saveCourseStudyPlan(courseId: string, items: StudyPlanItem[]) {
  const response = await fetch(
    resolveBackendApiUrl(`/api/study-plans/courses/${encodeURIComponent(courseId)}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    },
  )
  if (!response.ok) {
    throw new Error(await readError(response, `保存学习计划失败 (HTTP ${response.status})`))
  }
  return await response.json() as CourseStudyPlan
}
