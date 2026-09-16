export const LESSON_RECORDING_STATE_EVENT = 'student-platform:lesson-recording-state'
export const LESSON_RECORDING_UPDATED_EVENT = 'student-platform:lesson-recording-updated'

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
