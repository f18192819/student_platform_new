import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
const controllerSource = readFileSync('src/features/lesson-recording/LessonRecordingController.tsx', 'utf8')
const appSource = readFileSync('src/App.tsx', 'utf8')
const headerSource = readFileSync('src/components/AppHeader.tsx', 'utf8')
const aiSource = readFileSync('src/lib/ai.ts', 'utf8')
const mediaSource = readFileSync('backend/media_router.py', 'utf8')

test('lesson recording can start before choosing a course or opening a document', () => {
  assert.match(controllerSource, /contextFromLocation/)
  assert.match(controllerSource, /context\.courseId\s*\? \{ courseId: context\.courseId, documentId: context\.documentId \}\s*: undefined/)
  assert.match(controllerSource, /等待选择课程或上传讲义/)
  assert.match(controllerSource, /麦克风启动失败/)
})

test('recording controller survives route changes and only explicit stop ends capture', () => {
  assert.match(appSource, /<LessonRecordingController \/>/)
  assert.doesNotMatch(pageSource, /new MediaRecorder|lessonStreamRef|track\.stop\(\)/)
  assert.match(controllerSource, /routeContextRef\.current = contextFromLocation\(location\.search\)/)
  assert.match(controllerSource, /detail\?\.action === 'toggle'/)
  assert.match(controllerSource, /mediaRecorderRef\.current\?\.state === 'recording'/)
  assert.match(controllerSource, /LESSON_RECORDING_QUERY_EVENT, handleStateQuery/)
  assert.match(controllerSource, /else stopRecording\(\)/)
  assert.doesNotMatch(
    controllerSource.match(/return \(\) => \{[\s\S]*?\n    \}/g)?.at(-1) ?? '',
    /recorder\.stop\(\)|track\.stop\(\)/,
  )
  assert.match(headerSource, /isLessonRecording \? \([\s\S]*?结束录音/)
})

test('ASR context is optional and the backend persists unassigned recordings', () => {
  assert.match(aiSource, /if \(context\?\.courseId\.trim\(\)\)/)
  assert.match(aiSource, /context\.documentId\?\.trim\(\)/)
  assert.match(mediaSource, /storage_course_id = normalized_course_id or UNASSIGNED_AUDIO_COURSE_ID/)
  assert.match(mediaSource, /document_id=normalized_document_id or None/)
})

test('opening a lecture imports background-aligned recordings', () => {
  assert.match(pageSource, /queuePendingCourseLectureRecordings\(activeKnowledgeCourseId, knowledgeFileId\)/)
  assert.match(pageSource, /loadCourseLectureRecordings/)
  assert.match(pageSource, /saveKnowledgeClassroomSession\(knowledgeFileId, session\)/)
  assert.match(pageSource, /pollTimer = window\.setTimeout\(\(\) => refreshMappedRecordings\(\), 2500\)/)
})

test('empty aligned recordings are treated as failed instead of crashing session import', () => {
  assert.match(aiSource, /if \(!item\.page_transcripts\.length\) \{[\s\S]*failed = true[\s\S]*continue/)
  assert.match(aiSource, /\/api\/audio\/recordings\/align-pending/)
})
