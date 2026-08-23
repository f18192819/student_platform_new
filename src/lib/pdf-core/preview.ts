import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PdfController, PdfOutlineBlock } from '../../types'
import {
  ensureUint8ArrayToHex,
  normalizePdfData,
  PDFJS_CMAP_URL,
  PDFJS_STANDARD_FONT_DATA_URL,
} from './assets'
import { extractPageMarkdown, type PageExtraction } from './layout'

ensureUint8ArrayToHex()

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url,
).toString()

function dedupeOutlineBlocks(blocks: PdfOutlineBlock[]) {
  const seen = new Set<string>()

  return blocks.filter((block) => {
    const key = `${block.page}-${block.title}-${block.body}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function chooseDocumentTitle(fileName: string, firstPageHeadings: string[]) {
  const fallbackTitle = fileName.replace(/\.pdf$/i, '')
  const candidate = firstPageHeadings.find((heading) => heading.length >= 4 && heading.length <= 32)
  return candidate ?? fallbackTitle
}

function createPdfDocumentTask(buffer: ArrayBuffer) {
  return pdfjsLib.getDocument({
    data: normalizePdfData(buffer),
    cMapUrl: PDFJS_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDFJS_STANDARD_FONT_DATA_URL,
  })
}

export async function probePdfPageCountFromBuffer(buffer: ArrayBuffer) {
  const task = createPdfDocumentTask(buffer)
  const pdf = await task.promise
  return pdf.numPages
}

export async function extractPdfPreviewFromBuffer(buffer: ArrayBuffer, fileName: string) {
  const task = createPdfDocumentTask(buffer)
  const pdf = await task.promise
  const pageResults: PageExtraction[] = []

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    try {
      const content = await page.getTextContent()
      pageResults.push(
        extractPageMarkdown(pageNumber, viewport.width, viewport.height, content.items, pdf.numPages),
      )
    } catch (error) {
      console.warn(`pdf text extraction failed on page ${pageNumber}:`, error)
      pageResults.push({
        pageWidth: viewport.width,
        pageHeight: viewport.height,
        markdownLines: [`## 第 ${pageNumber} 页`, '', '> 该页文本提取失败，已保留 PDF 原页供阅读。'],
        outlineBlocks: [],
        headingCandidates: [],
        plainText: '',
      })
    }
  }

  const documentTitle = chooseDocumentTitle(fileName, pageResults[0]?.headingCandidates ?? [])
  const outlineBlocks = dedupeOutlineBlocks(
    pageResults.flatMap((result) => result.outlineBlocks).filter((block) => block.body.length > 0),
  ).slice(0, 18)

  const markdownSections: string[] = [
    '---',
    `source: ${fileName}`,
    `pages: ${pdf.numPages}`,
    'extractor: layout-aware-pdfjs-v2',
    '---',
    '',
    `# ${documentTitle}`,
  ]

  if (outlineBlocks.length) {
    markdownSections.push('', '## 内容提要')
    outlineBlocks.slice(0, 12).forEach((block) => {
      const label = block.title === `第 ${block.page} 页` ? block.body : `${block.title} · ${block.body}`
      markdownSections.push(`- 第 ${block.page} 页：${label}`)
    })
  }

  pageResults.forEach((result) => {
    markdownSections.push('', ...result.markdownLines)
  })

  const markdown = markdownSections.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const controller: PdfController = {
    pageCount: pdf.numPages,
    markdown,
    pageSizes: pageResults.map((result) => ({
      width: result.pageWidth,
      height: result.pageHeight,
    })),
    getPage: (pageNumber: number) => pdf.getPage(pageNumber),
  }

  return {
    controller,
    pageCount: pdf.numPages,
    previewUrl: null,
    markdown,
    outlineBlocks,
    pageTexts: pageResults.map((result) => result.plainText),
  }
}

export async function extractPdfPreview(file: File) {
  const buffer = await file.arrayBuffer()
  const extracted = await extractPdfPreviewFromBuffer(buffer, file.name)
  return {
    ...extracted,
    buffer,
  }
}

export async function probePdfPageCount(file: File) {
  const buffer = await file.arrayBuffer()
  return probePdfPageCountFromBuffer(buffer)
}
