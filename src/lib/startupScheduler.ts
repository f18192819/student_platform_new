export const PDF_FIRST_VISUAL_READY_EVENT = 'student-platform:pdf-first-visual-ready'

type IdleCapableWindow = Window & typeof globalThis & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

export function notifyPdfFirstVisualReady(pageNumber: number) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PDF_FIRST_VISUAL_READY_EVENT, {
    detail: { pageNumber, readyAt: performance.now() },
  }))
}

export function scheduleStartupTask(
  task: () => void,
  options: {
    waitForPdfVisual: boolean
    delayMs?: number
    target?: EventTarget
    browserWindow?: IdleCapableWindow
  },
) {
  const browserWindow = options.browserWindow ?? window
  const target = options.target ?? browserWindow
  const delayMs = options.delayMs ?? 0
  let delayHandle: number | null = null
  let idleHandle: number | null = null
  let cancelled = false

  const scheduleIdle = () => {
    if (cancelled) return
    const run = () => {
      idleHandle = null
      if (!cancelled) task()
    }
    delayHandle = browserWindow.setTimeout(() => {
      delayHandle = null
      idleHandle = browserWindow.requestIdleCallback
        ? browserWindow.requestIdleCallback(run, { timeout: 2_000 })
        : browserWindow.setTimeout(run, 0)
    }, delayMs)
  }

  const handlePdfReady = () => {
    target.removeEventListener(PDF_FIRST_VISUAL_READY_EVENT, handlePdfReady)
    scheduleIdle()
  }

  if (options.waitForPdfVisual) {
    target.addEventListener(PDF_FIRST_VISUAL_READY_EVENT, handlePdfReady, { once: true })
  } else {
    scheduleIdle()
  }

  return () => {
    cancelled = true
    target.removeEventListener(PDF_FIRST_VISUAL_READY_EVENT, handlePdfReady)
    if (delayHandle !== null) browserWindow.clearTimeout(delayHandle)
    if (idleHandle !== null) {
      if (browserWindow.cancelIdleCallback) browserWindow.cancelIdleCallback(idleHandle)
      else browserWindow.clearTimeout(idleHandle)
    }
  }
}
