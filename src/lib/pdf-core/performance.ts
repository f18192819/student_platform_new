let sequence = 0
export function pdfMark(stage: string, page?: number) {
  if (import.meta.env?.DEV && typeof performance !== 'undefined') {
    performance.mark(`pdf:${stage}${page === undefined ? '' : `:page-${page}`}:${++sequence}`)
  }
}
