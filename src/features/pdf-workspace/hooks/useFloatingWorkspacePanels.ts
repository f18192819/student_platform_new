import { useCallback, useEffect, useRef, useState } from 'react'

export type WorkspacePanelId = 'related' | 'chat' | 'grading' | 'history'
export type WorkspaceLayoutMode = 'wide' | 'single-side' | 'drawer'

type PanelState<T extends WorkspacePanelId> = {
  panel: T | null
  pinned: boolean
  preview: boolean
}

export type WorkspaceLayoutState = {
  left: PanelState<'related'>
  right: PanelState<'chat' | 'grading'>
  bottom: PanelState<'history'>
}

const OPEN_DELAY_MS = 150
const CLOSE_DELAY_MS = 380
const EMPTY_LAYOUT: WorkspaceLayoutState = {
  left: { panel: null, pinned: false, preview: false },
  right: { panel: null, pinned: false, preview: false },
  bottom: { panel: null, pinned: false, preview: false },
}

function slotOf(panel: WorkspacePanelId): keyof WorkspaceLayoutState {
  if (panel === 'related') return 'left'
  if (panel === 'history') return 'bottom'
  return 'right'
}

function viewportMode(): WorkspaceLayoutMode {
  if (typeof window === 'undefined' || window.innerWidth >= 1440) return 'wide'
  if (window.innerWidth >= 900) return 'single-side'
  return 'drawer'
}

export function useFloatingWorkspacePanels() {
  const [layout, setLayout] = useState<WorkspaceLayoutState>(EMPTY_LAYOUT)
  const [mode, setMode] = useState<WorkspaceLayoutMode>(viewportMode)
  const openTimers = useRef<Partial<Record<WorkspacePanelId, number>>>({})
  const closeTimers = useRef<Partial<Record<WorkspacePanelId, number>>>({})
  const lastPanelRef = useRef<WorkspacePanelId | null>(null)

  const clearTimer = useCallback((kind: 'open' | 'close', panel: WorkspacePanelId) => {
    const timers = kind === 'open' ? openTimers.current : closeTimers.current
    const timer = timers[panel]
    if (timer === undefined) return
    window.clearTimeout(timer)
    delete timers[panel]
  }, [])

  const clearPanelTimers = useCallback((panel: WorkspacePanelId) => {
    clearTimer('open', panel)
    clearTimer('close', panel)
  }, [clearTimer])

  const openPanel = useCallback((panel: WorkspacePanelId, pinned: boolean, preview: boolean) => {
    const slot = slotOf(panel)
    lastPanelRef.current = panel
    setLayout((current) => {
      const next: WorkspaceLayoutState = {
        left: { ...current.left },
        right: { ...current.right },
        bottom: { ...current.bottom },
      }
      if (mode !== 'wide' && slot === 'left') next.right = { ...EMPTY_LAYOUT.right }
      if (mode !== 'wide' && slot === 'right') next.left = { ...EMPTY_LAYOUT.left }
      if (mode === 'drawer' && slot !== 'bottom') next.bottom = { ...EMPTY_LAYOUT.bottom }
      if (mode === 'drawer' && slot === 'bottom') {
        next.left = { ...EMPTY_LAYOUT.left }
        next.right = { ...EMPTY_LAYOUT.right }
      }
      if (slot === 'left') next.left = { panel: 'related', pinned, preview }
      if (slot === 'right') next.right = { panel: panel as 'chat' | 'grading', pinned, preview }
      if (slot === 'bottom') next.bottom = { panel: 'history', pinned, preview }
      return next
    })
  }, [mode])

  const closePanel = useCallback((panel: WorkspacePanelId) => {
    clearPanelTimers(panel)
    const slot = slotOf(panel)
    setLayout((current) => ({ ...current, [slot]: { ...EMPTY_LAYOUT[slot] } }))
  }, [clearPanelTimers])

  const previewPanel = useCallback((panel: WorkspacePanelId) => {
    if (mode === 'drawer') return
    clearPanelTimers(panel)
    const current = layout[slotOf(panel)]
    if (current.pinned) return
    openTimers.current[panel] = window.setTimeout(() => {
      openPanel(panel, false, true)
      delete openTimers.current[panel]
    }, OPEN_DELAY_MS)
  }, [clearPanelTimers, layout, mode, openPanel])

  const keepPanelOpen = useCallback((panel: WorkspacePanelId) => {
    clearTimer('close', panel)
  }, [clearTimer])

  const schedulePanelClose = useCallback((panel: WorkspacePanelId) => {
    clearTimer('open', panel)
    clearTimer('close', panel)
    if (layout[slotOf(panel)].pinned) return
    closeTimers.current[panel] = window.setTimeout(() => {
      closePanel(panel)
      delete closeTimers.current[panel]
    }, CLOSE_DELAY_MS)
  }, [clearTimer, closePanel, layout])

  const togglePinnedPanel = useCallback((panel: WorkspacePanelId) => {
    clearPanelTimers(panel)
    const current = layout[slotOf(panel)]
    if (current.panel === panel && current.pinned) {
      closePanel(panel)
      return
    }
    openPanel(panel, true, false)
  }, [clearPanelTimers, closePanel, layout, openPanel])

  const pinPanel = useCallback((panel: WorkspacePanelId) => {
    clearPanelTimers(panel)
    openPanel(panel, true, false)
  }, [clearPanelTimers, openPanel])

  useEffect(() => {
    const handleResize = () => setMode(viewportMode())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (mode === 'wide') return
    setLayout((current) => {
      if (!current.left.panel || !current.right.panel) return current
      return lastPanelRef.current === 'related'
        ? { ...current, right: { ...EMPTY_LAYOUT.right } }
        : { ...current, left: { ...EMPTY_LAYOUT.left } }
    })
  }, [mode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const preview = [layout.bottom, layout.right, layout.left].find((slot) => slot.panel && !slot.pinned)
      const panel = preview?.panel ?? lastPanelRef.current
      if (!panel) return
      event.preventDefault()
      closePanel(panel)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closePanel, layout])

  useEffect(() => () => {
    Object.values(openTimers.current).forEach((timer) => window.clearTimeout(timer))
    Object.values(closeTimers.current).forEach((timer) => window.clearTimeout(timer))
  }, [])

  return {
    layout,
    mode,
    previewPanel,
    keepPanelOpen,
    schedulePanelClose,
    togglePinnedPanel,
    pinPanel,
    closePanel,
  }
}
