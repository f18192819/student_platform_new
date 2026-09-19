import { useEffect, useRef, useState } from 'react'
import type { PdfController } from '../../types'
import { createMineruHydrationGate } from './mineruGate'

type GateState = {
  documentId: string | null
  controller: PdfController | null
  allowed: boolean
}

export function useMineruHydrationGate(
  documentId: string | null,
  controller: PdfController | null,
  readerVisualReady: boolean,
) {
  const [state, setState] = useState<GateState>({ documentId: null, controller: null, allowed: false })
  const gateRef = useRef<ReturnType<typeof createMineruHydrationGate> | null>(null)
  const readerVisualReadyRef = useRef(readerVisualReady)
  readerVisualReadyRef.current = readerVisualReady

  useEffect(() => {
    gateRef.current?.cancel()
    setState({ documentId, controller, allowed: false })
    if (!documentId) {
      gateRef.current = null
      return
    }

    const gate = createMineruHydrationGate(() => {
      setState((current) => (
        current.documentId === documentId && current.controller === controller
          ? { ...current, allowed: true }
          : current
      ))
    })
    gateRef.current = gate
    if (readerVisualReadyRef.current) gate.allow()
    return () => gate.cancel()
  }, [controller, documentId])

  useEffect(() => {
    if (readerVisualReady) gateRef.current?.allow()
  }, [readerVisualReady])

  return state.documentId === documentId && state.controller === controller && state.allowed
}
