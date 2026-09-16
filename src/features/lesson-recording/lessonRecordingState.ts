export const LESSON_RECORDING_STATE_EVENT = 'student-platform:lesson-recording-state'
export const LESSON_RECORDING_UPDATED_EVENT = 'student-platform:lesson-recording-updated'
export const LESSON_RECORDING_QUERY_EVENT = 'student-platform:lesson-recording-query'
export const LESSON_RECORDING_TOGGLE_EVENT = 'student-platform:lesson-recording-toggle'

let lessonRecordingActive = false

export function isLessonRecordingActive() {
  return lessonRecordingActive
}

export function publishLessonRecordingState(isRecording: boolean) {
  lessonRecordingActive = isRecording
  window.dispatchEvent(
    new CustomEvent(LESSON_RECORDING_STATE_EVENT, {
      detail: { isRecording },
    }),
  )
}

export function publishLessonRecordingUpdated() {
  window.dispatchEvent(new CustomEvent(LESSON_RECORDING_UPDATED_EVENT))
}

export function requestLessonRecordingState() {
  window.dispatchEvent(new CustomEvent(LESSON_RECORDING_QUERY_EVENT))
}
