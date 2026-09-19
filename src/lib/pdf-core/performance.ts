let sequence = 0
export function pdfMark(stage: string, page?: number) {
  if (import.meta.env?.DEV && typeof performance !== 'undefined') {
    performance.mark(`pdf:${stage}${page === undefined ? '' : `:page-${page}`}:${++sequence}`)
  }
}

const controllerIds = new WeakMap<object, number>()
let controllerSequence = 0

export function getPdfControllerId(controller: object | null | undefined) {
  if (!controller) return null
  const existing = controllerIds.get(controller)
  if (existing) return existing
  const id = ++controllerSequence
  controllerIds.set(controller, id)
  return id
}

export function pdfDiagnostic(event: string, details?: Record<string, unknown>) {
  if (!import.meta.env?.DEV) return
  console.debug(`[PDF ${event}]`, details ?? {})
}
