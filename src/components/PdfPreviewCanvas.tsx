import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { useLayoutEffect } from 'react'
import { useEffectEvent } from 'react'
import type {
  ClassroomLectureSegment,
  HomeworkKnowledgeLink,
  HomeworkQuestion,
  PdfController,
  StructuredDocumentBlock,
} from '../types'

const BASE_RENDER_SCALE = 1.35

type TextStyleLike = {
  ascent?: number
  descent?: number
  fontFamily?: string
}

type TextLayerSpan = {
  text: string
  left: number
  top: number
  width: number
  height: number
  fontSize: number
  fontFamily: string
  transform: string
}

type TextLine = {
  text: string
  left: number
  top: number
  right: number
  bottom: number
  height: number
}

type TextBlock = {
  id: string
  text: string
  label?: string
  kind?: StructuredDocumentBlock['kind']
  source?: StructuredDocumentBlock['source']
  left: number
  top: number
  right: number
  bottom: number
}

type ReferenceBlockSelection = Pick<
  TextBlock,
  'id' | 'text' | 'label' | 'kind' | 'source'
>

type TextSelectionPayload = {
  pageNumber: number
  text: string
  source?: 'block' | 'selection'
  label?: string
  kind?: StructuredDocumentBlock['kind']
  blockId?: string
  blockSource?: StructuredDocumentBlock['source']
  blocks?: ReferenceBlockSelection[]
}

type ReferenceSelectionRect = {
  left: number
  top: number
  width: number
  height: number
}

type RenderedPageData = {
  pageNumber: number
  width: number
  height: number
  textLayer: TextLayerSpan[]
}

function getFallbackRenderedPageWidth(pdfController: PdfController | null, pageNumber: number) {
  const width = pdfController?.pageSizes?.[pageNumber - 1]?.width
  return typeof width === 'number' ? width * BASE_RENDER_SCALE : null
}

type PdfPreviewCanvasProps = {
  fileName: string
  pdfController: PdfController | null
  imageUrl?: string | null
  currentPage: number
  pageCount: number | null
  zoom: number
  zoomLabel: string
  canGoPrev: boolean
  canGoNext: boolean
  onPrevPage: () => void
  onNextPage: () => void
  onZoomOut: () => void
  onZoomIn: () => void
  onFitWidth: () => void
  onOpenPdf: () => void
  onVisiblePageChange: (pageNumber: number) => void
  onInspectPageDoubts: (pageNumber: number) => void
  onInspectPageLectureSegments: (pageNumber: number) => void
  onPlayPageLectureSegments: (pageNumber: number) => void
  playingLecturePage?: number | null
  showLectureControls?: boolean
  onInspectPageQuestions: (pageNumber: number) => void
  isCaptureMode: boolean
  selectedHomeworkQuestion: HomeworkQuestion | null
  structuredBlocks?: StructuredDocumentBlock[]
  lectureSegmentsByPage?: Map<number, ClassroomLectureSegment[]>
  homeworkKnowledgeLinks?: HomeworkKnowledgeLink[]
  onOpenKnowledgeLink?: (linkId: string) => void
  onOpenLecturePageQuestions?: (pageNumber: number) => void
  visibleQuestions?: HomeworkQuestion[]
  onVisibleQuestionChange?: (questionId: string) => void
  onCaptureSelection: (capture: {
    pageNumber: number
    dataUrl: string
    width: number
    height: number
  }) => void
  onTextSelection: (selection: TextSelectionPayload) => void
  referencedBlockIds?: Set<string>
  onRemoveBlockReference?: (blockId: string) => void
}

function buildTextLayer(
  viewport: ReturnType<Awaited<ReturnType<PdfController['getPage']>>['getViewport']>,
  textContent: Awaited<ReturnType<Awaited<ReturnType<PdfController['getPage']>>['getTextContent']>>,
) {
  const spans: TextLayerSpan[] = []

  for (const item of textContent.items) {
    if (!('str' in item) || !item.str?.trim()) {
      continue
    }

    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform)
    const angle = Math.atan2(tx[1], tx[0])
    const fontHeight = Math.hypot(tx[2], tx[3])
    const style = textContent.styles[item.fontName] as TextStyleLike | undefined
    const fontAscent = style?.ascent
      ? style.ascent * fontHeight
      : style?.descent
        ? (1 + style.descent) * fontHeight
        : fontHeight
    const rawWidth = typeof item.width === 'number' ? item.width : item.str.length * fontHeight * 0.55

    spans.push({
      text: item.str,
      left: tx[4],
      top: tx[5] - fontAscent,
      width: Math.max(rawWidth * viewport.scale, fontHeight * 0.8),
      height: fontHeight,
      fontSize: fontHeight,
      fontFamily: style?.fontFamily ?? 'sans-serif',
      transform: `rotate(${angle}rad) scaleX(${Math.hypot(tx[0], tx[1]) / Math.max(fontHeight, 1)})`,
    })
  }

  return spans
}

function buildLineText(spans: TextLayerSpan[]) {
  return [...spans]
    .sort((left, right) => left.left - right.left)
    .reduce((current, span, index, sorted) => {
      if (!index) {
        return span.text
      }

      const previous = sorted[index - 1]
      const previousChar = previous.text.trim().slice(-1)
      const nextChar = span.text.trim().slice(0, 1)
      const gap = span.left - (previous.left + previous.width)
      const shouldInsertSpace =
        gap > Math.max(previous.fontSize * 0.45, 10) ||
        (gap > Math.max(previous.fontSize * 0.18, 4) &&
          /[A-Za-z0-9)\]]/.test(previousChar) &&
          /[-A-Za-z0-9([]/.test(nextChar))

      return `${current}${shouldInsertSpace ? ' ' : ''}${span.text}`
    }, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function buildTextBlocks(pageNumber: number, spans: TextLayerSpan[]) {
  const normalizedSpans = spans
    .map((span) => ({
      ...span,
      right: span.left + span.width,
      bottom: span.top + span.height,
    }))
    .sort((left, right) => (left.top === right.top ? left.left - right.left : left.top - right.top))

  if (!normalizedSpans.length) {
    return []
  }

  const lines: TextLine[] = []

  normalizedSpans.forEach((span) => {
    const lastLine = lines.at(-1)
    const spanCenter = span.top + span.height / 2
    const lineCenter = lastLine ? lastLine.top + lastLine.height / 2 : null
    const sameLine =
      lastLine &&
      lineCenter !== null &&
      Math.abs(spanCenter - lineCenter) <= Math.max(6, Math.min(lastLine.height, span.height) * 0.55)

    if (!sameLine || !lastLine) {
      lines.push({
        text: span.text,
        left: span.left,
        top: span.top,
        right: span.right,
        bottom: span.bottom,
        height: span.height,
      })
      return
    }

    lastLine.left = Math.min(lastLine.left, span.left)
    lastLine.top = Math.min(lastLine.top, span.top)
    lastLine.right = Math.max(lastLine.right, span.right)
    lastLine.bottom = Math.max(lastLine.bottom, span.bottom)
    lastLine.height = Math.max(lastLine.height, span.height)
    lastLine.text = buildLineText(
      normalizedSpans.filter(
        (candidate) =>
          candidate.top >= lastLine.top - 0.5 &&
          candidate.bottom <= lastLine.bottom + 0.5 &&
          Math.abs(candidate.top + candidate.height / 2 - (lastLine.top + lastLine.height / 2)) <=
            Math.max(6, Math.min(lastLine.height, candidate.height) * 0.7),
      ),
    )
  })

  const blocks: TextBlock[] = []
  let currentLines: TextLine[] = []

  const flushBlock = () => {
    if (!currentLines.length) {
      return
    }

    const text = currentLines
      .map((line) => line.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()

    if (!text) {
      currentLines = []
      return
    }

    blocks.push({
      id: `page-${pageNumber}-block-${blocks.length + 1}`,
      text,
      left: Math.min(...currentLines.map((line) => line.left)),
      top: Math.min(...currentLines.map((line) => line.top)),
      right: Math.max(...currentLines.map((line) => line.right)),
      bottom: Math.max(...currentLines.map((line) => line.bottom)),
    })
    currentLines = []
  }

  lines.forEach((line) => {
    const previousLine = currentLines.at(-1)
    if (!previousLine) {
      currentLines.push(line)
      return
    }

    const verticalGap = line.top - previousLine.bottom
    const overlap = Math.max(
      0,
      Math.min(previousLine.right, line.right) - Math.max(previousLine.left, line.left),
    )
    const overlapRatio = overlap / Math.max(1, Math.min(previousLine.right - previousLine.left, line.right - line.left))
    const sameColumn =
      overlapRatio >= 0.16 ||
      Math.abs(line.left - previousLine.left) <= Math.max(28, Math.min(line.height, previousLine.height) * 1.8)
    const sameBlock = verticalGap <= Math.max(18, Math.min(previousLine.height, line.height) * 0.95) && sameColumn

    if (!sameBlock) {
      flushBlock()
    }

    currentLines.push(line)
  })

  flushBlock()
  return blocks.filter((block) => block.text.length >= 2)
}

function findTextBlockAtPoint(blocks: TextBlock[], x: number, y: number) {
  let bestMatch: TextBlock | null = null
  let smallestArea = Number.POSITIVE_INFINITY

  for (const block of blocks) {
    if (x < block.left || x > block.right || y < block.top || y > block.bottom) {
      continue
    }

    const area = Math.max(1, (block.right - block.left) * (block.bottom - block.top))
    if (area < smallestArea) {
      smallestArea = area
      bestMatch = block
    }
  }

  return bestMatch
}

function findTextBlocksInRect(blocks: TextBlock[], rect: ReferenceSelectionRect) {
  const right = rect.left + rect.width
  const bottom = rect.top + rect.height
  return blocks.filter((block) =>
    block.right >= rect.left &&
    block.left <= right &&
    block.bottom >= rect.top &&
    block.top <= bottom,
  )
}

function buildStructuredBlocksForPage(
  pageNumber: number,
  width: number,
  height: number,
  baseWidth: number,
  baseHeight: number,
  blocks: StructuredDocumentBlock[],
) {
  const pageBlocks = blocks.filter((block) => block.pageNumber === pageNumber)
  const hasPdfPageCoordinates = pageBlocks.some((block) => block.coordinateSpace === 'pdf-page')
  // Legacy content_list coordinates lack the page dimensions. New local MinerU
  // blocks are tagged with PDF-native coordinates and map directly to this page.
  const rawDocumentMaxRight = blocks.reduce((max, block) => {
    const right = Number(block.bbox[2] ?? 0)
    return Number.isFinite(right) ? Math.max(max, right) : max
  }, 0)
  const rawDocumentMaxBottom = blocks.reduce((max, block) => {
    const bottom = Number(block.bbox[3] ?? 0)
    return Number.isFinite(bottom) ? Math.max(max, bottom) : max
  }, 0)
  const rawCoordinateWidth = hasPdfPageCoordinates ? baseWidth : Math.max(baseWidth, rawDocumentMaxRight)
  const rawCoordinateHeight = hasPdfPageCoordinates ? baseHeight : Math.max(baseHeight, rawDocumentMaxBottom)

  return pageBlocks
    .map((block) => {
      const [left, top, right, bottom] = block.bbox
      const isNormalized = Math.max(left, top, right, bottom) <= 1.5
      const scaleX = !isNormalized && rawCoordinateWidth > 0 ? width / rawCoordinateWidth : 1
      const scaleY = !isNormalized && rawCoordinateHeight > 0 ? height / rawCoordinateHeight : 1
      return {
        id: block.id,
        text: block.text.trim() || block.label,
        label: block.label,
        kind: block.kind,
        source: block.source,
        left: isNormalized ? left * width : left * scaleX,
        top: isNormalized ? top * height : top * scaleY,
        right: isNormalized ? right * width : right * scaleX,
        bottom: isNormalized ? bottom * height : bottom * scaleY,
      } satisfies TextBlock
    })
    .filter((block) => block.right - block.left >= 4 && block.bottom - block.top >= 4)
}

function normalizeMatchText(value: string) {
  return value.replace(/\s+/g, '').replace(/[，。；：、,.;:()（）【】[\]]/g, '').toLowerCase()
}

function findQuestionStartBlock(question: HomeworkQuestion, blocks: TextBlock[]) {
  const anchor = normalizeMatchText(
    question.anchorText || question.title || question.content.slice(0, 80),
  )
  return blocks.find((block) => {
    const blockText = normalizeMatchText(block.text)
    const probe = anchor.slice(0, Math.min(anchor.length, 36))
    return probe.length >= 4 && (blockText.includes(probe) || probe.includes(blockText.slice(0, 24)))
  })
}

function resolveVisibleQuestionId(
  pageElement: HTMLElement,
  viewport: HTMLElement,
  pageNumber: number,
  questions: HomeworkQuestion[],
  pageData: RenderedPageData | undefined,
  pdfController: PdfController,
  structuredBlocks: StructuredDocumentBlock[],
  visibleBoundsOverride?: { top: number; bottom: number },
) {
  const pageQuestions = questions.filter((question) => question.pageNumber === pageNumber)
  if (!pageQuestions.length || !pageData) {
    return null
  }

  const canvas = pageElement.querySelector<HTMLCanvasElement>('.pdf-stage__page-canvas')
  if (!canvas) {
    return null
  }

  const baseWidth = pdfController.pageSizes?.[pageNumber - 1]?.width ?? pageData.width / BASE_RENDER_SCALE
  const baseHeight = pdfController.pageSizes?.[pageNumber - 1]?.height ?? pageData.height / BASE_RENDER_SCALE
  const blocks = buildStructuredBlocksForPage(
    pageNumber,
    pageData.width,
    pageData.height,
    baseWidth,
    baseHeight,
    structuredBlocks,
  ).sort((left, right) => left.top - right.top)
  if (!blocks.length && pageQuestions.length > 1) {
    return null
  }

  const starts = pageQuestions.map((question, index) => {
    const match = findQuestionStartBlock(question, blocks)
    return {
      question,
      top: match?.top ?? (pageQuestions.length === 1 ? 0 : null),
      index,
    }
  })

  const canvasBounds = canvas.getBoundingClientRect()
  const viewportBounds = visibleBoundsOverride ?? viewport.getBoundingClientRect()
  let best: { questionId: string; ratio: number } | null = null
  for (const item of starts) {
    if (item.top === null) {
      continue
    }
    const next = starts.slice(item.index + 1).find((candidate) => candidate.top !== null)
    const bottom = next?.top ?? pageData.height
    const regionHeight = Math.max(1, bottom - item.top)
    const top = canvasBounds.top + (item.top / pageData.height) * canvasBounds.height
    const regionBottom = canvasBounds.top + (bottom / pageData.height) * canvasBounds.height
    const visibleHeight = Math.max(0, Math.min(regionBottom, viewportBounds.bottom) - Math.max(top, viewportBounds.top))
    const ratio = visibleHeight / Math.max(1, (regionHeight / pageData.height) * canvasBounds.height)
    if (!best || ratio > best.ratio) {
      best = { questionId: item.question.id, ratio }
    }
  }

  return best && best.ratio >= 0.5 ? best.questionId : null
}

const PdfPageCanvas = memo(function PdfPageCanvas({
  pdfController,
  pageNumber,
  displayScale,
  structuredBlocks = [],
  onRendered,
  isCaptureMode,
  onCaptureSelection,
  onTextSelection,
  referencedBlockIds = new Set<string>(),
  onRemoveBlockReference,
}: {
  pdfController: PdfController
  pageNumber: number
  displayScale: number
  structuredBlocks?: StructuredDocumentBlock[]
  onRendered: (page: RenderedPageData) => void
  isCaptureMode: boolean
  onCaptureSelection: (capture: {
    pageNumber: number
    dataUrl: string
    width: number
    height: number
  }) => void
  onTextSelection: (selection: TextSelectionPayload) => void
  referencedBlockIds?: Set<string>
  onRemoveBlockReference?: (blockId: string) => void
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onRenderedRef = useRef(onRendered)
  const captureSelectionRef = useRef(onCaptureSelection)
  const textSelectionRef = useRef(onTextSelection)
  const referenceDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const dragStateRef = useRef<{
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const captureRectRef = useRef<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [pageData, setPageData] = useState<RenderedPageData | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [captureRect, setCaptureRect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const [referenceSelectionRect, setReferenceSelectionRect] = useState<ReferenceSelectionRect | null>(null)
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null)

  useEffect(() => {
    onRenderedRef.current = onRendered
  }, [onRendered])

  useEffect(() => {
    captureSelectionRef.current = onCaptureSelection
  }, [onCaptureSelection])

  useEffect(() => {
    textSelectionRef.current = onTextSelection
  }, [onTextSelection])

  useEffect(() => {
    if (isCaptureMode) {
      return
    }

    dragStateRef.current = null
    captureRectRef.current = null
    setCaptureRect(null)
  }, [isCaptureMode])

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setHoveredBlockId(null)
      }
    }

    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let renderTask: ReturnType<Awaited<ReturnType<PdfController['getPage']>>['render']> | null = null

    const renderPage = async () => {
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }

      setRenderError(null)
      const page = await pdfController.getPage(pageNumber)
      if (cancelled) {
        return
      }

      const viewport = page.getViewport({ scale: BASE_RENDER_SCALE })
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) {
        throw new Error('Browser canvas is unavailable.')
      }

      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
      })
      await renderTask.promise

      if (cancelled) {
        return
      }

      const textContent = await page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
      })

      if (cancelled) {
        return
      }

      const nextPageData = {
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        textLayer: buildTextLayer(viewport, textContent),
      } satisfies RenderedPageData

      setPageData(nextPageData)
      onRenderedRef.current(nextPageData)
    }

    void renderPage().catch((error) => {
      if (cancelled) {
        return
      }

      setRenderError(error instanceof Error ? error.message : 'PDF render failed')
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pageNumber, pdfController])

  const textBlocks = useMemo(() => {
    if (!pageData) {
      return []
    }

    const mineruBlocks = structuredBlocks.filter((block) => block.source !== 'pdfjs-fallback')
    if (mineruBlocks.length) {
      const basePageWidth = pdfController.pageSizes?.[pageNumber - 1]?.width ?? pageData.width / BASE_RENDER_SCALE
      const basePageHeight =
        pdfController.pageSizes?.[pageNumber - 1]?.height ?? pageData.height / BASE_RENDER_SCALE
      const structuredPageBlocks = buildStructuredBlocksForPage(
        pageNumber,
        pageData.width,
        pageData.height,
        basePageWidth,
        basePageHeight,
        mineruBlocks,
      )
      return structuredPageBlocks
    }

    return buildTextBlocks(pageNumber, pageData.textLayer)
  }, [pageData, pageNumber, pdfController, structuredBlocks])

  const hoveredBlock = useMemo(
    () => textBlocks.find((block) => block.id === hoveredBlockId) ?? null,
    [hoveredBlockId, textBlocks],
  )

  const hasLocalMineruBlocks = structuredBlocks.some((block) => block.source === 'mineru-local')

  const resolvePointerPosition = (event: React.PointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current
    if (!canvas || !pageData || !textBlocks.length) {
      return null
    }

    // Use the transformed canvas bounds. The outer surface can be clipped by
    // the reader width, especially while zoomed and horizontally scrolled.
    const bounds = canvas.getBoundingClientRect()
    const x = Math.min(
      Math.max(((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * pageData.width, 0),
      pageData.width,
    )
    const y = Math.min(
      Math.max(((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * pageData.height, 0),
      pageData.height,
    )
    return { x, y }
  }

  const resolvePointerBlock = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = resolvePointerPosition(event)
    return point ? findTextBlockAtPoint(textBlocks, point.x, point.y) : null
  }

  const beginCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isCaptureMode) {
      return
    }

    const surface = surfaceRef.current
    if (!surface) {
      return
    }

    const bounds = surface.getBoundingClientRect()
    const startX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width)
    const startY = Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height)

    dragStateRef.current = {
      pointerId: event.pointerId,
      startX,
      startY,
    }
    const nextRect = { left: startX, top: startY, width: 0, height: 0 }
    captureRectRef.current = nextRect
    setCaptureRect(nextRect)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
    event.preventDefault()
  }

  const updateCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    const surface = surfaceRef.current
    if (!dragState || !surface || dragState.pointerId !== event.pointerId) {
      return
    }

    const bounds = surface.getBoundingClientRect()
    const currentX = Math.min(Math.max(event.clientX - bounds.left, 0), bounds.width)
    const currentY = Math.min(Math.max(event.clientY - bounds.top, 0), bounds.height)
    const left = Math.min(dragState.startX, currentX)
    const top = Math.min(dragState.startY, currentY)
    const width = Math.abs(currentX - dragState.startX)
    const height = Math.abs(currentY - dragState.startY)

    const nextRect = { left, top, width, height }
    captureRectRef.current = nextRect
    setCaptureRect(nextRect)
    event.stopPropagation()
    event.preventDefault()
  }

  const finishCapture = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current
    const surface = surfaceRef.current
    const canvas = canvasRef.current
    const rect = captureRectRef.current
    if (!dragState || !surface || !canvas || dragState.pointerId !== event.pointerId) {
      return
    }

    dragStateRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.stopPropagation()
    event.preventDefault()

    if (!rect || rect.width < 10 || rect.height < 10) {
      captureRectRef.current = null
      setCaptureRect(null)
      return
    }

    const scaleX = canvas.width / surface.clientWidth
    const scaleY = canvas.height / surface.clientHeight
    const sourceX = Math.max(0, Math.floor(rect.left * scaleX))
    const sourceY = Math.max(0, Math.floor(rect.top * scaleY))
    const sourceWidth = Math.max(1, Math.floor(rect.width * scaleX))
    const sourceHeight = Math.max(1, Math.floor(rect.height * scaleY))
    const captureCanvas = document.createElement('canvas')
    captureCanvas.width = sourceWidth
    captureCanvas.height = sourceHeight
    const captureContext = captureCanvas.getContext('2d')

    if (captureContext) {
      captureContext.drawImage(
        canvas,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight,
      )

      captureSelectionRef.current({
        pageNumber,
        dataUrl: captureCanvas.toDataURL('image/png'),
        width: sourceWidth,
        height: sourceHeight,
      })
    }

    setCaptureRect(null)
    captureRectRef.current = null
  }

  const beginTextSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (isCaptureMode || event.button !== 0 || !event.shiftKey) {
      return
    }

    const point = resolvePointerPosition(event)
    if (!point) return

    referenceDragRef.current = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
    }
    setReferenceSelectionRect({ left: point.x, top: point.y, width: 0, height: 0 })
    setHoveredBlockId(resolvePointerBlock(event)?.id ?? null)
    window.getSelection()?.removeAllRanges()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
    event.preventDefault()
  }

  const updateTextSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = referenceDragRef.current
    const point = resolvePointerPosition(event)
    if (!drag || !point || drag.pointerId !== event.pointerId) {
      return
    }

    setReferenceSelectionRect({
      left: Math.min(drag.startX, point.x),
      top: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX),
      height: Math.abs(point.y - drag.startY),
    })
    event.stopPropagation()
    event.preventDefault()
  }

  const finishTextSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = referenceDragRef.current
    const point = resolvePointerPosition(event)
    if (!drag || !point || drag.pointerId !== event.pointerId) return

    referenceDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const rect = {
      left: Math.min(drag.startX, point.x),
      top: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX),
      height: Math.abs(point.y - drag.startY),
    }
    setReferenceSelectionRect(null)
    const selectedBlocks = rect.width < 5 && rect.height < 5
      ? [findTextBlockAtPoint(textBlocks, point.x, point.y)].filter((block): block is TextBlock => Boolean(block))
      : findTextBlocksInRect(textBlocks, rect)
    if (selectedBlocks.length) {
      const first = selectedBlocks[0]
      textSelectionRef.current({
        pageNumber,
        text: first.text,
        source: 'block',
        label: first.label,
        kind: first.kind,
        blockId: first.id,
        blockSource: first.source,
        blocks: selectedBlocks,
      })
    }
    event.stopPropagation()
    event.preventDefault()
  }

  return (
    <div
      ref={surfaceRef}
      className="pdf-stage__page-surface"
      onPointerDown={beginTextSelection}
      onPointerMove={(event) => {
        if (referenceDragRef.current) {
          updateTextSelection(event)
          return
        }
        if (isCaptureMode || !event.shiftKey || !textBlocks.length) {
          if (hoveredBlockId !== null) {
            setHoveredBlockId(null)
          }
          return
        }

        const nextBlock = resolvePointerBlock(event)
        const nextBlockId = nextBlock?.id ?? null
        if (nextBlockId !== hoveredBlockId) {
          setHoveredBlockId(nextBlockId)
        }
      }}
      onPointerUp={finishTextSelection}
      onPointerLeave={() => {
        if (!referenceDragRef.current) setHoveredBlockId(null)
      }}
      onPointerCancel={() => {
        referenceDragRef.current = null
        setReferenceSelectionRect(null)
        setHoveredBlockId(null)
      }}
      style={
        pageData
          ? {
              width: `${pageData.width * displayScale}px`,
              height: `${pageData.height * displayScale}px`,
            }
          : undefined
      }
    >
      <canvas
        ref={canvasRef}
        className="pdf-stage__page-canvas"
        style={
          pageData
            ? {
                width: `${pageData.width}px`,
                height: `${pageData.height}px`,
                transform: `scale(${displayScale})`,
                transformOrigin: 'top left',
                visibility: 'visible',
              }
            : undefined
        }
      />
      {pageData && !hasLocalMineruBlocks ? (
        <div
          className="pdf-stage__text-layer"
          style={{
            width: `${pageData.width}px`,
            height: `${pageData.height}px`,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
        >
          {pageData.textLayer.map((span, index) => (
            <span
              key={`${pageNumber}-${index}-${span.left}-${span.top}`}
              style={{
                left: `${span.left}px`,
                top: `${span.top}px`,
                fontSize: `${span.fontSize}px`,
                fontFamily: span.fontFamily,
                transform: span.transform,
              }}
            >
              {span.text}
            </span>
          ))}
        </div>
      ) : null}
      {pageData && hoveredBlock ? (
        <div
          className="pdf-stage__block-layer"
          style={{
            width: `${pageData.width}px`,
            height: `${pageData.height}px`,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
        >
          <div
            className="pdf-stage__block-highlight"
            style={{
              left: `${hoveredBlock.left}px`,
              top: `${hoveredBlock.top}px`,
              width: `${Math.max(1, hoveredBlock.right - hoveredBlock.left)}px`,
              height: `${Math.max(1, hoveredBlock.bottom - hoveredBlock.top)}px`,
            }}
          />
        </div>
      ) : null}
      {pageData && referenceSelectionRect ? (
        <div
          className="pdf-stage__block-layer"
          style={{
            width: `${pageData.width}px`,
            height: `${pageData.height}px`,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
        >
          <div
            className="pdf-stage__block-selection-box"
            style={{
              left: `${referenceSelectionRect.left}px`,
              top: `${referenceSelectionRect.top}px`,
              width: `${referenceSelectionRect.width}px`,
              height: `${referenceSelectionRect.height}px`,
            }}
          />
        </div>
      ) : null}
      {pageData && textBlocks.length ? (
        <div
          className="pdf-stage__block-layer"
          style={{
            width: `${pageData.width}px`,
            height: `${pageData.height}px`,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
        >
          {textBlocks
            .filter((block) => referencedBlockIds.has(block.id))
            .map((block) => (
              <button
                key={`referenced-${block.id}`}
                type="button"
                className="pdf-stage__block-reference-badge"
                style={{
                  left: `${Math.max(10, block.right - 6)}px`,
                  top: `${Math.max(10, block.top - 6)}px`,
                }}
                title="再次点击移除该引用"
                aria-label="移除该区块引用"
                onClick={(event) => {
                  event.stopPropagation()
                  onRemoveBlockReference?.(block.id)
                }}
              >
                !
              </button>
            ))}
        </div>
      ) : null}
      {isCaptureMode && pageData ? (
        <div
          className="pdf-stage__capture-overlay"
          onPointerDown={beginCapture}
          onPointerMove={updateCapture}
          onPointerUp={finishCapture}
          onPointerCancel={() => {
            dragStateRef.current = null
            captureRectRef.current = null
            setCaptureRect(null)
          }}
        >
          {captureRect ? (
            <div
              className="pdf-stage__capture-box"
              style={{
                left: `${captureRect.left}px`,
                top: `${captureRect.top}px`,
                width: `${captureRect.width}px`,
                height: `${captureRect.height}px`,
              }}
            />
          ) : (
            <div className="pdf-stage__capture-hint">拖动框选当前页面区域</div>
          )}
        </div>
      ) : null}
      {renderError ? <div className="empty-state pdf-stage__page-error">{renderError}</div> : null}
    </div>
  )
})

const ImagePreviewSurface = memo(function ImagePreviewSurface({
  fileName,
  imageUrl,
  currentPage,
  structuredBlocks = [],
  onTextSelection,
  referencedBlockIds = new Set<string>(),
  onRemoveBlockReference,
}: {
  fileName: string
  imageUrl: string
  currentPage: number
  structuredBlocks?: StructuredDocumentBlock[]
  onTextSelection: (selection: TextSelectionPayload) => void
  referencedBlockIds?: Set<string>
  onRemoveBlockReference?: (blockId: string) => void
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 })
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 })
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null)
  const referenceDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const [referenceSelectionRect, setReferenceSelectionRect] = useState<ReferenceSelectionRect | null>(null)

  useLayoutEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof ResizeObserver === 'undefined') {
      return
    }

    const updateSize = () => {
      setSurfaceSize({
        width: surface.clientWidth,
        height: surface.clientHeight,
      })
    }

    updateSize()
    const observer = new ResizeObserver(() => updateSize())
    observer.observe(surface)
    return () => {
      observer.disconnect()
    }
  }, [imageUrl])

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') {
        setHoveredBlockId(null)
      }
    }

    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [])

  const displayBlocks = useMemo(() => {
    if (!surfaceSize.width || !surfaceSize.height || !naturalSize.width || !naturalSize.height) {
      return []
    }

    return buildStructuredBlocksForPage(
      currentPage,
      surfaceSize.width,
      surfaceSize.height,
      naturalSize.width,
      naturalSize.height,
      structuredBlocks,
    )
  }, [currentPage, naturalSize, structuredBlocks, surfaceSize])

  const hoveredBlock = useMemo(
    () => displayBlocks.find((block) => block.id === hoveredBlockId) ?? null,
    [displayBlocks, hoveredBlockId],
  )

  const resolvePointerPosition = (event: React.PointerEvent<HTMLDivElement>) => {
    const image = imageRef.current
    if (!image || !displayBlocks.length) {
      return null
    }

    const bounds = image.getBoundingClientRect()
    const x = ((event.clientX - bounds.left) / Math.max(bounds.width, 1)) * surfaceSize.width
    const y = ((event.clientY - bounds.top) / Math.max(bounds.height, 1)) * surfaceSize.height
    return { x, y }
  }

  const resolvePointerBlock = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = resolvePointerPosition(event)
    return point ? findTextBlockAtPoint(displayBlocks, point.x, point.y) : null
  }

  const beginTextSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.shiftKey) {
      return
    }

    const point = resolvePointerPosition(event)
    if (!point) return

    referenceDragRef.current = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
    }
    setReferenceSelectionRect({ left: point.x, top: point.y, width: 0, height: 0 })
    setHoveredBlockId(resolvePointerBlock(event)?.id ?? null)
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
    event.preventDefault()
  }

  const updateTextSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = referenceDragRef.current
    const point = resolvePointerPosition(event)
    if (!drag || !point || drag.pointerId !== event.pointerId) return
    setReferenceSelectionRect({
      left: Math.min(drag.startX, point.x),
      top: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX),
      height: Math.abs(point.y - drag.startY),
    })
    event.stopPropagation()
    event.preventDefault()
  }

  const finishTextSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = referenceDragRef.current
    const point = resolvePointerPosition(event)
    if (!drag || !point || drag.pointerId !== event.pointerId) return
    referenceDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const rect = {
      left: Math.min(drag.startX, point.x),
      top: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX),
      height: Math.abs(point.y - drag.startY),
    }
    setReferenceSelectionRect(null)
    const selectedBlocks = rect.width < 5 && rect.height < 5
      ? [findTextBlockAtPoint(displayBlocks, point.x, point.y)].filter((block): block is TextBlock => Boolean(block))
      : findTextBlocksInRect(displayBlocks, rect)
    if (selectedBlocks.length) {
      const first = selectedBlocks[0]
      onTextSelection({
        pageNumber: currentPage,
        text: first.text,
        source: 'block',
        label: first.label,
        kind: first.kind,
        blockId: first.id,
        blockSource: first.source,
        blocks: selectedBlocks,
      })
    }
    event.stopPropagation()
    event.preventDefault()
  }

  return (
    <div className="pdf-stage__image-view">
      <div
        ref={surfaceRef}
        className="pdf-stage__image-surface"
        onPointerDown={beginTextSelection}
        onPointerMove={(event) => {
          if (referenceDragRef.current) {
            updateTextSelection(event)
            return
          }
          if (!event.shiftKey || !displayBlocks.length) {
            if (hoveredBlockId !== null) {
              setHoveredBlockId(null)
            }
            return
          }

          const nextBlock = resolvePointerBlock(event)
          const nextBlockId = nextBlock?.id ?? null
          if (nextBlockId !== hoveredBlockId) {
            setHoveredBlockId(nextBlockId)
          }
        }}
        onPointerUp={finishTextSelection}
        onPointerLeave={() => {
          if (!referenceDragRef.current) setHoveredBlockId(null)
        }}
        onPointerCancel={() => {
          referenceDragRef.current = null
          setReferenceSelectionRect(null)
          setHoveredBlockId(null)
        }}
      >
        <img
          ref={imageRef}
          src={imageUrl}
          alt={fileName}
          className="pdf-stage__image-asset"
          onLoad={() => {
            const image = imageRef.current
            if (!image) {
              return
            }
            setNaturalSize({
              width: image.naturalWidth,
              height: image.naturalHeight,
            })
          }}
        />
        {hoveredBlock ? (
          <div
            className="pdf-stage__block-layer"
            style={{
              width: `${surfaceSize.width}px`,
              height: `${surfaceSize.height}px`,
            }}
          >
            <div
              className="pdf-stage__block-highlight"
              style={{
                left: `${hoveredBlock.left}px`,
                top: `${hoveredBlock.top}px`,
                width: `${Math.max(1, hoveredBlock.right - hoveredBlock.left)}px`,
                height: `${Math.max(1, hoveredBlock.bottom - hoveredBlock.top)}px`,
              }}
            />
          </div>
        ) : null}
        {referenceSelectionRect ? (
          <div
            className="pdf-stage__block-layer"
            style={{
              width: `${surfaceSize.width}px`,
              height: `${surfaceSize.height}px`,
            }}
          >
            <div
              className="pdf-stage__block-selection-box"
              style={{
                left: `${referenceSelectionRect.left}px`,
                top: `${referenceSelectionRect.top}px`,
                width: `${referenceSelectionRect.width}px`,
                height: `${referenceSelectionRect.height}px`,
              }}
            />
          </div>
        ) : null}
        {displayBlocks.length ? (
          <div
            className="pdf-stage__block-layer"
            style={{
              width: `${surfaceSize.width}px`,
              height: `${surfaceSize.height}px`,
            }}
          >
            {displayBlocks
              .filter((block) => referencedBlockIds.has(block.id))
              .map((block) => (
                <button
                  key={`referenced-${block.id}`}
                  type="button"
                  className="pdf-stage__block-reference-badge"
                  style={{
                    left: `${Math.max(10, block.right - 6)}px`,
                    top: `${Math.max(10, block.top - 6)}px`,
                  }}
                  title="再次点击移除该引用"
                  aria-label="移除该区块引用"
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemoveBlockReference?.(block.id)
                  }}
                >
                  !
                </button>
              ))}
          </div>
        ) : null}
      </div>
    </div>
  )
})

export const PdfPreviewCanvas = memo(function PdfPreviewCanvas({
  fileName,
  pdfController,
  imageUrl = null,
  currentPage,
  pageCount,
  zoom,
  zoomLabel,
  canGoPrev,
  canGoNext,
  onPrevPage,
  onNextPage,
  onZoomOut,
  onZoomIn,
  onFitWidth,
  onOpenPdf,
  onVisiblePageChange,
  onInspectPageDoubts,
  onInspectPageLectureSegments,
  onPlayPageLectureSegments,
  playingLecturePage = null,
  showLectureControls = true,
  onInspectPageQuestions,
  isCaptureMode,
  selectedHomeworkQuestion,
  structuredBlocks = [],
  lectureSegmentsByPage = new Map(),
  homeworkKnowledgeLinks = [],
  onOpenKnowledgeLink,
  onOpenLecturePageQuestions,
  visibleQuestions = [],
  onVisibleQuestionChange,
  onCaptureSelection,
  onTextSelection,
  referencedBlockIds = new Set<string>(),
  onRemoveBlockReference,
}: PdfPreviewCanvasProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef(new Map<number, HTMLElement>())
  const renderedPagesRef = useRef(new Map<number, RenderedPageData>())
  const isAutoScrollingRef = useRef(false)
  const pageChangeFromUserScrollRef = useRef<number | null>(null)
  const questionChangeFromUserScrollRef = useRef<string | null>(null)
  const previousSelectedQuestionIdRef = useRef<string | null>(null)
  const visibleQuestionIdRef = useRef<string | null>(null)
  const previousPdfControllerRef = useRef<PdfController | null>(null)
  const questionAnchorTimerRef = useRef<number | null>(null)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [isRendering, setIsRendering] = useState(false)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [isInitialPdfPaintPending, setIsInitialPdfPaintPending] = useState(false)
  const requestVisiblePageChange = useEffectEvent((pageNumber: number) => {
    onVisiblePageChange(pageNumber)
  })

  const pageNumbers = useMemo(
    () => (pdfController ? Array.from({ length: pdfController.pageCount }, (_, index) => index + 1) : []),
    [pdfController],
  )

  const lecturePageQuestionLinks = useMemo(() => {
    const pageMap = new Map<number, HomeworkKnowledgeLink[]>()
    for (const link of homeworkKnowledgeLinks) {
      if (!link.lecturePageNumber) {
        continue
      }

      const current = pageMap.get(link.lecturePageNumber) ?? []
      current.push(link)
      pageMap.set(link.lecturePageNumber, current)
    }
    return pageMap
  }, [homeworkKnowledgeLinks])

  useEffect(() => {
    const controllerChanged = previousPdfControllerRef.current !== pdfController
    previousPdfControllerRef.current = pdfController
    if (controllerChanged) {
      pageChangeFromUserScrollRef.current = null
      questionChangeFromUserScrollRef.current = null
      previousSelectedQuestionIdRef.current = null
      visibleQuestionIdRef.current = null
    }
    pageRefs.current.clear()
    renderedPagesRef.current.clear()
    setRenderError(null)
    setIsRendering(Boolean(pdfController && !imageUrl))
    setIsInitialPdfPaintPending(Boolean(controllerChanged && pdfController && !imageUrl))
  }, [imageUrl, pdfController])

  useEffect(() => () => {
    if (questionAnchorTimerRef.current !== null) {
      window.clearTimeout(questionAnchorTimerRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const updateWidth = () => {
      setViewportWidth(viewport.clientWidth)
    }

    updateWidth()
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => updateWidth())
    observer.observe(viewport)

    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!pdfController) {
      return
    }

    const questionId = selectedHomeworkQuestion?.id ?? null
    const questionPageNumber = selectedHomeworkQuestion?.pageNumber
    if (!questionId) {
      previousSelectedQuestionIdRef.current = null
      return
    }
    if (previousSelectedQuestionIdRef.current === questionId) {
      return
    }
    previousSelectedQuestionIdRef.current = questionId

    if (
      questionChangeFromUserScrollRef.current === questionId ||
      !questionPageNumber
    ) {
      return
    }

    requestVisiblePageChange(questionPageNumber)
  }, [pdfController, selectedHomeworkQuestion?.id, selectedHomeworkQuestion?.pageNumber])

  useEffect(() => {
    if (!pdfController) {
      return
    }

    const container = viewportRef.current
    const activePage = pageRefs.current.get(currentPage)
    if (!container || !activePage) {
      return
    }

    if (pageChangeFromUserScrollRef.current === currentPage) {
      pageChangeFromUserScrollRef.current = null
      return
    }
    pageChangeFromUserScrollRef.current = null

    isAutoScrollingRef.current = true
    const containerBounds = container.getBoundingClientRect()
    const pageBounds = activePage.getBoundingClientRect()
    if (container.scrollHeight > container.clientHeight + 1) {
      container.scrollTo({
        top: Math.max(
          0,
          container.scrollTop + pageBounds.top - containerBounds.top - 12,
        ),
        behavior: 'auto',
      })
    } else {
      window.scrollTo({
        top: Math.max(0, window.scrollY + pageBounds.top - 12),
        behavior: 'auto',
      })
    }

    const timer = window.setTimeout(() => {
      isAutoScrollingRef.current = false
    }, 160)

    return () => {
      window.clearTimeout(timer)
    }
  }, [currentPage, isRendering, pdfController])

  const scrollToQuestionAnchor = (
    question: HomeworkQuestion,
    pageData: RenderedPageData,
  ) => {
    if (!pdfController || question.pageNumber !== pageData.pageNumber) {
      return false
    }

    const container = viewportRef.current
    const pageElement = pageRefs.current.get(pageData.pageNumber)
    const canvas = pageElement?.querySelector<HTMLCanvasElement>('.pdf-stage__page-canvas')
    if (!container || !pageElement || !canvas) {
      return false
    }

    const baseWidth =
      pdfController.pageSizes?.[pageData.pageNumber - 1]?.width ??
      pageData.width / BASE_RENDER_SCALE
    const baseHeight =
      pdfController.pageSizes?.[pageData.pageNumber - 1]?.height ??
      pageData.height / BASE_RENDER_SCALE
    const blocks = buildStructuredBlocksForPage(
      pageData.pageNumber,
      pageData.width,
      pageData.height,
      baseWidth,
      baseHeight,
      structuredBlocks,
    )
    const match = findQuestionStartBlock(question, blocks)
    if (!match) {
      return false
    }

    const canvasBounds = canvas.getBoundingClientRect()
    const containerBounds = container.getBoundingClientRect()
    const anchorOffset = (match.top / Math.max(pageData.height, 1)) * canvasBounds.height
    isAutoScrollingRef.current = true
    if (container.scrollHeight > container.clientHeight + 1) {
      const targetTop =
        container.scrollTop + canvasBounds.top - containerBounds.top + anchorOffset - 28
      container.scrollTo({
        top: Math.max(0, targetTop),
        behavior: 'smooth',
      })
    } else {
      window.scrollBy({
        top: canvasBounds.top + anchorOffset - 28,
        behavior: 'smooth',
      })
    }
    if (questionAnchorTimerRef.current !== null) {
      window.clearTimeout(questionAnchorTimerRef.current)
    }
    questionAnchorTimerRef.current = window.setTimeout(() => {
      isAutoScrollingRef.current = false
      questionAnchorTimerRef.current = null
    }, 320)
    return true
  }
  const scrollToQuestionAnchorEffect = useEffectEvent(scrollToQuestionAnchor)

  useEffect(() => {
    if (
      selectedHomeworkQuestion?.id &&
      questionChangeFromUserScrollRef.current === selectedHomeworkQuestion.id
    ) {
      questionChangeFromUserScrollRef.current = null
      return
    }

    if (
      isRendering ||
      !selectedHomeworkQuestion?.pageNumber ||
      selectedHomeworkQuestion.pageNumber !== currentPage
    ) {
      return
    }
    const pageData = renderedPagesRef.current.get(selectedHomeworkQuestion.pageNumber)
    if (!pageData) {
      return
    }
    scrollToQuestionAnchorEffect(selectedHomeworkQuestion, pageData)
  }, [currentPage, isRendering, pdfController, selectedHomeworkQuestion, structuredBlocks])

  useEffect(() => {
    if (!pdfController) {
      return
    }

    const container = viewportRef.current
    if (!container) {
      return
    }

    const handleScroll = () => {
      if (isAutoScrollingRef.current || isRendering) {
        return
      }

      const usesWindowScroll = container.scrollHeight <= container.clientHeight + 1
      const containerBounds = usesWindowScroll
        ? { top: 0, bottom: window.innerHeight }
        : container.getBoundingClientRect()
      const visibleViewportHeight = Math.max(containerBounds.bottom - containerBounds.top, 1)
      let nextPage = currentPage
      let largestVisibleRatio = 0
      let largestVisiblePage = currentPage

      pageRefs.current.forEach((element, pageNumber) => {
        const bounds = element.getBoundingClientRect()
        const visibleHeight = Math.max(
          0,
          Math.min(bounds.bottom, containerBounds.bottom) - Math.max(bounds.top, containerBounds.top),
        )
        const visibleRatio =
          visibleHeight / Math.max(Math.min(bounds.height, visibleViewportHeight), 1)
        if (visibleRatio > largestVisibleRatio) {
          largestVisibleRatio = visibleRatio
          largestVisiblePage = pageNumber
        }
      })

      if (largestVisibleRatio >= 0.5) {
        nextPage = largestVisiblePage
      }

      if (nextPage !== currentPage) {
        pageChangeFromUserScrollRef.current = nextPage
        onVisiblePageChange(nextPage)
      }

      const activePage = pageRefs.current.get(nextPage)
      const visibleQuestionId =
        activePage && onVisibleQuestionChange
          ? resolveVisibleQuestionId(
              activePage,
              container,
              nextPage,
              visibleQuestions,
              renderedPagesRef.current.get(nextPage),
              pdfController,
              structuredBlocks,
              containerBounds,
            )
          : null
      if (visibleQuestionId && visibleQuestionId !== visibleQuestionIdRef.current) {
        visibleQuestionIdRef.current = visibleQuestionId
        questionChangeFromUserScrollRef.current = visibleQuestionId
        onVisibleQuestionChange?.(visibleQuestionId)
      }
    }

    const scrollTarget: HTMLElement | Window =
      container.scrollHeight > container.clientHeight + 1 ? container : window
    scrollTarget.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      scrollTarget.removeEventListener('scroll', handleScroll)
    }
  }, [
    currentPage,
    isRendering,
    onVisiblePageChange,
    onVisibleQuestionChange,
    pdfController,
    structuredBlocks,
    visibleQuestions,
  ])

  const handlePageRendered = (page: RenderedPageData) => {
    renderedPagesRef.current.set(page.pageNumber, page)
    if (!isRendering && selectedHomeworkQuestion?.pageNumber === page.pageNumber) {
      window.requestAnimationFrame(() => {
        scrollToQuestionAnchor(selectedHomeworkQuestion, page)
      })
    }
    if (page.pageNumber === 1) {
      setIsInitialPdfPaintPending(false)
    }

    if (renderedPagesRef.current.size === pageNumbers.length) {
      setIsRendering(false)
      setRenderError(null)
    }
  }

  const firstRenderedPage =
    renderedPagesRef.current.get(1) ?? renderedPagesRef.current.values().next().value
  const firstPageWidth =
    getFallbackRenderedPageWidth(pdfController, 1) ?? firstRenderedPage?.width ?? null
  const effectiveViewportWidth = viewportRef.current?.clientWidth || viewportWidth || 0
  const isViewportMeasured = effectiveViewportWidth > 0
  const hasRenderedFirstPage = renderedPagesRef.current.has(1) || renderedPagesRef.current.size > 0
  const fitScale =
    firstPageWidth && effectiveViewportWidth
      ? Math.min(1, Math.max(0.45, (effectiveViewportWidth - 52) / firstPageWidth))
      : 1
  const displayScale = Math.min(1, zoom * fitScale)
  const isReaderReady =
    !pdfController ||
    Boolean(imageUrl) ||
    (isViewportMeasured && Boolean(firstPageWidth) && hasRenderedFirstPage && !isInitialPdfPaintPending)

  return (
    <div className="pdf-stage">
      <div className="pdf-stage__toolbar">
        <div>
          <span>PDF Reader</span>
          <strong>{fileName}</strong>
        </div>
        <div className="pdf-stage__controls">
          <button type="button" className="toolbar-pill" onClick={onZoomOut}>
            缩小
          </button>
          <button type="button" className="toolbar-pill" onClick={onOpenPdf}>
            打开 PDF
          </button>
          <button type="button" className="toolbar-pill">
            {zoomLabel}
          </button>
          <button type="button" className="toolbar-pill" onClick={onZoomIn}>
            放大
          </button>
          <button type="button" className="toolbar-pill" onClick={onFitWidth}>
            适应宽度
          </button>
        </div>
      </div>

      <div className="pdf-stage__pager">
        <button type="button" className="toolbar-pill" disabled={!canGoPrev} onClick={onPrevPage}>
          上一页
        </button>
        <strong>
          第 {currentPage} 页{pageCount ? ` / 共 ${pageCount} 页` : ''}
        </strong>
        <button type="button" className="toolbar-pill" disabled={!canGoNext} onClick={onNextPage}>
          下一页
        </button>
      </div>

      {selectedHomeworkQuestion && pdfController ? (
        <div className="pdf-stage__question-banner">
          <div className="pdf-stage__question-banner-meta">
            <span>当前题目</span>
            <strong>{selectedHomeworkQuestion.title}</strong>
          </div>
          <div className="pdf-stage__question-banner-body">
            {selectedHomeworkQuestion.pageNumber ? (
              <button
                type="button"
                className="toolbar-pill toolbar-pill--accent"
                onClick={() => onVisiblePageChange(selectedHomeworkQuestion.pageNumber!)}
              >
                跳到第 {selectedHomeworkQuestion.pageNumber} 页
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="pdf-stage__viewport" ref={viewportRef}>
        {imageUrl ? (
          <ImagePreviewSurface
            fileName={fileName}
            imageUrl={imageUrl}
            currentPage={currentPage}
            structuredBlocks={structuredBlocks}
            onTextSelection={onTextSelection}
            referencedBlockIds={referencedBlockIds}
            onRemoveBlockReference={onRemoveBlockReference}
          />
        ) : !pdfController ? (
          <div className="empty-state pdf-stage__empty">上传 PDF 后，这里会显示正式 PDF 页面。</div>
        ) : (
          <div
            className="pdf-stage__stack"
            style={isReaderReady ? undefined : { visibility: 'hidden' }}
          >
            {pageNumbers.map((pageNumber) => {
              const pageLinks = lecturePageQuestionLinks.get(pageNumber) ?? []
              const lectureSegments = lectureSegmentsByPage.get(pageNumber) ?? []
              const hasLectureExplanation = lectureSegments.length > 0
              const hasPlayableLecture = lectureSegments.some(
                (segment) =>
                  segment.recordingId &&
                  segment.startSeconds !== null &&
                  segment.endSeconds !== null &&
                  segment.endSeconds > segment.startSeconds,
              )

              return (
                <article
                  key={pageNumber}
                  className="pdf-stage__page-shell"
                  data-page-number={pageNumber}
                  ref={(node) => {
                    if (node) {
                      pageRefs.current.set(pageNumber, node)
                      return
                    }

                    pageRefs.current.delete(pageNumber)
                  }}
                >
                  <div
                    className="pdf-stage__page-meta"
                    style={
                      (renderedPagesRef.current.get(pageNumber)?.width ??
                        getFallbackRenderedPageWidth(pdfController, pageNumber))
                        ? {
                            width: `min(100%, ${
                              (renderedPagesRef.current.get(pageNumber)?.width ??
                                getFallbackRenderedPageWidth(pdfController, pageNumber) ??
                                0) * displayScale
                            }px)`,
                          }
                        : undefined
                    }
                  >
                    <div className="pdf-stage__page-label">第 {pageNumber} 页</div>
                    <div className="pdf-stage__page-actions">
                      {pageLinks.slice(0, 2).map((link) => (
                        <button
                          key={link.id}
                          type="button"
                          className="toolbar-pill toolbar-pill--knowledge"
                          onClick={() => onOpenKnowledgeLink?.(link.id)}
                          title={link.questionTitle || link.conceptTitle}
                        >
                          {(link.questionTitle || `题目 ${(link.questionIndex ?? 0) + 1}`).slice(0, 10)}
                        </button>
                      ))}
                      {pageLinks.length > 0 ? (
                        <button
                          type="button"
                          className="toolbar-pill toolbar-pill--knowledge-count"
                          onClick={() => onOpenLecturePageQuestions?.(pageNumber)}
                          title={`查看第 ${pageNumber} 页关联题目`}
                        >
                          {pageLinks.length} 题
                        </button>
                      ) : null}
                      {pageLinks.length > 0 ? (
                        <button
                          type="button"
                          className="toolbar-pill toolbar-pill--knowledge-count"
                          onClick={() => onInspectPageQuestions(pageNumber)}
                          title={`查看第 ${pageNumber} 页相关题目`}
                        >
                          查看题目
                        </button>
                      ) : null}
                      {showLectureControls && hasLectureExplanation ? (
                        <button
                          type="button"
                          className="toolbar-pill toolbar-pill--knowledge-count"
                          onClick={() => onInspectPageLectureSegments(pageNumber)}
                          title={`查看第 ${pageNumber} 页的 ${lectureSegments.length} 段课堂讲解`}
                        >
                          查看课堂讲解 ({lectureSegments.length})
                        </button>
                      ) : null}
                      {showLectureControls && hasPlayableLecture ? (
                        <button
                          type="button"
                          className="toolbar-pill toolbar-pill--knowledge-count"
                          onClick={() => onPlayPageLectureSegments(pageNumber)}
                          title={
                            playingLecturePage === pageNumber
                              ? `正在播放第 ${pageNumber} 页课堂讲解`
                              : `播放第 ${pageNumber} 页对应的连续录音片段`
                          }
                        >
                          {playingLecturePage === pageNumber ? '播放中' : '播放讲解'}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="toolbar-pill toolbar-pill--accent pdf-stage__doubt-button"
                        onClick={() => onInspectPageDoubts(pageNumber)}
                      >
                        查看疑点
                      </button>
                    </div>
                  </div>
                  <PdfPageCanvas
                    pdfController={pdfController}
                    pageNumber={pageNumber}
                    displayScale={displayScale}
                    structuredBlocks={structuredBlocks}
                    onRendered={handlePageRendered}
                    isCaptureMode={isCaptureMode}
                    onCaptureSelection={onCaptureSelection}
                    onTextSelection={onTextSelection}
                    referencedBlockIds={referencedBlockIds}
                    onRemoveBlockReference={onRemoveBlockReference}
                  />
                </article>
              )
            })}
          </div>
        )}

        {pdfController && !imageUrl && (isRendering || !isReaderReady) ? (
          <div className="empty-state pdf-stage__rendering-overlay">正在渲染 PDF 页面，请稍候...</div>
        ) : null}

        {renderError ? (
          <div className="empty-state pdf-stage__empty">PDF 渲染失败：{renderError}</div>
        ) : null}
      </div>
    </div>
  )
})

