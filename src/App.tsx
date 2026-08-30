import { useEffect, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import { AppHeader } from './components/AppHeader'
import { ApiConfigPage } from './pages/ApiConfigPage'
import { DashboardPage } from './pages/DashboardPage'
import { KnowledgeLibraryPage } from './pages/KnowledgeLibraryPage'
import { PdfWorkspacePage } from './pages/PdfWorkspacePage'
import { StudyPlanPage } from './pages/StudyPlanPage'
import { runAutoCoursewareSyncOnce } from './features/knowledge-library/autoCoursewareSync'
import { resumePendingQuestionDocuments } from './lib/questionPipeline'
import {
  COURSEWARE_AUTO_SYNC_STATUS_EVENT,
  type CoursewareAutoSyncStatusDetail,
} from './features/knowledge-library/coursewareSyncEvents'

function App() {
  const location = useLocation()
  const isReaderPage = location.pathname === '/pdf'
  const [coursewareSyncStatus, setCoursewareSyncStatus] = useState<CoursewareAutoSyncStatusDetail | null>(null)

  useEffect(() => {
    const startAutoCoursewareSync = () => {
      void runAutoCoursewareSyncOnce().catch((error) => {
        console.info('[courseware auto sync] startup check deferred:', error)
      })
    }

    const startupTimer = window.setTimeout(startAutoCoursewareSync, 0)
    window.addEventListener('pageshow', startAutoCoursewareSync)
    return () => {
      window.clearTimeout(startupTimer)
      window.removeEventListener('pageshow', startAutoCoursewareSync)
    }
  }, [])

  useEffect(() => {
    const checkPendingQuestions = () => {
      void resumePendingQuestionDocuments().catch((error) => {
        console.info('[question pipeline] startup recovery check deferred:', error)
      })
    }

    const startupTimer = window.setTimeout(checkPendingQuestions, 0)
    window.addEventListener('pageshow', checkPendingQuestions)
    return () => {
      window.clearTimeout(startupTimer)
      window.removeEventListener('pageshow', checkPendingQuestions)
    }
  }, [])

  useEffect(() => {
    let dismissTimer: number | null = null
    const handleStatus = (event: Event) => {
      const detail = (event as CustomEvent<CoursewareAutoSyncStatusDetail>).detail
      if (!detail) {
        return
      }
      if (dismissTimer !== null) {
        window.clearTimeout(dismissTimer)
      }
      setCoursewareSyncStatus(detail)
      if (detail.state !== 'syncing') {
        dismissTimer = window.setTimeout(() => setCoursewareSyncStatus(null), 7000)
      }
    }

    window.addEventListener(COURSEWARE_AUTO_SYNC_STATUS_EVENT, handleStatus)
    return () => {
      if (dismissTimer !== null) {
        window.clearTimeout(dismissTimer)
      }
      window.removeEventListener(COURSEWARE_AUTO_SYNC_STATUS_EVENT, handleStatus)
    }
  }, [])

  return (
    <div className={`app-shell${isReaderPage ? ' app-shell--reader-page' : ''}`}>
      <AppHeader />
      {coursewareSyncStatus ? (
        <div
          className={`courseware-auto-sync-status courseware-auto-sync-status--${coursewareSyncStatus.state}`}
          role="status"
        >
          <span aria-hidden="true" />
          {coursewareSyncStatus.message}
        </div>
      ) : null}
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/library" element={<KnowledgeLibraryPage />} />
        <Route path="/study-plan" element={<StudyPlanPage />} />
        <Route path="/pdf" element={<PdfWorkspacePage />} />
        <Route path="/settings/api" element={<ApiConfigPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}

export default App

