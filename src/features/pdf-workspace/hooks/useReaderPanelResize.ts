import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampPanelWidth,
  LEFT_PANEL_MAX,
  LEFT_PANEL_MIN,
  LEFT_PANEL_WIDTH_KEY,
  loadPanelWidth,
  RIGHT_PANEL_MAX,
  RIGHT_PANEL_MIN,
  RIGHT_PANEL_WIDTH_KEY,
} from '../utils'

type ResizeSide = 'left' | 'right'

export function useReaderPanelResize() {
  const [leftPanelWidth, setLeftPanelWidth] = useState(() =>
    clampPanelWidth(loadPanelWidth(LEFT_PANEL_WIDTH_KEY, 320), LEFT_PANEL_MIN, LEFT_PANEL_MAX),
  )
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    clampPanelWidth(loadPanelWidth(RIGHT_PANEL_WIDTH_KEY, 420), RIGHT_PANEL_MIN, RIGHT_PANEL_MAX),
  )
  const readerGridRef = useRef<HTMLElement | null>(null)
  const resizeFrameRef = useRef<number | null>(null)
  const latestPointerXRef = useRef<number | null>(null)
  const activeResizeRef = useRef<{
    side: ResizeSide
    startX: number
    startWidth: number
  } | null>(null)

  useEffect(() => {
    window.localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(leftPanelWidth))
  }, [leftPanelWidth])

  useEffect(() => {
    window.localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(rightPanelWidth))
  }, [rightPanelWidth])

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      latestPointerXRef.current = event.clientX
      if (resizeFrameRef.current !== null) return

      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null
        const activeResize = activeResizeRef.current
        const readerGrid = readerGridRef.current
        const pointerX = latestPointerXRef.current
        if (!activeResize || !readerGrid || pointerX === null) return

        const gridRect = readerGrid.getBoundingClientRect()
        const gapWidth = 36
        const minCenterWidth = 520
        if (activeResize.side === 'left') {
          const maxWidth = Math.min(
            LEFT_PANEL_MAX,
            gridRect.width - rightPanelWidth - minCenterWidth - gapWidth,
          )
          setLeftPanelWidth(
            clampPanelWidth(
              activeResize.startWidth + pointerX - activeResize.startX,
              LEFT_PANEL_MIN,
              Math.max(LEFT_PANEL_MIN, maxWidth),
            ),
          )
          return
        }

        const maxWidth = Math.min(
          RIGHT_PANEL_MAX,
          gridRect.width - leftPanelWidth - minCenterWidth - gapWidth,
        )
        setRightPanelWidth(
          clampPanelWidth(
            activeResize.startWidth + activeResize.startX - pointerX,
            RIGHT_PANEL_MIN,
            Math.max(RIGHT_PANEL_MIN, maxWidth),
          ),
        )
      })
    }

    const stopResize = () => {
      activeResizeRef.current = null
      latestPointerXRef.current = null
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current)
        resizeFrameRef.current = null
      }
      document.body.classList.remove('is-resizing-panels')
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    return () => {
      stopResize()
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
    }
  }, [leftPanelWidth, rightPanelWidth])

  const beginResize = useCallback(
    (side: ResizeSide, startX: number) => {
      activeResizeRef.current = {
        side,
        startX,
        startWidth: side === 'left' ? leftPanelWidth : rightPanelWidth,
      }
      document.body.classList.add('is-resizing-panels')
    },
    [leftPanelWidth, rightPanelWidth],
  )

  return { readerGridRef, leftPanelWidth, rightPanelWidth, beginResize }
}
