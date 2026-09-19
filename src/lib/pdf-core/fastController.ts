import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfController, PdfPageSize } from '../../types'
import { getPdfControllerId, pdfDiagnostic } from './performance'

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
  const pageSizePromises = new Map<number, Promise<PdfPageSize>>()
  const getPageSize = (number: number) => {
    const known = pageSizes[number - 1]
    if (known) return Promise.resolve(known)
    const pending = pageSizePromises.get(number)
    if (pending) return pending
    const task = getPage(number).then(() => pageSizes[number - 1]!)
    pageSizePromises.set(number, task)
    void task.then(
      () => pageSizePromises.delete(number),
      () => pageSizePromises.delete(number),
    )
    return task
  }
  const initialPage = Math.max(1, Math.min(pdf.numPages, Math.trunc(options.initialPage || 1)))
  // Only the page being opened can gate readiness. No text or all-page scan.
  if (!pageSizes[initialPage - 1]) await getPage(initialPage)
  const controller: PdfController = {
    pageCount: pdf.numPages,
    markdown: '',
    pageSizes,
    defaultPageSize: pageSizes[initialPage - 1]!,
    getPage,
    getPageSize,
    dispose: () => pdf.loadingTask.destroy(),
  }
  pdfDiagnostic('controller create', {
    controllerId: getPdfControllerId(controller),
    initialPage,
    pageCount: pdf.numPages,
  })
  return controller
}
