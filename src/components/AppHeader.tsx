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
        {isReaderPage ? <><span className="octopus-app-header__separator" aria-hidden="true" /><span className="octopus-app-header__context">阅读工作区</span></> : null}
      </div>
      <div className="octopus-app-header__actions">
        {rightContent ?? (isReaderPage ? (
          <>
            <nav className="octopus-app-header__primary-nav" aria-label="主要导航">
              <Link className="octopus-header-link" to="/">课程</Link>
              <Link className="octopus-header-link" to={knowledgeLibraryTarget}>知识库</Link>
            </nav>
            {lessonProcessingStatus ? <span className="octopus-status-pill">{lessonProcessingStatus}</span> : null}
            <button
              type="button"
              className="octopus-primary-button octopus-primary-button--link"
              onClick={handleToggleLesson}
            >
              {isLessonRecording ? '结束录音' : '开始上课'}
            </button>
            <details className="octopus-reader-more">
              <summary aria-label="更多阅读器操作">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
                <span>更多</span>
              </summary>
              <div className="octopus-reader-more__menu">
                <button type="button" onClick={handleUploadLessonAudio}>上传录音</button>
                <button type="button" onClick={handleUploadLessonTranscript}>上传原文</button>
                <Link to="/settings/api">API 配置</Link>
                <Link to="/pdf" aria-current="page">PDF 阅读器</Link>
              </div>
            </details>
          </>
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
            <Link className="octopus-primary-button octopus-primary-button--link" to="/pdf">
              PDF 阅读器
            </Link>
          </>
        ))}
      </div>
    </header>
  )
}
