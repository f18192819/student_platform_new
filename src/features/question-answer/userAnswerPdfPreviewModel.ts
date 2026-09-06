type PdfFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type PdfExtractor<TResult> = (buffer: ArrayBuffer, fileName: string) => Promise<TResult>

export function clampPdfPage(page: number, pageCount: number) {
  return Math.min(Math.max(Math.round(page), 1), Math.max(pageCount, 1))
}

export function clampPdfZoom(zoom: number) {
  return Math.min(2, Math.max(0.5, zoom))
}

export function getOrCreateCachedPdfPreview<TResult>(
  cache: Map<string, Promise<TResult>>,
  key: string,
  load: () => Promise<TResult>,
) {
  const cached = cache.get(key)
  if (cached) return cached
  const task = load()
  cache.set(key, task)
  return task
}

export async function loadUserAnswerPdfPreview<TResult>(
  url: string,
  fileName: string,
  signal: AbortSignal,
  extractor: PdfExtractor<TResult>,
  fetcher: PdfFetcher = fetch,
) {
  const response = await fetcher(url, { signal })
  if (!response.ok) {
    throw new Error(`PDF 加载失败（${response.status}）`)
  }
  const buffer = await response.arrayBuffer()
  if (signal.aborted) {
    throw new DOMException('The PDF request was aborted.', 'AbortError')
  }
  return extractor(buffer, fileName)
}
