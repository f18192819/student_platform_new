import type { RelatedMaterialCard } from '../types'

export function RelatedMaterialsPanel({
  mode,
  currentPage,
  currentQuestionTitle,
  cards,
  isLoading,
  onOpenCard,
}: {
  mode: 'lecture' | 'question'
  currentPage: number
  currentQuestionTitle: string | null
  cards: RelatedMaterialCard[]
  isLoading: boolean
  onOpenCard: (card: RelatedMaterialCard) => void
}) {
  const contextLabel =
    mode === 'lecture'
      ? `讲义第 ${currentPage} 页`
      : currentQuestionTitle || `习题第 ${currentPage} 页`

  return (
    <section className="pdf-text-dock related-materials-panel">
      <div className="pdf-text-dock__head">
        <div>
          <span>Related</span>
          <strong>相关知识点与习题</strong>
        </div>
        <span className="related-materials-panel__context" title={contextLabel}>
          {contextLabel}
        </span>
      </div>
      <div className="pdf-text-dock__body related-materials-panel__body">
        {isLoading ? (
          <div className="empty-state">正在加载当前内容的关联资料...</div>
        ) : cards.length ? (
          <div className="related-materials-panel__list">
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="related-material-card"
                onClick={() => onOpenCard(card)}
              >
                <div className="related-material-card__meta">
                  <span>{card.kind === 'lecture' ? '讲义知识点' : '关联习题'}</span>
                  {card.pageNumber ? <span>第 {card.pageNumber} 页</span> : null}
                </div>
                <strong>{card.title || card.documentName}</strong>
                <p>{card.content || card.chapter || card.documentName}</p>
                <div className="related-material-card__footer">
                  <span>{card.documentName}</span>
                  {card.confidence !== null ? (
                    <span>相关度 {Math.round(card.confidence * 100)}%</span>
                  ) : null}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            {mode === 'lecture'
              ? '当前讲义页还没有关联习题。完成题目关联后会在这里显示。'
              : '当前题目还没有关联讲义或习题。完成题目关联后会在这里显示。'}
          </div>
        )}
      </div>
    </section>
  )
}
