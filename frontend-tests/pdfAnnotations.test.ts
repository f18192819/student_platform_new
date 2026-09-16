import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const pageSource = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
const canvasSource = readFileSync('src/components/PdfPreviewCanvas.tsx', 'utf8')
const panelSource = readFileSync('src/features/pdf-annotations/ClassroomToolsPanel.tsx', 'utf8')
const hookSource = readFileSync('src/features/pdf-annotations/usePdfAnnotations.ts', 'utf8')
const storeSource = readFileSync('src/features/pdf-annotations/pdfAnnotationStore.ts', 'utf8')
const headerSource = readFileSync('src/components/AppHeader.tsx', 'utf8')
const recordingStateSource = readFileSync('src/features/lesson-recording/lessonRecordingState.ts', 'utf8')
const recordingControllerSource = readFileSync('src/features/lesson-recording/LessonRecordingController.tsx', 'utf8')

test('classroom tools own recording, uploads and annotation modes', () => {
  assert.match(panelSource, /LESSON_RECORDING_TOGGLE_EVENT/)
  assert.match(panelSource, /student-platform:lesson-audio-upload/)
  assert.match(panelSource, /student-platform:lesson-transcript-upload/)
  assert.match(panelSource, /\['highlight', '高亮'\]/)
  assert.match(panelSource, /\['text', '文本框'\]/)
  assert.match(pageSource, /classroomPanel=\{/)
  assert.match(pageSource, /classroomBadge=\{isLessonRecording \? 'REC' : null\}/)
  assert.match(panelSource, /requestLessonRecordingState\(\)/)
  assert.match(panelSource, /detail: \{ action: 'toggle' \}/)
  assert.match(recordingStateSource, /LESSON_RECORDING_QUERY_EVENT/)
  assert.match(recordingControllerSource, /mediaRecorderRef\.current\?\.state === 'recording'/)
  assert.doesNotMatch(headerSource, /octopus-reader-more/)
})

test('mastery launcher is mounted inside the center reader stage', () => {
  const viewerStart = pageSource.indexOf('<QuestionAnswerViewer')
  const launcherStart = pageSource.indexOf('<LectureMasteryTest', viewerStart)
  const canvasStart = pageSource.indexOf('<PdfPreviewCanvas', viewerStart)
  assert.ok(viewerStart >= 0)
  assert.ok(launcherStart > viewerStart)
  assert.ok(canvasStart > launcherStart)
})

test('annotations are isolated by course and document and persisted locally', () => {
  assert.match(pageSource, /`\$\{activeKnowledgeCourseId\}:\$\{viewerSource\.kind\}:\$\{annotationDocumentId\}`/)
  assert.match(storeSource, /student-platform:pdf-annotations:v1:/)
  assert.match(storeSource, /encodeURIComponent\(documentKey\)/)
  assert.match(hookSource, /savePdfAnnotations\(documentKey, next\)/)
  assert.match(hookSource, /current\.filter\(\(annotation\) => annotation\.pageNumber !== pageNumber\)/)
})

test('PDF annotations use normalized page coordinates and survive zoom', () => {
  assert.match(canvasSource, /x: rect\.left \/ pageData\.width/)
  assert.match(canvasSource, /y: rect\.top \/ pageData\.height/)
  assert.match(canvasSource, /annotation\.x \* pageData\.width/)
  assert.match(canvasSource, /transform: `scale\(\$\{displayScale\}\)`/)
  assert.match(canvasSource, /pdf-stage__annotation-draft--\$\{annotationTool\}/)
})

test('text annotations use a drawn text area with selection, movement and deletion', () => {
  assert.match(canvasSource, /placeholder="输入课堂批注…"/)
  assert.match(canvasSource, /rect\.width >= 24 && rect\.height >= 18/)
  assert.match(canvasSource, /selectedAnnotationId === annotation\.id \? ' is-selected'/)
  assert.match(canvasSource, /annotationMoveRef/)
  assert.match(canvasSource, /onUpdateAnnotation\?\.\(move\.annotationId, \{ x: nextX, y: nextY \}\)/)
  assert.match(canvasSource, /onUpdateAnnotation\?\./)
  assert.match(canvasSource, /onRemoveAnnotation\?\./)
  assert.match(canvasSource, /event\.key === 'Escape'/)
  assert.match(canvasSource, /event\.ctrlKey \|\| event\.metaKey/)
})
