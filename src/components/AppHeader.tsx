import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'

export function AppHeader({
  rightContent,
}: {
  rightContent?: React.ReactNode
}) {
  const location = useLocation()
  const isReaderPage = location.pathname === '/pdf'
  const currentCourseId = new URLSearchParams(location.search).get('course')
  const knowledgeLibraryTarget = currentCourseId
    ? `/library?course=${encodeURIComponent(currentCourseId)}`
    : '/library'
  const [isLessonRecording, setIsLessonRecording] = useState(false)
  const [lessonProcessingStatus, setLessonProcessingStatus] = useState('')

  useEffect(() => {
    const handleState = (event: Event) => {
      const customEvent = event as CustomEvent<{ isRecording?: boolean }>
      setIsLessonRecording(Boolean(customEvent.detail?.isRecording))
    }

    const handleProcessingState = (event: Event) => {
      const customEvent = event as CustomEvent<{ label?: string }>
      setLessonProcessingStatus(customEvent.detail?.label?.trim() ?? '')
    }

    window.addEventListener('student-platform:lesson-recording-state', handleState)
    window.addEventListener('student-platform:lesson-processing-state', handleProcessingState)
    return () => {
      window.removeEventListener('student-platform:lesson-recording-state', handleState)
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

  const handleUploadLessonAudio = () => {
    window.dispatchEvent(new CustomEvent('student-platform:lesson-audio-upload'))
  }

  const handleUploadLessonTranscript = () => {
    window.dispatchEvent(new CustomEvent('student-platform:lesson-transcript-upload'))
  }

  return (
    <header className={`octopus-app-header${isReaderPage ? ' octopus-app-header--reader' : ''}`}>
      <div className="octopus-app-header__brand">
        <Link className="octopus-app-header__title" to="/">
          课程服务平台
        </Link>
      </div>
      <div className="octopus-app-header__actions">
        {rightContent ?? (
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
            {isReaderPage ? (
              <>
                {lessonProcessingStatus ? (
                  <span className="octopus-status-pill">{lessonProcessingStatus}</span>
                ) : null}
                <button
                  type="button"
                  className="octopus-primary-button octopus-primary-button--link"
                  onClick={handleToggleLesson}
                >
                  {isLessonRecording ? '结束录音' : '开始上课'}
                </button>
                <button
                  type="button"
                  className="octopus-header-link octopus-header-link--button"
                  onClick={handleUploadLessonAudio}
                >
                  上传录音
                </button>
                <button
                  type="button"
                  className="octopus-header-link octopus-header-link--button"
                  onClick={handleUploadLessonTranscript}
                >
                  上传原文
                </button>
              </>
            ) : null}
            <Link className="octopus-primary-button octopus-primary-button--link" to="/pdf">
              PDF 阅读器
            </Link>
          </>
        )}
      </div>
    </header>
  )
}
