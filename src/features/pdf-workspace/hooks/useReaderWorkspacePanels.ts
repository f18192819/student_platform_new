import { useCallback, useEffect, useRef, useState } from 'react'

export type WorkspacePanelId = 'classroom' | 'related' | 'chat' | 'grading' | 'history'
export type WorkspaceLayoutMode = 'wide' | 'single-side' | 'drawer'

type PanelState<T extends WorkspacePanelId> = {
  panel: T | null
}

export type WorkspaceLayoutState = {
  left: PanelState<'classroom' | 'related' | 'grading' | 'history'>
  right: PanelState<'chat'>
}

const EMPTY_LAYOUT: WorkspaceLayoutState = {
  left: { panel: null },
  right: { panel: null },
}

function slotOf(panel: WorkspacePanelId): keyof WorkspaceLayoutState {
  return panel === 'chat' ? 'right' : 'left'
}

function viewportMode(): WorkspaceLayoutMode {
  if (typeof window === 'undefined' || window.innerWidth >= 1440) return 'wide'
  if (window.innerWidth >= 900) return 'single-side'
  return 'drawer'
}

export function useReaderWorkspacePanels() {
  const [mode, setMode] = useState<WorkspaceLayoutMode>(viewportMode)
  const [layout, setLayout] = useState<WorkspaceLayoutState>(EMPTY_LAYOUT)
  const lastPanelRef = useRef<WorkspacePanelId | null>(null)

  const openPanel = useCallback((panel: WorkspacePanelId) => {
    const slot = slotOf(panel)
    lastPanelRef.current = panel
    setLayout((current) => {
      const next: WorkspaceLayoutState = {
        left: { ...current.left },
        right: { ...current.right },
      }
      if (mode !== 'wide' && slot === 'left') next.right = { ...EMPTY_LAYOUT.right }
      if (mode !== 'wide' && slot === 'right') next.left = { ...EMPTY_LAYOUT.left }
      if (slot === 'left') next.left = { panel: panel as 'classroom' | 'related' | 'grading' | 'history' }
      if (slot === 'right') next.right = { panel: 'chat' }
      return next
    })
  }, [mode])

  const closePanel = useCallback((panel: WorkspacePanelId) => {
    const slot = slotOf(panel)
    setLayout((current) => ({ ...current, [slot]: { ...EMPTY_LAYOUT[slot] } }))
  }, [])

  const togglePanel = useCallback((panel: WorkspacePanelId) => {
    const current = layout[slotOf(panel)]
    if (current.panel === panel) {
      closePanel(panel)
      return
    }
    openPanel(panel)
  }, [closePanel, layout, openPanel])

  useEffect(() => {
    const handleResize = () => setMode(viewportMode())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (mode === 'wide') return
    setLayout((current) => {
      if (!current.left.panel || !current.right.panel) return current
      return lastPanelRef.current && slotOf(lastPanelRef.current) === 'left'
        ? { ...current, right: { ...EMPTY_LAYOUT.right } }
        : { ...current, left: { ...EMPTY_LAYOUT.left } }
    })
  }, [mode])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const panel = lastPanelRef.current ?? layout.right.panel ?? layout.left.panel
      if (!panel) return
      event.preventDefault()
      closePanel(panel)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closePanel, layout])

  return {
    layout,
    mode,
    togglePanel,
    openPanel,
    closePanel,
  }
}
