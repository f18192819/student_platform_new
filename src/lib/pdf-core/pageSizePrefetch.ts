import type { PdfController } from '../../types'

export function getPdfPageSizePrefetchOrder(
  controller: PdfController,
  currentPage: number,
  radius: number,
) {
  const pages: number[] = []
  for (let distance = 1; distance <= radius; distance += 1) {
    for (const pageNumber of [currentPage + distance, currentPage - distance]) {
      if (
        pageNumber >= 1 &&
        pageNumber <= controller.pageCount &&
        !controller.pageSizes?.[pageNumber - 1]
      ) {
        pages.push(pageNumber)
      }
    }
  }
  return pages
}

export async function prefetchPdfPageSizes(
  controller: PdfController,
  currentPage: number,
  radius: number,
) {
  if (!controller.getPageSize) return []
  const pages = getPdfPageSizePrefetchOrder(controller, currentPage, radius)
  await Promise.allSettled(pages.map((pageNumber) => controller.getPageSize!(pageNumber)))
  return pages
}
