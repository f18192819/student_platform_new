import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  buildCourseScopedPath,
  readRememberedCourseId,
  rememberCourseId,
} from '../lib/courseContext'
import {
  isLessonRecordingActive,
  LESSON_RECORDING_STATE_EVENT,
} from '../features/lesson-recording/lessonRecordingState'

export function AppHeader({
  rightContent,
}: {
  rightContent?: React.ReactNode
}) {
  const location = useLocation()
  const isReaderPage = location.pathname === '/pdf'
  const routeCourseId = new URLSearchParams(location.search).get('course')
  const [rememberedCourseId, setRememberedCourseId] = useState(readRememberedCourseId)
  const currentCourseId = routeCourseId ?? rememberedCourseId
  const knowledgeLibraryTarget = buildCourseScopedPath('/library', currentCourseId)
  const pdfReaderTarget = buildCourseScopedPath('/pdf', currentCourseId)
  const [isLessonRecording, setIsLessonRecording] = useState(isLessonRecordingActive)
  const [lessonProcessingStatus, setLessonProcessingStatus] = useState('')

  useEffect(() => {
    const remembered = rememberCourseId(routeCourseId)
    if (remembered) setRememberedCourseId(remembered)
  }, [routeCourseId])

  useEffect(() => {
    const handleState = (event: Event) => {
      const customEvent = event as CustomEvent<{ isRecording?: boolean }>
      setIsLessonRecording(Boolean(customEvent.detail?.isRecording))
    }

    const handleProcessingState = (event: Event) => {
      const customEvent = event as CustomEvent<{ label?: string }>
      setLessonProcessingStatus(customEvent.detail?.label?.trim() ?? '')
    }

    window.addEventListener(LESSON_RECORDING_STATE_EVENT, handleState)
    window.addEventListener('student-platform:lesson-processing-state', handleProcessingState)
    return () => {
      window.removeEventListener(LESSON_RECORDING_STATE_EVENT, handleState)
      window.removeEventListener('student-platform:lesson-processing-state', handleProcessingState)
    }
  }, [])

  const handleToggleLesson = () => {
    window.dispatchEvent(
      new CustomEvent('student-platform:lesson-recording-toggle', {
        detail: {
          nextRecording: !isLessonRecording,
        },
      }),
    )
  }

  return (
    <header className={`octopus-app-header${isReaderPage ? ' octopus-app-header--reader' : ''}`}>
      <div className="octopus-app-header__brand">
        <Link className="octopus-app-header__title" to="/">
          课程服务平台
        </Link>
        {isReaderPage ? <><span className="octopus-app-header__separator" aria-hidden="true" /><span className="octopus-app-header__context">阅读工作区</span></> : null}
      </div>
      <div className="octopus-app-header__actions">
        {rightContent ?? (isReaderPage ? (
          <nav className="octopus-app-header__primary-nav" aria-label="主要导航">
            <Link className="octopus-header-link" to="/">课程</Link>
            <Link className="octopus-header-link" to={knowledgeLibraryTarget}>知识库</Link>
          </nav>
        ) : (
          <>
            <Link className="octopus-header-link" to="/">
              课程
            </Link>
            <Link className="octopus-header-link" to={knowledgeLibraryTarget}>
              知识库
            </Link>
            <Link className="octopus-header-link" to="/settings/api">
              API 配置
            </Link>
            {lessonProcessingStatus ? <span className="octopus-status-pill">{lessonProcessingStatus}</span> : null}
            {isLessonRecording ? (
              <button
                type="button"
                className="octopus-primary-button octopus-primary-button--link"
                onClick={handleToggleLesson}
              >
                结束录音
              </button>
            ) : null}
            <Link className="octopus-primary-button octopus-primary-button--link" to={pdfReaderTarget}>
              PDF 阅读器
            </Link>
          </>
        ))}
      </div>
    </header>
  )
}
