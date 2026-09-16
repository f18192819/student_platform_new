export type PdfAnnotationTool = 'pointer' | 'highlight' | 'text'

export type PdfAnnotation = {
  id: string
  pageNumber: number
  type: 'highlight' | 'text'
  color: string
  x: number
  y: number
  width: number
  height: number
  text?: string
  createdAt: number
  updatedAt: number
}

const STORAGE_PREFIX = 'student-platform:pdf-annotations:v1:'

function storageKey(documentKey: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(documentKey)}`
}

export function loadPdfAnnotations(documentKey: string) {
  if (!documentKey) return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(documentKey)) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is PdfAnnotation => (
      typeof item?.id === 'string'
      && Number.isInteger(item?.pageNumber)
      && (item?.type === 'highlight' || item?.type === 'text')
      && typeof item?.color === 'string'
      && [item?.x, item?.y, item?.width, item?.height].every(Number.isFinite)
    ))
  } catch {
    return []
  }
}

export function savePdfAnnotations(documentKey: string, annotations: PdfAnnotation[]) {
  if (!documentKey) return
  window.localStorage.setItem(storageKey(documentKey), JSON.stringify(annotations))
}
