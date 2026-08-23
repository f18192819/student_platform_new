import { useEffect, useRef, useState } from 'react'
import {
  ensureKnowledgeLibraryLoaded,
  KNOWLEDGE_LIBRARY_UPDATED_EVENT,
  loadKnowledgeLibrary,
  refreshKnowledgeLibrary,
} from '../../lib/knowledgeBase'

const SERVER_REFRESH_COOLDOWN_MS = 15_000

export function useKnowledgeLibraryState() {
  const [isReady, setIsReady] = useState(false)
  const [version, setVersion] = useState(0)
  const isRefreshingRef = useRef(false)
  const lastServerRefreshAtRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    const applyLocalSnapshot = () => {
      if (!cancelled) {
        setIsReady(true)
        setVersion((current) => current + 1)
      }
    }

    const syncLibraryFromServer = async (force = false) => {
      if (isRefreshingRef.current) {
        return
      }

      const now = Date.now()
      if (!force && now - lastServerRefreshAtRef.current < SERVER_REFRESH_COOLDOWN_MS) {
        return
      }

      isRefreshingRef.current = true
      try {
        await refreshKnowledgeLibrary()
        lastServerRefreshAtRef.current = Date.now()
        applyLocalSnapshot()
      } catch (error) {
        console.warn('refreshKnowledgeLibrary failed:', error)
      } finally {
        isRefreshingRef.current = false
      }
    }

    const hydrateLibrary = async () => {
      try {
        await ensureKnowledgeLibraryLoaded()
        lastServerRefreshAtRef.current = Date.now()
        applyLocalSnapshot()
      } catch (error) {
        console.warn('ensureKnowledgeLibraryLoaded failed:', error)
      }
    }

    const handleFocus = () => {
      void syncLibraryFromServer(false)
    }

    const handleLibraryUpdated = () => {
      applyLocalSnapshot()
    }

    void hydrateLibrary()
    window.addEventListener('focus', handleFocus)
    window.addEventListener(KNOWLEDGE_LIBRARY_UPDATED_EVENT, handleLibraryUpdated)
    return () => {
      cancelled = true
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener(KNOWLEDGE_LIBRARY_UPDATED_EVENT, handleLibraryUpdated)
    }
  }, [])

  return {
    isReady,
    knowledgeLibrary: loadKnowledgeLibrary(),
    version,
  }
}
