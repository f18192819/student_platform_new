import type { PdfOutlineBlock } from '../../types'

type TextItemLike = {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  fontName?: string
}

type TextNode = {
  text: string
  x: number
  y: number
  width: number
  height: number
  fontSize: number
  fontName: string
}

type TextLine = {
  text: string
  nodes: TextNode[]
  y: number
  left: number
  right: number
  avgFontSize: number
  gapCount: number
}

export type PageExtraction = {
  pageWidth: number
  pageHeight: number
  markdownLines: string[]
  outlineBlocks: PdfOutlineBlock[]
  headingCandidates: string[]
  plainText: string
}

const BULLET_PATTERN =
  /^([•◦▪▫■□◆◇●○]|[-—–]|(?:\d+|[A-Za-z]|[一二三四五六七八九十]+)[.)、])\s*/

const HEADING_PATTERN =
  /^(第[一二三四五六七八九十百千万0-9]+[章节部分篇讲]|[一二三四五六七八九十]+[、.]|\d+(\.\d+){0,3}\s+)/

function normalizeInlineText(text: string) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/([，。！？；：“”‘’（）《》【】])\s+/g, '$1')
    .replace(/\s+([，。！？；：“”‘’）》】])/g, '$1')
    .trim()
}

function isTextItem(item: unknown): item is TextItemLike {
  return typeof item === 'object' && item !== null && 'str' in item
}

function isMostlySymbolLine(text: string) {
  const compact = text.replace(/\s+/g, '')
  if (!compact) {
    return false
  }

  const symbolCount = compact
    .split('')
    .filter((character) => /[=+\-*/^≥≤≠≈()[\]{}<>]/.test(character)).length

  return symbolCount / compact.length >= 0.3
}

function isLikelyBullet(text: string) {
  return BULLET_PATTERN.test(text)
}

function stripBulletPrefix(text: string) {
  return text.replace(BULLET_PATTERN, '').trim()
}

function isLikelyHeading(
  text: string,
  fontSize: number,
  medianFontSize: number,
  pageWidth: number,
  line: TextLine,
) {
  const normalized = text.trim()
  if (!normalized || normalized.length > 48) {
    return false
  }

  const isCentered = Math.abs((line.left + line.right) / 2 - pageWidth / 2) < pageWidth * 0.13
  const looksLikeHeadingText = HEADING_PATTERN.test(normalized)
  const hasLargeFont = fontSize >= medianFontSize * 1.16
  const isBoldFace = /bold|black|heavy|medium|demi/i.test(line.nodes[0]?.fontName ?? '')
  const endsLikeParagraph = /[。！？；.!?]$/.test(normalized)
  const symbolHeavy = isMostlySymbolLine(normalized)

  if (symbolHeavy || endsLikeParagraph) {
    return false
  }

  return looksLikeHeadingText || hasLargeFont || (isCentered && (hasLargeFont || isBoldFace))
}

function extractFontSize(transform: number[] | undefined, fallbackHeight: number | undefined) {
  if (!transform || transform.length < 6) {
    return Math.max(10, fallbackHeight ?? 10)
  }

  const [, b, c, d] = transform
  const scaleY = Math.sqrt(b * b + d * d)
  const scaleX = Math.sqrt(transform[0] * transform[0] + c * c)

  return Math.max(scaleX, scaleY, fallbackHeight ?? 10, 10)
}

function median(values: number[]) {
  if (!values.length) {
    return 12
  }

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function buildTextNodes(items: unknown[]) {
  return items
    .filter(isTextItem)
    .map((item) => {
      const text = normalizeInlineText(item.str ?? '')
      if (!text) {
        return null
      }

      const transform = item.transform ?? [1, 0, 0, 1, 0, 0]
      const x = transform[4] ?? 0
      const y = transform[5] ?? 0
      const width = item.width ?? 0
      const height = item.height ?? 0
      const fontSize = extractFontSize(transform, height)

      return {
        text,
        x,
        y,
        width,
        height,
        fontSize,
        fontName: item.fontName ?? '',
      } satisfies TextNode
    })
    .filter((node): node is TextNode => node !== null)
}

function buildLineText(nodes: TextNode[]) {
  const sorted = [...nodes].sort((left, right) => {
    if (Math.abs(left.x - right.x) < 1.2) {
      return right.y - left.y
    }
    return left.x - right.x
  })

  let text = ''
  let previousRight = 0
  let gapCount = 0

  sorted.forEach((node, index) => {
    if (!node.text) {
      return
    }

    if (index === 0) {
      text = node.text
      previousRight = node.x + node.width
      return
    }

    const gap = Math.max(0, node.x - previousRight)
    const shouldInsertSpace =
      gap > Math.max(node.fontSize * 0.28, 3.2) &&
      !/^[，。！？；：）》】]/.test(node.text) &&
      !/[（《【]$/.test(text)

    if (gap > node.fontSize * 1.6) {
      gapCount += 1
    }

    text += shouldInsertSpace ? ` ${node.text}` : node.text
    previousRight = Math.max(previousRight, node.x + node.width)
  })

  return {
    text: normalizeInlineText(text),
    gapCount,
  }
}

function buildLines(nodes: TextNode[]) {
  const sorted = [...nodes].sort((left, right) => {
    if (Math.abs(left.y - right.y) > 1.2) {
      return right.y - left.y
    }
    return left.x - right.x
  })

  const lines: TextNode[][] = []

  sorted.forEach((node) => {
    const existingLine = lines.find(
      (line) => Math.abs(line[0].y - node.y) <= Math.max(2.6, Math.min(node.fontSize * 0.42, 5.5)),
    )

    if (existingLine) {
      existingLine.push(node)
      return
    }

    lines.push([node])
  })

  return lines
    .map((lineNodes) => {
      const nodesInLine = [...lineNodes].sort((left, right) => left.x - right.x)
      const { text, gapCount } = buildLineText(nodesInLine)
      const avgFontSize =
        nodesInLine.reduce((sum, node) => sum + node.fontSize, 0) / Math.max(nodesInLine.length, 1)

      return {
        text,
        nodes: nodesInLine,
        y: nodesInLine[0]?.y ?? 0,
        left: Math.min(...nodesInLine.map((node) => node.x)),
        right: Math.max(...nodesInLine.map((node) => node.x + node.width)),
        avgFontSize,
        gapCount,
      } satisfies TextLine
    })
    .filter((line) => line.text.length > 0)
    .sort((left, right) => right.y - left.y)
}

function mergeParagraphLines(lines: string[]) {
  return lines.reduce((paragraph, line) => {
    if (!paragraph) {
      return line
    }

    const joinWithoutSpace =
      /[一-龥，。！？；：）》】]$/.test(paragraph) || /^[一-龥（《【]/.test(line)

    return joinWithoutSpace ? `${paragraph}${line}` : `${paragraph} ${line}`
  }, '')
}

function paragraphLooksComplete(text: string) {
  return /[。！？；.!?]$/.test(text) || isMostlySymbolLine(text)
}

function buildOutlineBody(paragraph: string) {
  return paragraph
    .split(/(?<=[。！？.!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' ')
}

export function extractPageMarkdown(
  pageNumber: number,
  pageWidth: number,
  pageHeight: number,
  items: unknown[],
  pageCount: number,
): PageExtraction {
  const nodes = buildTextNodes(items)
  const lines = buildLines(nodes)
  const fontSizes = lines.map((line) => line.avgFontSize)
  const medianFontSize = median(fontSizes)
  const markdownLines: string[] = [`## 第 ${pageNumber} 页`]
  const outlineBlocks: PdfOutlineBlock[] = []
  const headingCandidates: string[] = []
  const paragraphBuffer: string[] = []
  const listBuffer: string[] = []
  let lastMeaningfulLine: TextLine | null = null
  let lastHeading = `第 ${pageNumber} 页`

  const flushParagraph = () => {
    if (!paragraphBuffer.length) {
      return
    }

    const paragraph = mergeParagraphLines(paragraphBuffer)
    markdownLines.push(paragraph)

    if (outlineBlocks.length < Math.max(4, Math.ceil(pageCount / 4))) {
      outlineBlocks.push({
        id: `p${pageNumber}-summary-${outlineBlocks.length + 1}`,
        title: lastHeading,
        body: buildOutlineBody(paragraph),
        page: pageNumber,
      })
    }

    paragraphBuffer.length = 0
  }

  const flushList = () => {
    if (!listBuffer.length) {
      return
    }

    markdownLines.push(...listBuffer.map((item) => `- ${item}`))
    listBuffer.length = 0
  }

  lines.forEach((line, lineIndex) => {
    const text = line.text.trim()
    if (!text) {
      return
    }

    const heading = isLikelyHeading(text, line.avgFontSize, medianFontSize, pageWidth, line)
    const bullet = isLikelyBullet(text)
    const verticalGap =
      lastMeaningfulLine === null ? 0 : Math.max(0, lastMeaningfulLine.y - line.y)
    const shouldBreakParagraph =
      verticalGap > Math.max(line.avgFontSize * 1.55, 14) ||
      (lastMeaningfulLine !== null && paragraphLooksComplete(lastMeaningfulLine.text)) ||
      line.gapCount >= 3

    if (heading) {
      flushParagraph()
      flushList()

      const level = line.avgFontSize >= medianFontSize * 1.42 && lineIndex === 0 ? '###' : '####'
      markdownLines.push(`${level} ${text}`)
      headingCandidates.push(text)
      lastHeading = text
      outlineBlocks.push({
        id: `p${pageNumber}-heading-${outlineBlocks.length + 1}`,
        title: text,
        body: `本节位于第 ${pageNumber} 页。`,
        page: pageNumber,
      })
      lastMeaningfulLine = line
      return
    }

    if (bullet) {
      flushParagraph()
      listBuffer.push(stripBulletPrefix(text))
      lastMeaningfulLine = line
      return
    }

    if (shouldBreakParagraph) {
      flushParagraph()
      flushList()
    }

    paragraphBuffer.push(text)
    lastMeaningfulLine = line
  })

  flushParagraph()
  flushList()

  return {
    pageWidth,
    pageHeight,
    markdownLines,
    outlineBlocks,
    headingCandidates,
    plainText: lines.map((line) => line.text.trim()).filter(Boolean).join(' '),
  }
}
