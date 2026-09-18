import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfController, PdfPageSize } from '../../types'

export type FastPdfOpenOptions = {
  initialPage?: number
  pageSizes?: Array<PdfPageSize | null>
}

export async function createFastPdfController(pdf: PDFDocumentProxy, options: FastPdfOpenOptions = {}): Promise<PdfController> {
  const pageSizes: Array<PdfPageSize | null> = Array.from({ length: pdf.numPages }, (_, index) => {
    const size = options.pageSizes?.[index]
    return size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0 ? size : null
  })
  const getPage = async (number: number) => {
    const page = await pdf.getPage(number)
    const viewport = page.getViewport({ scale: 1 })
    pageSizes[number - 1] = { width: viewport.width, height: viewport.height }
    return page
  }
  const initialPage = Math.max(1, Math.min(pdf.numPages, Math.trunc(options.initialPage || 1)))
  // Only the page being opened can gate readiness. No text or all-page scan.
  if (!pageSizes[initialPage - 1]) await getPage(initialPage)
  return {
    pageCount: pdf.numPages,
    markdown: '',
    pageSizes,
    defaultPageSize: pageSizes[initialPage - 1]!,
    getPage,
    getPageSize: async number => {
      if (!pageSizes[number - 1]) await getPage(number)
      return pageSizes[number - 1]!
    },
    dispose: () => pdf.loadingTask.destroy(),
  }
}
