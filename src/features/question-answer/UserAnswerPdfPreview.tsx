import { useEffect, useRef, useState } from 'react'
import { PdfPreviewCanvas } from '../../components/PdfPreviewCanvas'
import { extractPdfPreviewFromBuffer } from '../../lib/pdf'
import {
  clampPdfPage,
  clampPdfZoom,
  getOrCreateCachedPdfPreview,
  loadUserAnswerPdfPreview,
} from './userAnswerPdfPreviewModel'

type PdfPreviewResult = Awaited<ReturnType<typeof extractPdfPreviewFromBuffer>>
export type UserAnswerPdfPreviewCache = Map<string, Promise<PdfPreviewResult>>

export function UserAnswerPdfPreview({ url, fileName, assetKey, cache }: {
  url: string
  fileName: string
  assetKey: string
  cache?: UserAnswerPdfPreviewCache
}) {
  const localCacheRef = useRef<UserAnswerPdfPreviewCache>(new Map())
  const previewCache = cache ?? localCacheRef.current
  const [preview, setPreview] = useState<PdfPreviewResult | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const abortController = new AbortController()
    let active = true
    let settled = false
    const ownsRequest = !previewCache.has(assetKey)

    setPreview(null)
    setCurrentPage(1)
    setZoom(1)
    setError(null)
    setIsLoading(true)

    const task = getOrCreateCachedPdfPreview(previewCache, assetKey, () => (
      loadUserAnswerPdfPreview(
        url,
        fileName,
        abortController.signal,
        extractPdfPreviewFromBuffer,
      )
    ))

    void task.then((result) => {
      settled = true
      if (!active) return
      setPreview(result)
      setIsLoading(false)
    }).catch((reason) => {
      settled = true
      previewCache.delete(assetKey)
      if (!active || abortController.signal.aborted) return
      setError(reason instanceof Error ? reason.message : 'PDF 加载失败。')
      setIsLoading(false)
    })

    return () => {
      active = false
      if (ownsRequest && !settled) {
        previewCache.delete(assetKey)
        abortController.abort()
      }
    }
  }, [assetKey, fileName, previewCache, url])

  if (isLoading) {
    return <div className="user-answer-pdf-preview__status">正在加载 PDF…</div>
  }
  if (error || !preview) {
    return <div className="user-answer-pdf-preview__status is-error">{error || 'PDF 暂时无法显示。'}</div>
  }

  const pageCount = preview.pageCount
  const setPage = (page: number) => setCurrentPage(clampPdfPage(page, pageCount))
  const setSafeZoom = (value: number) => setZoom(clampPdfZoom(value))

  return (
    <div className="user-answer-pdf-preview">
      <PdfPreviewCanvas
        variant="readonly"
        fileName={fileName}
        pdfController={preview.controller}
        currentPage={currentPage}
        pageCount={pageCount}
        zoom={zoom}
        zoomLabel={`${Math.round(zoom * 100)}%`}
        canGoPrev={currentPage > 1}
        canGoNext={currentPage < pageCount}
        onPrevPage={() => setPage(currentPage - 1)}
        onNextPage={() => setPage(currentPage + 1)}
        onZoomOut={() => setSafeZoom(zoom - 0.12)}
        onZoomIn={() => setSafeZoom(zoom + 0.12)}
        onFitWidth={() => setSafeZoom(1)}
        onVisiblePageChange={setPage}
      />
    </div>
  )
}
