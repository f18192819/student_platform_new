import { memo, useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { useLayoutEffect } from 'react'
import { useEffectEvent } from 'react'
import { pdfPageRenderPriority } from '../lib/pdf-core/renderPriority'
import { getPdfControllerId, pdfDiagnostic, pdfMark } from '../lib/pdf-core/performance'
import { prefetchPdfPageSizes } from '../lib/pdf-core/pageSizePrefetch'
import type {
  ClassroomLectureSegment,
  HomeworkKnowledgeLink,
  HomeworkQuestion,
  PdfController,
  StructuredDocumentBlock,
} from '../types'
import type {
  PdfAnnotation,
  PdfAnnotationTool,
} from '../features/pdf-annotations/pdfAnnotationStore'

const BASE_RENDER_SCALE = 1.35
const PAGE_SIZE_PREFETCH_RADIUS = 2

type IdleWindow = typeof window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

type PendingPageNavigation = {
  pageNumber: number
  behavior: ScrollBehavior
  source: 'pager' | 'question' | 'external'
}

type ViewportAnchor = {
  pageNumber: number
  normalizedY: number
}

function getExpectedPageSurfaceSize(
  pdfController: PdfController,
  pageNumber: number,
  displayScale: number,
) {
  const pageSize = pdfController.pageSizes?.[pageNumber - 1] ?? pdfController.defaultPageSize
  if (!pageSize) return null
  return {
    width: pageSize.width * BASE_RENDER_SCALE * displayScale,
    height: pageSize.height * BASE_RENDER_SCALE * displayScale,
  }
}

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
  const width = (pdfController?.pageSizes?.[pageNumber - 1] ?? pdfController?.defaultPageSize)?.width
  return typeof width === 'number' ? width * BASE_RENDER_SCALE : null
}

type PdfPreviewCanvasProps = {
  onVisualReady?: (pageNumber: number) => void
  variant?: 'workspace' | 'readonly'
  fileName: string
  pdfController: PdfController | null
  pageImageUrl?: (pageNumber: number) => string | null
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
  onOpenPdf?: () => void
  onVisiblePageChange: (pageNumber: number) => void
  onInspectPageDoubts?: (pageNumber: number) => void
  onInspectPageLectureSegments?: (pageNumber: number) => void
  onPlayPageLectureSegments?: (pageNumber: number) => void
  playingLecturePage?: number | null
  showLectureControls?: boolean
  onInspectPageQuestions?: (pageNumber: number) => void
  isCaptureMode?: boolean
  selectedHomeworkQuestion?: HomeworkQuestion | null
  structuredBlocks?: StructuredDocumentBlock[]
  lectureSegmentsByPage?: Map<number, ClassroomLectureSegment[]>
  homeworkKnowledgeLinks?: HomeworkKnowledgeLink[]
  onOpenKnowledgeLink?: (linkId: string) => void
  onOpenLecturePageQuestions?: (pageNumber: number) => void
  visibleQuestions?: HomeworkQuestion[]
  onVisibleQuestionChange?: (questionId: string) => void
  onCaptureSelection?: (capture: {
    pageNumber: number
    dataUrl: string
    width: number
    height: number
  }) => void
  onTextSelection?: (selection: TextSelectionPayload) => void
  referencedBlockIds?: Set<string>
  onRemoveBlockReference?: (blockId: string) => void
  annotationTool?: PdfAnnotationTool
  annotationColor?: string
  annotations?: PdfAnnotation[]
  onAddAnnotation?: (annotation: Omit<PdfAnnotation, 'id' | 'createdAt' | 'updatedAt'>) => void
  onUpdateAnnotation?: (
    id: string,
    patch: Partial<Pick<PdfAnnotation, 'text' | 'color' | 'x' | 'y' | 'width' | 'height'>>,
  ) => void
  onRemoveAnnotation?: (id: string) => void
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
  fallbackImageUrl,
  pageNumber,
  displayScale,
  expectedWidth,
  expectedHeight,
  structuredBlocks = [],
  onRendered,
  onVisualReady,
  isCaptureMode,
  onCaptureSelection,
  onTextSelection,
  referencedBlockIds = new Set<string>(),
  onRemoveBlockReference,
  annotationTool = 'pointer',
  annotationColor = '#ffd43b',
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
  interactive = true,
}: {
  pdfController: PdfController
  fallbackImageUrl?: string | null
  pageNumber: number
  displayScale: number
  expectedWidth?: number
  expectedHeight?: number
  structuredBlocks?: StructuredDocumentBlock[]
  onRendered: (page: RenderedPageData) => void
  onVisualReady: (pageNumber: number) => void
  isCaptureMode: boolean
  onCaptureSelection?: (capture: {
    pageNumber: number
    dataUrl: string
    width: number
    height: number
  }) => void
  onTextSelection?: (selection: TextSelectionPayload) => void
  referencedBlockIds?: Set<string>
  onRemoveBlockReference?: (blockId: string) => void
  annotationTool?: PdfAnnotationTool
  annotationColor?: string
  annotations?: PdfAnnotation[]
  onAddAnnotation?: (annotation: Omit<PdfAnnotation, 'id' | 'createdAt' | 'updatedAt'>) => void
  onUpdateAnnotation?: (
    id: string,
    patch: Partial<Pick<PdfAnnotation, 'text' | 'color' | 'x' | 'y' | 'width' | 'height'>>,
  ) => void
  onRemoveAnnotation?: (id: string) => void
  interactive?: boolean
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rasterRef = useRef<HTMLImageElement | null>(null)
  const enhancementTimerRef = useRef<number | null>(null)
  const onRenderedRef = useRef(onRendered)
  const onVisualReadyRef = useRef(onVisualReady)
  onVisualReadyRef.current = onVisualReady
  const [visualReady, setVisualReady] = useState(false)
  const [rasterReady, setRasterReady] = useState(false)
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
  const annotationDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
  } | null>(null)
  const annotationMoveRef = useRef<{
    pointerId: number
    annotationId: string
    startX: number
    startY: number
    originX: number
    originY: number
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
  const [annotationRect, setAnnotationRect] = useState<ReferenceSelectionRect | null>(null)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [textDraft, setTextDraft] = useState<{
    annotationId?: string
    x: number
    y: number
    width: number
    height: number
    value: string
  } | null>(null)

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
    setSelectedAnnotationId(null)
    setTextDraft(null)
    annotationMoveRef.current = null
  }, [annotationTool, pageNumber])

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

    setPageData(null)
    setRenderError(null)
    setVisualReady(false)
    setRasterReady(false)

    const renderPage = async () => {
      const canvas = canvasRef.current
      if (!canvas) {
        return
      }

      pdfMark('render-start', pageNumber)
      pdfDiagnostic('page render start', {
        controllerId: getPdfControllerId(pdfController),
        pageNumber,
      })
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

      const paintedPageData = {
        pageNumber,
        width: viewport.width,
        height: viewport.height,
        textLayer: [],
      } satisfies RenderedPageData
      setPageData(paintedPageData)
      onRenderedRef.current(paintedPageData)

      renderTask = page.render({ canvas, viewport })
      await renderTask.promise

      if (cancelled) {
        return
      }

      pdfMark('render-complete', pageNumber)
      pdfDiagnostic('page render complete', {
        controllerId: getPdfControllerId(pdfController),
        pageNumber,
      })
      // Cross a paint boundary before releasing raster and neighbor work.
      await new Promise<void>(resolve => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())))
      if (cancelled) return
      setVisualReady(true)
      pdfMark('visual-ready', pageNumber)
      pdfDiagnostic('visual ready', {
        controllerId: getPdfControllerId(pdfController),
        pageNumber,
      })
      onVisualReadyRef.current(pageNumber)
      // Text is optional interaction data, never the visual-ready signal.
      const textContent = interactive
          ? await page.getTextContent({
            includeMarkedContent: true,
            disableNormalization: true,
          }).catch(() => null)
        : null

      if (cancelled) {
        return
      }

      if (!textContent) {
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
      if (import.meta.env.DEV && !(error instanceof Error && error.name === 'RenderingCancelledException')) {
        console.error('[PDF render failed]', { pageNumber, error })
      }
    })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [interactive, pageNumber, pdfController])

  useEffect(() => {
    setRasterReady(false)
    return () => {
      if (enhancementTimerRef.current !== null) window.clearTimeout(enhancementTimerRef.current)
    }
  }, [fallbackImageUrl])

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
    if (!canvas || !pageData) {
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

    const captureSource = rasterReady && rasterRef.current?.complete ? rasterRef.current : canvas
    const scaleX = (captureSource instanceof HTMLImageElement ? captureSource.naturalWidth : canvas.width) / surface.clientWidth
    const scaleY = (captureSource instanceof HTMLImageElement ? captureSource.naturalHeight : canvas.height) / surface.clientHeight
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
        captureSource,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight,
      )

      captureSelectionRef.current?.({
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
    if (!isCaptureMode && event.button === 0 && !event.shiftKey) {
      setSelectedAnnotationId(null)
    }
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
      textSelectionRef.current?.({
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

  const beginAnnotation = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pageData || annotationTool === 'pointer' || event.button !== 0) return
    const point = resolvePointerPosition(event)
    if (!point) return

    annotationDragRef.current = {
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
    }
    setAnnotationRect({ left: point.x, top: point.y, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.stopPropagation()
    event.preventDefault()
  }

  const updateAnnotationRect = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = annotationDragRef.current
    const point = resolvePointerPosition(event)
    if (!drag || !point || drag.pointerId !== event.pointerId) return
    setAnnotationRect({
      left: Math.min(drag.startX, point.x),
      top: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX),
      height: Math.abs(point.y - drag.startY),
    })
    event.stopPropagation()
    event.preventDefault()
  }

  const finishAnnotation = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = annotationDragRef.current
    const point = resolvePointerPosition(event)
    if (!drag || !point || !pageData || drag.pointerId !== event.pointerId) return
    annotationDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const rect = {
      left: Math.min(drag.startX, point.x),
      top: Math.min(drag.startY, point.y),
      width: Math.abs(point.x - drag.startX),
      height: Math.abs(point.y - drag.startY),
    }
    setAnnotationRect(null)
    if (annotationTool === 'text') {
      if (rect.width >= 24 && rect.height >= 18) {
        setTextDraft({
          x: rect.left / pageData.width,
          y: rect.top / pageData.height,
          width: rect.width / pageData.width,
          height: rect.height / pageData.height,
          value: '',
        })
      }
    } else if (rect.width >= 5 && rect.height >= 5) {
        onAddAnnotation?.({
          pageNumber,
          type: 'highlight',
          color: annotationColor,
          x: rect.left / pageData.width,
          y: rect.top / pageData.height,
          width: rect.width / pageData.width,
          height: rect.height / pageData.height,
        })
    }
    event.stopPropagation()
    event.preventDefault()
  }

  const commitTextDraft = () => {
    if (!textDraft || !pageData) return
    const value = textDraft.value.trim()
    if (value) {
      if (textDraft.annotationId) {
        onUpdateAnnotation?.(textDraft.annotationId, {
          text: value,
          color: annotationColor,
          x: textDraft.x,
          y: textDraft.y,
          width: textDraft.width,
          height: textDraft.height,
        })
      } else {
        onAddAnnotation?.({
          pageNumber,
          type: 'text',
          color: annotationColor,
          x: textDraft.x,
          y: textDraft.y,
          width: textDraft.width,
          height: textDraft.height,
          text: value,
        })
      }
    }
    setTextDraft(null)
  }

  const beginAnnotationMove = (
    event: React.PointerEvent<HTMLDivElement>,
    annotation: PdfAnnotation,
  ) => {
    if (annotation.type !== 'text' || event.button !== 0) return
    event.stopPropagation()
    if (selectedAnnotationId !== annotation.id) {
      setSelectedAnnotationId(annotation.id)
      return
    }
    const point = resolvePointerPosition(event)
    if (!point) return
    annotationMoveRef.current = {
      pointerId: event.pointerId,
      annotationId: annotation.id,
      startX: point.x / pageData!.width,
      startY: point.y / pageData!.height,
      originX: annotation.x,
      originY: annotation.y,
      width: annotation.width,
      height: annotation.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const moveAnnotation = (event: React.PointerEvent<HTMLDivElement>) => {
    const move = annotationMoveRef.current
    const point = resolvePointerPosition(event)
    if (!move || !point || !pageData || move.pointerId !== event.pointerId) return
    const nextX = Math.min(Math.max(move.originX + point.x / pageData.width - move.startX, 0), 1 - move.width)
    const nextY = Math.min(Math.max(move.originY + point.y / pageData.height - move.startY, 0), 1 - move.height)
    onUpdateAnnotation?.(move.annotationId, { x: nextX, y: nextY })
    event.stopPropagation()
    event.preventDefault()
  }

  const finishAnnotationMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const move = annotationMoveRef.current
    if (!move || move.pointerId !== event.pointerId) return
    annotationMoveRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.stopPropagation()
    event.preventDefault()
  }

  return (
    <div
      ref={surfaceRef}
      className="pdf-stage__page-surface"
      data-visual-ready={visualReady ? 'true' : 'false'}
      onPointerDown={interactive ? beginTextSelection : undefined}
      onPointerMove={interactive ? (event) => {
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
      } : undefined}
      onPointerUp={interactive ? finishTextSelection : undefined}
      onPointerLeave={interactive ? () => {
        if (!referenceDragRef.current) setHoveredBlockId(null)
      } : undefined}
      onPointerCancel={interactive ? () => {
        referenceDragRef.current = null
        setReferenceSelectionRect(null)
        setHoveredBlockId(null)
      } : undefined}
      style={
        pageData
          ? {
              width: `${pageData.width * displayScale}px`,
              height: `${pageData.height * displayScale}px`,
            }
          : expectedWidth && expectedHeight
            ? {
                width: `${expectedWidth}px`,
                height: `${expectedHeight}px`,
              }
            : undefined
      }
    >
      {fallbackImageUrl && (visualReady || renderError) ? (
        <img
          ref={rasterRef}
          className="pdf-stage__page-raster"
          style={{ opacity: rasterReady ? 1 : 0 }}
          src={fallbackImageUrl}
          alt={`第 ${pageNumber} 页`}
          onLoad={(event) => {
            pdfMark('raster-loaded', pageNumber)
            const canvas = canvasRef.current
            const context = canvas?.getContext('2d', { alpha: false })
            const image = event.currentTarget
            const delay = visualReady ? 110 : 0
            enhancementTimerRef.current = window.setTimeout(() => {
              if (canvas && context && rasterRef.current === image) {
                context.drawImage(image, 0, 0, canvas.width, canvas.height)
              }
              setRasterReady(true)
              if (!visualReady) {
                setVisualReady(true)
                onVisualReadyRef.current(pageNumber)
              }
            }, delay)
          }}
        />
      ) : null}
      <canvas
        ref={canvasRef}
        className="pdf-stage__page-canvas"
        data-visual-ready={pageData && visualReady ? 'true' : 'false'}
        aria-hidden={!pageData || !visualReady}
        style={{
          ...(pageData
            ? {
                width: `${pageData.width}px`,
                height: `${pageData.height}px`,
                transform: `scale(${displayScale})`,
                transformOrigin: 'top left',
              }
            : {}),
          visibility: pageData && visualReady ? 'visible' : 'hidden',
        }}
      />
      {interactive && pageData && !hasLocalMineruBlocks ? (
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
      {interactive && pageData && hoveredBlock ? (
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
      {interactive && pageData && referenceSelectionRect ? (
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
      {interactive && pageData && textBlocks.length ? (
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
      {interactive && pageData && annotations.length ? (
        <div
          className="pdf-stage__annotation-layer"
          style={{
            width: `${pageData.width}px`,
            height: `${pageData.height}px`,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
        >
          {annotations.map((annotation) => (
            <div
              key={annotation.id}
              className={`pdf-stage__annotation pdf-stage__annotation--${annotation.type}${selectedAnnotationId === annotation.id ? ' is-selected' : ''}`}
              style={{
                '--annotation-color': annotation.color,
                left: `${annotation.x * pageData.width}px`,
                top: `${annotation.y * pageData.height}px`,
                width: `${annotation.width * pageData.width}px`,
                height: `${annotation.height * pageData.height}px`,
              } as React.CSSProperties}
              onPointerDown={(event) => beginAnnotationMove(event, annotation)}
              onPointerMove={moveAnnotation}
              onPointerUp={finishAnnotationMove}
              onPointerCancel={finishAnnotationMove}
              onDoubleClick={(event) => {
                if (annotation.type !== 'text') return
                event.stopPropagation()
                setSelectedAnnotationId(annotation.id)
                setTextDraft({
                  annotationId: annotation.id,
                  x: annotation.x,
                  y: annotation.y,
                  width: annotation.width,
                  height: annotation.height,
                  value: annotation.text || '',
                })
              }}
            >
              {annotation.type === 'text' ? <span>{annotation.text}</span> : null}
              <button
                type="button"
                aria-label={annotation.type === 'text' ? '删除文本批注' : '删除高亮'}
                title="删除批注"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedAnnotationId(null)
                  onRemoveAnnotation?.(annotation.id)
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 5 6 6M11 5l-6 6" /></svg>
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {interactive && pageData && annotationTool !== 'pointer' ? (
        <div
          className={`pdf-stage__annotation-input pdf-stage__annotation-input--${annotationTool}`}
          style={{
            width: `${pageData.width}px`,
            height: `${pageData.height}px`,
            transform: `scale(${displayScale})`,
            transformOrigin: 'top left',
          }}
          onPointerDown={beginAnnotation}
          onPointerMove={updateAnnotationRect}
          onPointerUp={finishAnnotation}
          onPointerCancel={() => {
            annotationDragRef.current = null
            setAnnotationRect(null)
          }}
        >
          {annotationRect ? (
            <div
              className={`pdf-stage__annotation-draft pdf-stage__annotation-draft--${annotationTool}`}
              style={{
                '--annotation-color': annotationColor,
                left: `${annotationRect.left}px`,
                top: `${annotationRect.top}px`,
                width: `${annotationRect.width}px`,
                height: `${annotationRect.height}px`,
              } as React.CSSProperties}
            />
          ) : null}
        </div>
      ) : null}
      {interactive && pageData && textDraft ? (
        <textarea
          autoFocus
          className="pdf-stage__annotation-text-editor"
          value={textDraft.value}
          placeholder="输入课堂批注…"
          aria-label="课堂文本批注"
          style={{
            '--annotation-color': annotationColor,
            left: `${textDraft.x * pageData.width * displayScale}px`,
            top: `${textDraft.y * pageData.height * displayScale}px`,
            width: `${textDraft.width * pageData.width * displayScale}px`,
            minHeight: `${textDraft.height * pageData.height * displayScale}px`,
          } as React.CSSProperties}
          onChange={(event) => setTextDraft((current) => current ? { ...current, value: event.target.value } : null)}
          onBlur={commitTextDraft}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setTextDraft(null)
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              commitTextDraft()
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : null}
      {interactive && isCaptureMode && pageData ? (
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
  onTextSelection?: (selection: TextSelectionPayload) => void
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
      onTextSelection?.({
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
  variant = 'workspace',
  fileName,
  pdfController,
  onVisualReady,
  pageImageUrl,
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
  isCaptureMode = false,
  selectedHomeworkQuestion = null,
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
  annotationTool = 'pointer',
  annotationColor = '#ffd43b',
  annotations = [],
  onAddAnnotation,
  onUpdateAnnotation,
  onRemoveAnnotation,
}: PdfPreviewCanvasProps) {
  const isReadonly = variant === 'readonly'
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef(new Map<number, HTMLElement>())
  const renderedPagesRef = useRef(new Map<number, RenderedPageData>())
  const isAutoScrollingRef = useRef(false)
  const autoScrollReleaseTimerRef = useRef<number | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const resizeRafRef = useRef<number | null>(null)
  const latestViewportWidthRef = useRef(0)
  const committedViewportWidthRef = useRef(0)
  const pendingNavigationRef = useRef<PendingPageNavigation | null>(null)
  const pendingViewportAnchorRef = useRef<ViewportAnchor | null>(null)
  const pendingQuestionAnchorRef = useRef<string | null>(null)
  const pageChangeFromUserScrollRef = useRef<number | null>(null)
  const questionChangeFromUserScrollRef = useRef<string | null>(null)
  const reportedVisiblePageRef = useRef(currentPage)
  const currentPageRef = useRef(currentPage)
  currentPageRef.current = currentPage
  const previousSelectedQuestionIdRef = useRef<string | null>(null)
  const visibleQuestionIdRef = useRef<string | null>(null)
  const previousPdfControllerRef = useRef<PdfController | null>(null)
  const questionAnchorTimerRef = useRef<number | null>(null)
  const pageSizePrefetchTimerRef = useRef<number | null>(null)
  const prefetchedGeometryPagesRef = useRef(new Set<number>())
  const [viewportWidth, setViewportWidth] = useState(0)
  const [geometryVersion, setGeometryVersion] = useState(0)
  const [visualPages, setVisualPages] = useState<{ controller: PdfController | null; pages: Set<number> }>({ controller: null, pages: new Set() })
  const isPageVisualReady = (number: number) =>
    visualPages.controller === pdfController && visualPages.pages.has(number)
  const handlePageVisualReady = (number: number) => {
    setVisualPages(previous => ({
      controller: pdfController,
      pages: new Set([...(previous.controller === pdfController ? previous.pages : []), number]),
    }))
    if (number === currentPage || number === currentPage + 1) {
      pdfMark('prefetch-release', number)
    }
    if (number === currentPage) {
      onVisualReady?.(number)
    }
  }
  const [renderError, setRenderError] = useState<string | null>(null)
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
      pendingNavigationRef.current = null
      pendingQuestionAnchorRef.current = null
      pendingViewportAnchorRef.current = null
      previousSelectedQuestionIdRef.current = null
      visibleQuestionIdRef.current = null
      reportedVisiblePageRef.current = currentPageRef.current
      prefetchedGeometryPagesRef.current.clear()
      renderedPagesRef.current.clear()
      setVisualPages({ controller: pdfController, pages: new Set() })
    }
    setRenderError(null)
  }, [imageUrl, pdfController])

  useEffect(() => {
    if (!pdfController) return
    pdfDiagnostic('controller activate', {
      controllerId: getPdfControllerId(pdfController),
      currentPage: currentPageRef.current,
    })
  }, [pdfController])

  useEffect(() => () => {
    if (questionAnchorTimerRef.current !== null) {
      window.clearTimeout(questionAnchorTimerRef.current)
    }
    if (autoScrollReleaseTimerRef.current !== null) {
      window.clearTimeout(autoScrollReleaseTimerRef.current)
    }
    if (scrollRafRef.current !== null) {
      window.cancelAnimationFrame(scrollRafRef.current)
    }
    if (resizeRafRef.current !== null) {
      window.cancelAnimationFrame(resizeRafRef.current)
    }
  }, [])

  const captureViewportAnchor = () => {
    const container = viewportRef.current
    if (!container || !pageRefs.current.size) return null
    const containerBounds = container.getBoundingClientRect()
    const viewportCenterY = containerBounds.top + container.clientHeight / 2
    let nearest: { pageNumber: number; bounds: DOMRect; distance: number } | null = null

    pageRefs.current.forEach((element, pageNumber) => {
      const bounds = element.getBoundingClientRect()
      const distance = Math.abs(bounds.top + bounds.height / 2 - viewportCenterY)
      if (!nearest || distance < nearest.distance) {
        nearest = { pageNumber, bounds, distance }
      }
    })
    if (!nearest) return null
    const anchor = nearest as { pageNumber: number; bounds: DOMRect; distance: number }
    return {
      pageNumber: anchor.pageNumber,
      normalizedY: Math.min(1, Math.max(0, (viewportCenterY - anchor.bounds.top) / Math.max(anchor.bounds.height, 1))),
    } satisfies ViewportAnchor
  }

  const restoreViewportAnchor = (anchor: ViewportAnchor) => {
    const container = viewportRef.current
    const page = pageRefs.current.get(anchor.pageNumber)
    if (!container || !page) return
    const containerBounds = container.getBoundingClientRect()
    const pageBounds = page.getBoundingClientRect()
    const targetTop =
      container.scrollTop +
      pageBounds.top -
      containerBounds.top +
      pageBounds.height * anchor.normalizedY -
      container.clientHeight / 2
    container.scrollTo({
      top: Math.max(0, targetTop),
      left: container.scrollLeft,
      behavior: 'auto',
    })
  }
  const captureViewportAnchorEvent = useEffectEvent(captureViewportAnchor)

  useEffect(() => {
    const prefetchedGeometryPages = prefetchedGeometryPagesRef.current
    if (
      !pdfController?.getPageSize ||
      visualPages.controller !== pdfController ||
      !visualPages.pages.has(currentPage) ||
      !pageRefs.current.has(currentPage) ||
      prefetchedGeometryPages.has(currentPage)
    ) {
      return
    }

    prefetchedGeometryPages.add(currentPage)
    let started = false
    const runPrefetch = () => {
      started = true
      pageSizePrefetchTimerRef.current = null
      void prefetchPdfPageSizes(pdfController, currentPage, PAGE_SIZE_PREFETCH_RADIUS).then((pages) => {
        if (!pages.length || previousPdfControllerRef.current !== pdfController) return
        pendingViewportAnchorRef.current = captureViewportAnchorEvent()
        setGeometryVersion((version) => version + 1)
      })
    }
    const idleWindow = window as IdleWindow
    const timer = idleWindow.requestIdleCallback
      ? idleWindow.requestIdleCallback(runPrefetch, { timeout: 600 })
      : window.setTimeout(runPrefetch, 0)
    pageSizePrefetchTimerRef.current = timer

    return () => {
      if (started) return
      if (idleWindow.cancelIdleCallback) {
        idleWindow.cancelIdleCallback(timer)
      } else {
        window.clearTimeout(timer)
      }
      pageSizePrefetchTimerRef.current = null
      prefetchedGeometryPages.delete(currentPage)
    }
  }, [currentPage, pdfController, visualPages])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }

    const commitWidth = () => {
      resizeRafRef.current = null
      const nextWidth = latestViewportWidthRef.current
      if (Math.abs(nextWidth - committedViewportWidthRef.current) < 1) return
      if (committedViewportWidthRef.current > 0) {
        pendingViewportAnchorRef.current = captureViewportAnchor()
      }
      committedViewportWidthRef.current = nextWidth
      setViewportWidth(nextWidth)
    }

    latestViewportWidthRef.current = viewport.clientWidth
    commitWidth()
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => {
      latestViewportWidthRef.current = viewport.clientWidth
      if (resizeRafRef.current === null) {
        resizeRafRef.current = window.requestAnimationFrame(commitWidth)
      }
    })
    observer.observe(viewport)

    return () => {
      observer.disconnect()
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current)
        resizeRafRef.current = null
      }
    }
  }, [])

  useLayoutEffect(() => {
    const anchor = pendingViewportAnchorRef.current
    if (!anchor) return
    pendingViewportAnchorRef.current = null
    restoreViewportAnchor(anchor)
  }, [viewportWidth])

  useLayoutEffect(() => {
    const anchor = pendingViewportAnchorRef.current
    if (!anchor) return
    pendingViewportAnchorRef.current = null
    restoreViewportAnchor(anchor)
  }, [geometryVersion, zoom])

  const runZoomCommand = (command: () => void) => {
    pendingViewportAnchorRef.current = captureViewportAnchor()
    command()
  }

  const markProgrammaticScroll = (duration: number) => {
    isAutoScrollingRef.current = true
    if (autoScrollReleaseTimerRef.current !== null) {
      window.clearTimeout(autoScrollReleaseTimerRef.current)
    }
    autoScrollReleaseTimerRef.current = window.setTimeout(() => {
      isAutoScrollingRef.current = false
      autoScrollReleaseTimerRef.current = null
    }, duration)
  }

  const consumePendingPageNavigation = () => {
    const navigation = pendingNavigationRef.current
    const container = viewportRef.current
    const activePage = navigation ? pageRefs.current.get(navigation.pageNumber) : null
    if (!navigation || !container || !activePage) return false

    pendingNavigationRef.current = null
    markProgrammaticScroll(navigation.behavior === 'smooth' ? 420 : 100)
    container.scrollTo({
      top: Math.max(0, activePage.offsetTop - 12),
      left: container.scrollLeft,
      behavior: navigation.behavior,
    })
    return true
  }
  const consumePendingPageNavigationEffect = useEffectEvent(consumePendingPageNavigation)

  const requestProgrammaticPageNavigation = (
    pageNumber: number,
    source: PendingPageNavigation['source'],
    behavior: ScrollBehavior = 'auto',
  ) => {
    pendingNavigationRef.current = { pageNumber, source, behavior }
    if (pageNumber !== currentPage) {
      requestVisiblePageChange(pageNumber)
      return
    }
    window.requestAnimationFrame(() => consumePendingPageNavigation())
  }

  useEffect(() => {
    if (!pdfController) {
      return
    }

    const questionId = selectedHomeworkQuestion?.id ?? null
    const questionPageNumber = selectedHomeworkQuestion?.pageNumber
    if (!questionId) {
      previousSelectedQuestionIdRef.current = null
      pendingQuestionAnchorRef.current = null
      return
    }
    if (previousSelectedQuestionIdRef.current === questionId) {
      return
    }
    previousSelectedQuestionIdRef.current = questionId

    if (questionChangeFromUserScrollRef.current === questionId) {
      questionChangeFromUserScrollRef.current = null
      pendingQuestionAnchorRef.current = null
      return
    }
    if (!questionPageNumber) {
      return
    }

    pendingQuestionAnchorRef.current = questionId
    requestProgrammaticPageNavigation(questionPageNumber, 'question')
  }, [pdfController, selectedHomeworkQuestion?.id, selectedHomeworkQuestion?.pageNumber])

  useLayoutEffect(() => {
    if (!pdfController) {
      return
    }

    if (pageChangeFromUserScrollRef.current === currentPage) {
      pageChangeFromUserScrollRef.current = null
      reportedVisiblePageRef.current = currentPage
      return
    }

    if (pendingNavigationRef.current?.pageNumber !== currentPage) {
      pendingNavigationRef.current = {
        pageNumber: currentPage,
        behavior: 'auto',
        source: 'external',
      }
    }
    const frame = window.requestAnimationFrame(() => {
      consumePendingPageNavigationEffect()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentPage, pdfController])

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
        left: container.scrollLeft,
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
      !selectedHomeworkQuestion?.id ||
      pendingQuestionAnchorRef.current !== selectedHomeworkQuestion.id ||
      !selectedHomeworkQuestion?.pageNumber ||
      selectedHomeworkQuestion.pageNumber !== currentPage
    ) {
      return
    }
    const pageData = renderedPagesRef.current.get(selectedHomeworkQuestion.pageNumber)
    if (!pageData) {
      return
    }
    if (scrollToQuestionAnchorEffect(selectedHomeworkQuestion, pageData)) {
      pendingQuestionAnchorRef.current = null
    }
  }, [currentPage, pdfController, selectedHomeworkQuestion, structuredBlocks])

  useEffect(() => {
    if (!pdfController) {
      return
    }

    const container = viewportRef.current
    if (!container) {
      return
    }

    const calculateVisiblePage = () => {
      scrollRafRef.current = null
      if (isAutoScrollingRef.current) {
        return
      }

      const usesWindowScroll = container.scrollHeight <= container.clientHeight + 1
      const containerBounds = usesWindowScroll
        ? { top: 0, bottom: window.innerHeight }
        : container.getBoundingClientRect()
      const viewportCenterY = (containerBounds.top + containerBounds.bottom) / 2
      let centerPage: number | null = null
      let nearestPage = reportedVisiblePageRef.current
      let nearestDistance = Number.POSITIVE_INFINITY

      pageRefs.current.forEach((element, pageNumber) => {
        const bounds = element.getBoundingClientRect()
        if (bounds.top <= viewportCenterY && bounds.bottom >= viewportCenterY) {
          centerPage = pageNumber
        }
        const distance = Math.abs(bounds.top + bounds.height / 2 - viewportCenterY)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearestPage = pageNumber
        }
      })

      const nextPage = centerPage ?? nearestPage

      if (nextPage !== reportedVisiblePageRef.current) {
        reportedVisiblePageRef.current = nextPage
        pageChangeFromUserScrollRef.current = nextPage
        requestVisiblePageChange(nextPage)
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

    const handleScroll = () => {
      if (scrollRafRef.current !== null) return
      scrollRafRef.current = window.requestAnimationFrame(calculateVisiblePage)
    }

    container.addEventListener('scroll', handleScroll, { passive: true })
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      container.removeEventListener('scroll', handleScroll)
      window.removeEventListener('scroll', handleScroll)
      if (scrollRafRef.current !== null) {
        window.cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [
    onVisibleQuestionChange,
    pdfController,
    structuredBlocks,
    visibleQuestions,
  ])

  const handlePageRendered = (page: RenderedPageData) => {
    renderedPagesRef.current.set(page.pageNumber, page)
    if (
      selectedHomeworkQuestion?.id &&
      pendingQuestionAnchorRef.current === selectedHomeworkQuestion.id &&
      selectedHomeworkQuestion.pageNumber === page.pageNumber
    ) {
      window.requestAnimationFrame(() => {
        if (scrollToQuestionAnchor(selectedHomeworkQuestion, page)) {
          pendingQuestionAnchorRef.current = null
        }
      })
    }
    setRenderError(null)
  }

  const currentPageWidth =
    getFallbackRenderedPageWidth(pdfController, currentPage) ??
    renderedPagesRef.current.get(currentPage)?.width ??
    null
  const effectiveViewportWidth = viewportRef.current?.clientWidth || viewportWidth || 0
  const fitScale =
    currentPageWidth && effectiveViewportWidth
      ? Math.min(1, Math.max(0.45, (effectiveViewportWidth - 52) / currentPageWidth))
      : 1
  const displayScale = zoom * fitScale
  return (
    <div className={`pdf-stage${isReadonly ? ' pdf-stage--readonly' : ''}`}>
      <div className="pdf-stage__toolbar">
        {!isReadonly ? <div className="pdf-stage__document">
          <span>PDF Reader</span>
          <strong>{fileName}</strong>
        </div> : null}
        <div className="pdf-stage__pager">
          <button type="button" className="toolbar-pill" aria-label="上一页" title="上一页" disabled={!canGoPrev} onClick={() => {
            pendingNavigationRef.current = {
              pageNumber: Math.max(1, currentPage - 1),
              behavior: 'auto',
              source: 'pager',
            }
            onPrevPage()
          }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          </button>
          <strong>{currentPage}{pageCount ? ` / ${pageCount}` : ''}</strong>
          <button type="button" className="toolbar-pill" aria-label="下一页" title="下一页" disabled={!canGoNext} onClick={() => {
            pendingNavigationRef.current = {
              pageNumber: Math.min(pageCount ?? currentPage, currentPage + 1),
              behavior: 'auto',
              source: 'pager',
            }
            onNextPage()
          }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
          </button>
        </div>
        <div className="pdf-stage__controls">
          {!isReadonly && onOpenPdf ? (
            <button type="button" className="toolbar-pill" onClick={onOpenPdf} title="打开其他 PDF">
              打开
            </button>
          ) : null}
          <div className="pdf-stage__control-group">
            <button type="button" className="toolbar-pill" aria-label="缩小" title="缩小" onClick={() => runZoomCommand(onZoomOut)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" /></svg>
            </button>
            <span className="pdf-stage__zoom-value" aria-label={`当前缩放 ${zoomLabel}`}>{zoomLabel}</span>
            <button type="button" className="toolbar-pill" aria-label="放大" title="放大" onClick={() => runZoomCommand(onZoomIn)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12M12 6v12" /></svg>
            </button>
            <button type="button" className="toolbar-pill" onClick={() => runZoomCommand(onFitWidth)} title="适应宽度">适应</button>
          </div>
        </div>
      </div>

      {!isReadonly && selectedHomeworkQuestion && pdfController ? (
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
                onClick={() => requestProgrammaticPageNavigation(
                  selectedHomeworkQuestion.pageNumber!,
                  'question',
                  'smooth',
                )}
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
          <div className="pdf-stage__stack">
            {pageNumbers.map((pageNumber) => {
              const pageLinks = lecturePageQuestionLinks.get(pageNumber) ?? []
              const lectureSegments = lectureSegmentsByPage.get(pageNumber) ?? []
              const expectedSurfaceSize = getExpectedPageSurfaceSize(
                pdfController,
                pageNumber,
                displayScale,
              )
              const priority = pdfPageRenderPriority(pageNumber, currentPage, pdfController.pageCount, isPageVisualReady)
              const shouldRenderPage = Math.abs(pageNumber - currentPage) <= 1
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
                  data-render-priority={priority ?? undefined}
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
                    {!isReadonly ? <div className="pdf-stage__page-actions">
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
                          onClick={() => onInspectPageQuestions?.(pageNumber)}
                          title={`查看第 ${pageNumber} 页相关题目`}
                        >
                          查看题目
                        </button>
                      ) : null}
                      {showLectureControls && hasLectureExplanation ? (
                        <button
                          type="button"
                          className="toolbar-pill toolbar-pill--knowledge-count"
                          onClick={() => onInspectPageLectureSegments?.(pageNumber)}
                          title={`查看第 ${pageNumber} 页的 ${lectureSegments.length} 段课堂讲解`}
                        >
                          查看课堂讲解 ({lectureSegments.length})
                        </button>
                      ) : null}
                      {showLectureControls && hasPlayableLecture ? (
                        <button
                          type="button"
                          className="toolbar-pill toolbar-pill--knowledge-count"
                          onClick={() => onPlayPageLectureSegments?.(pageNumber)}
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
                        onClick={() => onInspectPageDoubts?.(pageNumber)}
                      >
                        查看疑点
                      </button>
                    </div> : null}
                  </div>
                  {shouldRenderPage ? (
                    <PdfPageCanvas
                      key={`${getPdfControllerId(pdfController)}:${pageNumber}`}
                      pdfController={pdfController}
                      pageNumber={pageNumber}
                      fallbackImageUrl={pageImageUrl?.(pageNumber) ?? null}
                      displayScale={displayScale}
                      expectedWidth={expectedSurfaceSize?.width}
                      expectedHeight={expectedSurfaceSize?.height}
                      structuredBlocks={structuredBlocks}
                      onRendered={handlePageRendered}
                      onVisualReady={handlePageVisualReady}
                      isCaptureMode={isCaptureMode}
                      onCaptureSelection={onCaptureSelection}
                      onTextSelection={onTextSelection}
                      referencedBlockIds={referencedBlockIds}
                      onRemoveBlockReference={onRemoveBlockReference}
                      annotationTool={annotationTool}
                      annotationColor={annotationColor}
                      annotations={annotations.filter((annotation) => annotation.pageNumber === pageNumber)}
                      onAddAnnotation={onAddAnnotation}
                      onUpdateAnnotation={onUpdateAnnotation}
                      onRemoveAnnotation={onRemoveAnnotation}
                      interactive={!isReadonly}
                    />
                  ) : (
                    <div
                      className="pdf-stage__page-surface pdf-stage__page-surface--placeholder"
                      aria-hidden="true"
                      style={expectedSurfaceSize ? {
                        width: `${expectedSurfaceSize.width}px`,
                        height: `${expectedSurfaceSize.height}px`,
                      } : undefined}
                    />
                  )}
                </article>
              )
            })}
          </div>
        )}

        {renderError ? (
          <div className="empty-state pdf-stage__empty">PDF 渲染失败：{renderError}</div>
        ) : null}
      </div>
    </div>
  )
})

