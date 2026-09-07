import { useCallback, useEffect, useRef, useState } from 'react'

export type WorkspacePanelId = 'related' | 'chat' | 'grading' | 'history'

const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 380

export function useFloatingWorkspacePanels() {
  const [activePanel, setActivePanel] = useState<WorkspacePanelId | null>(null)
  const [pinnedPanel, setPinnedPanel] = useState<WorkspacePanelId | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return
    window.clearTimeout(openTimerRef.current)
    openTimerRef.current = null
  }, [])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const previewPanel = useCallback((panel: WorkspacePanelId) => {
    clearOpenTimer()
    clearCloseTimer()
    if (pinnedPanel) return
    openTimerRef.current = window.setTimeout(() => {
      setActivePanel(panel)
      openTimerRef.current = null
    }, OPEN_DELAY_MS)
  }, [clearCloseTimer, clearOpenTimer, pinnedPanel])

  const keepPanelOpen = useCallback(() => {
    clearCloseTimer()
  }, [clearCloseTimer])

  const schedulePanelClose = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    if (pinnedPanel) return
    closeTimerRef.current = window.setTimeout(() => {
      setActivePanel(null)
      closeTimerRef.current = null
    }, CLOSE_DELAY_MS)
  }, [clearCloseTimer, clearOpenTimer, pinnedPanel])

  const togglePinnedPanel = useCallback((panel: WorkspacePanelId) => {
    clearOpenTimer()
    clearCloseTimer()
    setPinnedPanel((current) => {
      if (current === panel) {
        setActivePanel(null)
        return null
      }
      setActivePanel(panel)
      return panel
    })
  }, [clearCloseTimer, clearOpenTimer])

  const pinPanel = useCallback((panel: WorkspacePanelId) => {
    clearOpenTimer()
    clearCloseTimer()
    setActivePanel(panel)
    setPinnedPanel(panel)
  }, [clearCloseTimer, clearOpenTimer])

  const closePanel = useCallback(() => {
    clearOpenTimer()
    clearCloseTimer()
    setActivePanel(null)
    setPinnedPanel(null)
  }, [clearCloseTimer, clearOpenTimer])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !activePanel) return
      event.preventDefault()
      closePanel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [activePanel, closePanel])

  useEffect(() => () => {
    clearOpenTimer()
    clearCloseTimer()
  }, [clearCloseTimer, clearOpenTimer])

  return {
    activePanel,
    pinnedPanel,
    previewPanel,
    keepPanelOpen,
    schedulePanelClose,
    togglePinnedPanel,
    pinPanel,
    closePanel,
  }
}

