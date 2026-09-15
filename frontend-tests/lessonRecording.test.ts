import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
const aiSource = readFileSync('src/lib/ai.ts', 'utf8')
const mediaSource = readFileSync('backend/media_router.py', 'utf8')

test('lesson recording can start before choosing a course or opening a document', () => {
  assert.doesNotMatch(pageSource, /if \(!activeKnowledgeCourseId\)[\s\S]*请先从课程页面进入 PDF 阅读器/)
  assert.doesNotMatch(pageSource, /请先打开一份讲义 PDF，再开始上课录音/)
  assert.match(pageSource, /if \(!audioBlob\.size\) \{\s*return/)
  assert.match(pageSource, /activeKnowledgeCourseIdRef\.current/)
  assert.match(pageSource, /knowledgeFileIdRef\.current/)
  assert.match(pageSource, /等待选择课程或上传讲义/)
  assert.match(pageSource, /麦克风启动失败/)
})

test('ASR context is optional and the backend persists unassigned recordings', () => {
  assert.match(aiSource, /if \(context\?\.courseId\.trim\(\)\)/)
  assert.match(aiSource, /context\.documentId\?\.trim\(\)/)
  assert.match(mediaSource, /storage_course_id = normalized_course_id or UNASSIGNED_AUDIO_COURSE_ID/)
  assert.match(mediaSource, /document_id=normalized_document_id or None/)
})

test('opening a lecture imports background-aligned recordings', () => {
  assert.match(pageSource, /loadCourseLectureRecordings/)
  assert.match(pageSource, /saveKnowledgeClassroomSession\(knowledgeFileId, session\)/)
  assert.match(pageSource, /pollTimer = window\.setTimeout\(refreshMappedRecordings, 2500\)/)
})
