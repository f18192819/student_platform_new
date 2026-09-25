// Visual completion, not metadata/text completion, releases neighbor work.
export function pdfPageRenderPriority(
  page: number,
  current: number,
  count: number,
  isReady: (page: number) => boolean,
  safetyReleased = false,
): 0 | 1 | 2 | null {
  if (page === current) return 0
  if (!isReady(current) && !safetyReleased) return null
  if (page === current + 1 && page <= count) return 1
  if (page === current - 1 && (safetyReleased || current === count || isReady(current + 1))) return 2
  return null
}
