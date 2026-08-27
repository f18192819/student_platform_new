const A4_SHORT_EDGE = 595.28
const A4_LONG_EDGE = 841.89
const PAGE_MARGIN = 24
const MAX_RASTER_EDGE = 4096

function ascii(value: string) {
  return new TextEncoder().encode(value)
}

function joinBytes(parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const joined = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

function pdfObject(id: number, body: Uint8Array) {
  return joinBytes([
    ascii(`${id} 0 obj\n`),
    body,
    ascii('\nendobj\n'),
  ])
}

export function buildSingleImagePdf(jpeg: Uint8Array, pixelWidth: number, pixelHeight: number) {
  const landscape = pixelWidth > pixelHeight
  const pageWidth = landscape ? A4_LONG_EDGE : A4_SHORT_EDGE
  const pageHeight = landscape ? A4_SHORT_EDGE : A4_LONG_EDGE
  const scale = Math.min(
    (pageWidth - PAGE_MARGIN * 2) / pixelWidth,
    (pageHeight - PAGE_MARGIN * 2) / pixelHeight,
  )
  const drawWidth = pixelWidth * scale
  const drawHeight = pixelHeight * scale
  const drawX = (pageWidth - drawWidth) / 2
  const drawY = (pageHeight - drawHeight) / 2
  const content = ascii(
    `q\n${drawWidth.toFixed(3)} 0 0 ${drawHeight.toFixed(3)} ${drawX.toFixed(3)} ${drawY.toFixed(3)} cm\n/Im0 Do\nQ\n`,
  )
  const objects = [
    pdfObject(1, ascii('<< /Type /Catalog /Pages 2 0 R >>')),
    pdfObject(2, ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')),
    pdfObject(3, ascii(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(3)} ${pageHeight.toFixed(3)}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    )),
    pdfObject(4, joinBytes([
      ascii(`<< /Length ${content.byteLength} >>\nstream\n`),
      content,
      ascii('endstream'),
    ])),
    pdfObject(5, joinBytes([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${pixelWidth} /Height ${pixelHeight} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.byteLength} >>\nstream\n`,
      ),
      jpeg,
      ascii('\nendstream'),
    ])),
  ]

  const header = ascii('%PDF-1.4\n%1234\n')
  const offsets: number[] = []
  let currentOffset = header.byteLength
  for (const object of objects) {
    offsets.push(currentOffset)
    currentOffset += object.byteLength
  }
  const xrefOffset = currentOffset
  const xref = ascii([
    'xref',
    '0 6',
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    '<< /Size 6 /Root 1 0 R >>',
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n'))
  return joinBytes([header, ...objects, xref])
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('图片无法读取，请确认文件没有损坏。'))
    }
    image.src = url
  })
}

function canvasJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('图片转换失败，请换一张图片后重试。')),
      'image/jpeg',
      0.94,
    )
  })
}

export async function convertImageUploadToPdf(file: File) {
  const image = await loadImage(file)
  const naturalWidth = image.naturalWidth
  const naturalHeight = image.naturalHeight
  if (!naturalWidth || !naturalHeight) {
    throw new Error('图片尺寸无效。')
  }

  const rasterScale = Math.min(1, MAX_RASTER_EDGE / Math.max(naturalWidth, naturalHeight))
  const width = Math.max(1, Math.round(naturalWidth * rasterScale))
  const height = Math.max(1, Math.round(naturalHeight * rasterScale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('当前浏览器无法处理这张图片。')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)

  const jpegBlob = await canvasJpeg(canvas)
  const jpeg = new Uint8Array(await jpegBlob.arrayBuffer())
  const pdf = buildSingleImagePdf(jpeg, width, height)
  const buffer = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer
  return new File([buffer], file.name, {
    type: 'application/pdf',
    lastModified: file.lastModified,
  })
}
