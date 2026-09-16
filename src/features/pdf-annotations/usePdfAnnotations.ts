import { useCallback, useEffect, useState } from 'react'
import {
  loadPdfAnnotations,
  savePdfAnnotations,
  type PdfAnnotation,
  type PdfAnnotationTool,
} from './pdfAnnotationStore'

export const PDF_ANNOTATION_COLORS = ['#ffd43b', '#74c0fc', '#8ce99a', '#ffa8a8', '#d0bfff'] as const

export function usePdfAnnotations(documentKey: string) {
  const [tool, setTool] = useState<PdfAnnotationTool>('pointer')
  const [color, setColor] = useState<string>(PDF_ANNOTATION_COLORS[0])
  const [stored, setStored] = useState(() => ({
    documentKey,
    annotations: loadPdfAnnotations(documentKey),
  }))

  useEffect(() => {
    setTool('pointer')
    setStored({ documentKey, annotations: loadPdfAnnotations(documentKey) })
  }, [documentKey])

  const commit = useCallback((update: (current: PdfAnnotation[]) => PdfAnnotation[]) => {
    setStored((current) => {
      const base = current.documentKey === documentKey
        ? current.annotations
        : loadPdfAnnotations(documentKey)
      const next = update(base)
      savePdfAnnotations(documentKey, next)
      return { documentKey, annotations: next }
    })
  }, [documentKey])

  const addAnnotation = useCallback((input: Omit<PdfAnnotation, 'id' | 'createdAt' | 'updatedAt'>) => {
    const now = Date.now()
    commit((current) => [...current, {
      ...input,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    }])
  }, [commit])

  const updateAnnotation = useCallback((
    id: string,
    patch: Partial<Pick<PdfAnnotation, 'text' | 'color' | 'x' | 'y' | 'width' | 'height'>>,
  ) => {
    commit((current) => current.map((annotation) => annotation.id === id
      ? { ...annotation, ...patch, updatedAt: Date.now() }
      : annotation))
  }, [commit])

  const removeAnnotation = useCallback((id: string) => {
    commit((current) => current.filter((annotation) => annotation.id !== id))
  }, [commit])

  const clearPage = useCallback((pageNumber: number) => {
    commit((current) => current.filter((annotation) => annotation.pageNumber !== pageNumber))
  }, [commit])

  return {
    annotations: stored.documentKey === documentKey ? stored.annotations : [],
    tool,
    color,
    setTool,
    setColor,
    addAnnotation,
    updateAnnotation,
    removeAnnotation,
    clearPage,
  }
}
