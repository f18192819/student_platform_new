import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
const controllerSource = readFileSync('src/features/lesson-recording/LessonRecordingController.tsx', 'utf8')
const draftSource = readFileSync('src/features/lesson-recording/recordingDraftStore.ts', 'utf8')
const panelSource = readFileSync('src/features/lesson-recording/LessonRecordingPanel.tsx', 'utf8')
const layoutSource = readFileSync('src/features/pdf-workspace/components/ReaderWorkspaceLayout.tsx', 'utf8')

test('recording uses periodic IndexedDB chunks and only removes a draft after ASR succeeds', () => {
  assert.match(controllerSource, /recorder\.start\(1000\)/)
  assert.match(controllerSource, /appendLessonRecordingChunk/)
  assert.match(controllerSource, /readLessonRecordingDrafts/)
  assert.match(controllerSource, /if \(saved && draftId\)/)
  assert.match(controllerSource, /return recordingPersisted/)
  assert.match(draftSource, /createIndex\('draftId', 'draftId'/)
  assert.match(draftSource, /state: 'recording' \| 'pending'/)
})

test('refresh recovery submits persisted audio with its original context', () => {
  assert.match(controllerSource, /recoverInterruptedRecordings/)
  assert.match(controllerSource, /刷新前的课堂录音/)
  assert.match(controllerSource, /item\.draft\.courseId/)
  assert.match(controllerSource, /if \(saved\) await removeLessonRecordingDraft/)
  assert.match(controllerSource, /visibilitychange/)
  assert.match(controllerSource, /requestData\(\)/)
})

test('classroom history exposes original audio, ASR segments, and processing status', () => {
  assert.match(panelSource, /<audio controls preload="metadata"/)
  assert.match(panelSource, /ASR 识别原文/)
  assert.match(panelSource, /STATUS_LABELS/)
  assert.match(layoutSource, /historyTitle = '历史作答'/)
  assert.match(pageSource, /workspaceHistoryTitle="课堂录音与 ASR"/)
  assert.match(pageSource, /workspaceHistoryLabel="课堂记录"/)
})
