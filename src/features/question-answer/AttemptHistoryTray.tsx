import type { UserAnswerAttemptSummary } from '../../lib/userAnswers'

function attemptDeletionMessage(attemptNumber: number, attemptCount: number) {
  const originalAssetAction = attemptCount > 1
    ? '- 原始答案文件将保留，直到该文档的最后一条作答记录被删除'
    : '- 原始答案文件'
  return `确定删除 Attempt ${attemptNumber} 吗？\n\n将同时删除：\n${originalAssetAction}\n- 本次 MinerU/识别结果\n- 本次 AI 批改记录\n- 本次人工复核记录\n- 本次对学习状态产生的知识点证据\n\n此操作不可恢复。`
}

export function AttemptHistoryTray({
  attempts,
  selectedAttemptId,
  deletingAttemptId,
  onSelect,
  onDelete,
}: {
  attempts: UserAnswerAttemptSummary[]
  selectedAttemptId: string | null
  deletingAttemptId: string | null
  onSelect: (attemptId: string) => void
  onDelete: (attemptId: string, fallbackAttemptId: string | null) => void
}) {
  return (
    <div className="question-answer-history" aria-label="历史作答记录">
      {attempts.map((attempt, index) => {
        const active = attempt.id === selectedAttemptId || (!selectedAttemptId && index === 0)
        return (
          <article key={attempt.id} className={active ? 'is-active' : ''}>
            <button type="button" className="question-answer-history__select" onClick={() => onSelect(attempt.id)}>
              <span className="question-answer-history__marker" aria-hidden="true" />
              <strong>Attempt {attempt.attempt_number}</strong>
              <span>{attempt.score != null ? `${Math.round(attempt.score * 100)}%` : attempt.processing_status}</span>
              <small>{new Date(attempt.created_at).toLocaleString()}</small>
            </button>
            <button
              type="button"
              className="question-answer-history__delete"
              aria-label={`删除 Attempt ${attempt.attempt_number}`}
              disabled={Boolean(deletingAttemptId)}
              onClick={(event) => {
                event.stopPropagation()
                if (!window.confirm(attemptDeletionMessage(attempt.attempt_number, attempts.length))) return
                const fallback = attempts[index + 1] ?? attempts[index - 1] ?? null
                onDelete(attempt.id, fallback?.id ?? null)
              }}
            >{deletingAttemptId === attempt.id ? '…' : '×'}</button>
          </article>
        )
      })}
    </div>
  )
}

