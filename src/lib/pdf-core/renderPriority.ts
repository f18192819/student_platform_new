// Visual completion, not metadata/text completion, releases neighbor work.
export function pdfPageRenderPriority(page: number, current: number, count: number, isReady: (page: number) => boolean): 0 | 1 | 2 | null {
  if (page === current) return 0
  if (!isReady(current)) return null
  if (page === current + 1 && page <= count) return 1
  if (page === current - 1 && (current === count || isReady(current + 1))) return 2
  return null
}
