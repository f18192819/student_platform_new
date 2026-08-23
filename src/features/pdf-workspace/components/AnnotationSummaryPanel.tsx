import type { StoredDoubtAnnotation } from '../../../types'
import type { DraftDoubt } from '../types'

export function AnnotationSummaryPanel({
  annotations,
  pageFilter,
  selectedAnnotationId,
  scopeLabel,
  currentPage,
  draftDoubt,
  onBackToDocument,
  onCreateDraft,
  onSelectAnnotation,
}: {
  annotations: StoredDoubtAnnotation[]
  pageFilter: number | null
  selectedAnnotationId: string | null
  scopeLabel: string
  currentPage: number
  draftDoubt: DraftDoubt | null
  onBackToDocument: () => void
  onCreateDraft: () => void
  onSelectAnnotation: (annotationId: string) => void
}) {
  const canCreateDraft = pageFilter !== null || scopeLabel !== '课堂讲解'

  return (
    <section className="pdf-text-dock">
      <div className="pdf-text-dock__head">
        <div>
          <span>Doubt Library</span>
          <strong>{pageFilter === null ? scopeLabel : `第 ${pageFilter} 页疑点`}</strong>
        </div>
        <div className="doubt-summary__actions">
          {canCreateDraft ? (
            <button
              type="button"
              className="ghost-button doubt-summary__new-button"
              onClick={onCreateDraft}
            >
              {draftDoubt
                ? `第 ${draftDoubt.pageNumber ?? currentPage} 页对话中`
                : `第 ${pageFilter ?? currentPage} 页新对话`}
            </button>
          ) : null}
          {pageFilter === null ? (
            <span>{annotations.length} 条</span>
          ) : (
            <button type="button" className="ghost-button doubt-back-button" onClick={onBackToDocument}>
              返回
            </button>
          )}
        </div>
      </div>
      <div className="pdf-text-dock__body">
        {annotations.length ? (
          <div className="doubt-history">
            {annotations.map((annotation, index) => (
              <button
                key={annotation.id}
                type="button"
                className={`doubt-history__item${selectedAnnotationId === annotation.id ? ' is-active' : ''}`}
                onClick={() => onSelectAnnotation(annotation.id)}
              >
                <strong>
                  疑点 {index + 1} · 第 {annotation.pageNumber ?? '?'} 页
                </strong>
                <p>{annotation.question}</p>
                {annotation.imageName ? <span>附图：{annotation.imageName}</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state">还没有保存的疑点，先在 PDF 页旁边新建一条试试。</div>
        )}
      </div>
    </section>
  )
}
