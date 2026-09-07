import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import {
  effectiveQuestionReview,
  effectiveQuestionScore,
  type ReviewedError,
  type UserAnswerQuestionResult,
  type UserAnswerQuestionReview,
  type UserQuestionAnswer,
} from '../../lib/userAnswers'
import { prepareAssessmentMarkdownMath } from '../../lib/latexMarkdown'
import { userAnswerGradingLabel } from './questionAnswerState'

function MathContent({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>{prepareAssessmentMarkdownMath(children)}</ReactMarkdown>
}

const ERROR_TYPES = [
  'conceptual_error', 'formula_error', 'calculation_error', 'reasoning_error',
  'missing_step', 'incomplete_answer', 'misread_question', 'unit_error',
  'notation_error', 'uncertain',
]

function resultsOf(attempt: UserQuestionAnswer): UserAnswerQuestionResult[] {
  if (attempt.question_results?.length) {
    return [...attempt.question_results].sort((left, right) => left.question_index - right.question_index)
  }
  return attempt.grading && attempt.understanding ? [{
    question_id: attempt.question_id,
    question_index: 1,
    title: '',
    content: '',
    understanding: attempt.understanding,
    grading: attempt.grading,
  }] : []
}

export function gradingSummaryOf(attempt: UserQuestionAnswer | null) {
  if (!attempt) return null
  const results = resultsOf(attempt)
  if (!attempt.grading || !results.length) return null
  const score = results.reduce((sum, result) => sum + effectiveQuestionScore(attempt, result), 0) / results.length
  const reviewCount = results.filter((result) => result.grading.needs_review && !effectiveQuestionReview(attempt, result.question_id)).length
  return { score, reviewCount, resultCount: results.length }
}

function initialReviewErrors(attempt: UserQuestionAnswer, result: UserAnswerQuestionResult): ReviewedError[] {
  const saved = effectiveQuestionReview(attempt, result.question_id)
  if (saved) return saved.errors.map((error) => ({ ...error }))
  return result.grading.errors.map((error) => ({ ...error, source: 'ai', accepted: true }))
}

function previewReviewScore(baseScore: number, errors: ReviewedError[]) {
  const restored = errors.reduce((sum, error) => sum + (error.source === 'ai' && !error.accepted ? error.deduction : 0), 0)
  const added = errors.reduce((sum, error) => sum + (error.source === 'user' && error.accepted ? error.deduction : 0), 0)
  return Math.max(0, Math.min(1, baseScore + restored - added))
}

function QuestionReviewEditor({ attempt, result, isSaving, onSave }: {
  attempt: UserQuestionAnswer
  result: UserAnswerQuestionResult
  isSaving: boolean
  onSave: (errors: ReviewedError[]) => Promise<UserAnswerQuestionReview | null>
}) {
  const gradingRevision = attempt.grading_revisions?.length ?? 0
  const effectiveReview = effectiveQuestionReview(attempt, result.question_id)
  const hasStaleReview = !effectiveReview && (attempt.manual_review_revisions ?? []).some((review) => review.question_id === result.question_id)
  const [errors, setErrors] = useState<ReviewedError[]>(() => initialReviewErrors(attempt, result))
  const [saved, setSaved] = useState(Boolean(effectiveReview))

  useEffect(() => {
    setErrors(initialReviewErrors(attempt, result))
    setSaved(Boolean(effectiveReview))
  }, [attempt, result, gradingRevision, effectiveReview])

  const update = (id: string, changes: Partial<ReviewedError>) => {
    setErrors((current) => current.map((error) => error.id === id ? { ...error, ...changes } : error))
    setSaved(false)
  }
  const remove = (error: ReviewedError) => {
    if (error.source === 'ai') update(error.id, { accepted: false })
    else {
      setErrors((current) => current.filter((item) => item.id !== error.id))
      setSaved(false)
    }
  }
  const add = () => {
    setErrors((current) => [...current, {
      id: `manual-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      source: 'user', accepted: true, type: 'calculation_error', location: '',
      student_reasoning: '', problem: '', correction: '', severity: 'medium', deduction: 0.1,
    }])
    setSaved(false)
  }
  const preview = previewReviewScore(result.grading.score, errors)
  const canSave = errors.every((error) => error.source === 'ai' || Boolean(error.type && error.problem.trim()))

  return (
    <section className="question-answer-review">
      <header><h4>人工确认</h4><p>确认、否定或补充 AI 判断，保存后用于后续针对性出题。</p></header>
      {hasStaleReview ? <p className="question-answer-review__stale">AI 批改结果已更新，需要基于当前结果重新确认。</p> : null}
      <div className="question-answer-review__errors">
        {errors.map((error) => (
          <article key={error.id} className={!error.accepted ? 'is-rejected' : ''}>
            <div className="question-answer-review__error-head">
              <label><input type="checkbox" checked={error.accepted} onChange={(event) => update(error.id, { accepted: event.target.checked })} />该错误成立</label>
              <span>扣 {Math.round(error.deduction * 100)}%</span>
              <button type="button" onClick={() => remove(error)}>删除</button>
            </div>
            {error.source === 'ai' ? <>
              <strong>{error.type}</strong>
              <MathContent>{error.problem}</MathContent>
              {error.correction ? <div className="question-answer-review__correction"><b>建议：</b><MathContent>{error.correction}</MathContent></div> : null}
            </> : <div className="question-answer-review__fields">
              <label>错误类型<select value={error.type} onChange={(event) => update(error.id, { type: event.target.value })}>{ERROR_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
              <label>严重程度<select value={error.severity} onChange={(event) => update(error.id, { severity: event.target.value as ReviewedError['severity'] })}><option value="low">轻微</option><option value="medium">中等</option><option value="high">严重</option></select></label>
              <label>扣分百分比<input type="number" min="0" max="100" step="1" value={Math.round(error.deduction * 100)} onChange={(event) => update(error.id, { deduction: Math.max(0, Math.min(1, Number(event.target.value) / 100)) })} /></label>
              <label className="is-wide">错误说明<textarea rows={2} value={error.problem} onChange={(event) => update(error.id, { problem: event.target.value })} /></label>
              <label className="is-wide">修改建议（可选）<textarea rows={2} value={error.correction} onChange={(event) => update(error.id, { correction: event.target.value })} /></label>
            </div>}
          </article>
        ))}
      </div>
      <button type="button" className="question-answer-review__add" onClick={add}>添加错误原因</button>
      <div className="question-answer-review__scores"><span>AI 原始评分<strong>{Math.round(result.grading.score * 100)}%</strong></span><span>确认后评分<strong>{Math.round(preview * 100)}%</strong></span></div>
      <button type="button" className="question-answer-review__save" disabled={isSaving || !canSave} onClick={() => void onSave(errors).then((review) => setSaved(Boolean(review)))}>{isSaving ? '保存中…' : '保存人工确认'}</button>
      {saved ? <p className="question-answer-review__saved">已保存到学习记录，将用于后续针对性出题。</p> : null}
    </section>
  )
}

function QuestionGradingResult({ attempt, result, isReviewSaving, onSaveReview }: {
  attempt: UserQuestionAnswer
  result: UserAnswerQuestionResult
  isReviewSaving: boolean
  onSaveReview: (errors: ReviewedError[]) => Promise<UserAnswerQuestionReview | null>
}) {
  const { grading, understanding } = result
  const effectiveScore = effectiveQuestionScore(attempt, result)
  const effectiveReview = effectiveQuestionReview(attempt, result.question_id)
  return (
    <article className="question-answer-grading__question">
      <header><div><small>第 {result.question_index} 题</small><strong>{result.title || `题目 ${result.question_index}`}</strong></div><span>{Math.round(effectiveScore * 100)}% · {effectiveReview ? '人工确认' : userAnswerGradingLabel(grading)}</span></header>
      {result.content ? <div className="question-answer-grading__prompt"><MathContent>{result.content}</MathContent></div> : null}
      {grading.needs_review && !effectiveReview ? <p className="question-answer-grading__review">该题识别或批改把握较低，请结合原答案核对。</p> : null}
      <section className="question-answer-understanding">
        <h4>AI 识别结果</h4>
        <div className="question-answer-understanding__transcription"><MathContent>{understanding.transcription || '本题没有识别到可展示的作答内容。'}</MathContent></div>
        {understanding.final_answer ? <div><strong>最终答案</strong><MathContent>{understanding.final_answer}</MathContent></div> : null}
        {understanding.steps.length ? <div><strong>解题步骤</strong><ol>{understanding.steps.map((step, index) => <li key={`${index}-${step}`}><MathContent>{step}</MathContent></li>)}</ol></div> : null}
        {understanding.uncertain_parts.length ? <div className="question-answer-understanding__uncertain"><strong>不确定部分</strong><MathContent>{understanding.uncertain_parts.join('；')}</MathContent></div> : null}
      </section>
      {grading.summary ? <MathContent>{grading.summary}</MathContent> : null}
      {grading.knowledge_points.length ? <div><h4>知识点分析</h4><ul>{grading.knowledge_points.map((point, index) => <li key={`${point.name}-${index}`}><strong>{point.name}</strong><span className="question-answer-grading__knowledge-status">{point.status}</span>{point.evidence ? <MathContent>{point.evidence}</MathContent> : null}</li>)}</ul></div> : null}
      {grading.correct_parts.length ? <div><h4>做对的部分</h4><ul>{grading.correct_parts.map((item, index) => <li key={`${index}-${item}`}><MathContent>{item}</MathContent></li>)}</ul></div> : null}
      {grading.improvement_suggestions.length ? <div><h4>改进建议</h4><ul>{grading.improvement_suggestions.map((item, index) => <li key={`${index}-${item}`}><MathContent>{item}</MathContent></li>)}</ul></div> : null}
      {grading.feedback ? <div className="question-answer-grading__feedback"><MathContent>{grading.feedback}</MathContent></div> : null}
      <QuestionReviewEditor attempt={attempt} result={result} isSaving={isReviewSaving} onSave={onSaveReview} />
    </article>
  )
}

export function GradingInspector({ attempt, onRetry, reviewSavingQuestionId, onSaveReview }: {
  attempt: UserQuestionAnswer
  onRetry: () => void
  reviewSavingQuestionId: string | null
  onSaveReview: (questionId: string, errors: ReviewedError[]) => Promise<UserAnswerQuestionReview | null>
}) {
  const grading = attempt.grading
  const results = resultsOf(attempt)
  const [selectedQuestionId, setSelectedQuestionId] = useState('')

  if (['pending', 'processing', 'mineru_processing', 'reconstructing', 'grading'].includes(attempt.processing_status)) {
    const labels: Record<string, string> = { pending: '等待处理', processing: '正在处理', mineru_processing: '正在分析手写版面', reconstructing: '正在重建各题答案', grading: '正在批改答案' }
    return <div className="question-answer-grading is-processing" role="status"><i />{labels[attempt.processing_status] || '正在处理'}，请稍候…</div>
  }
  if (attempt.processing_status === 'failed') return <div className="question-answer-grading is-failed"><strong>批改失败</strong><span>{attempt.grading_error || '模型服务暂时不可用，原始答案已安全保存。'}</span><button type="button" onClick={onRetry}>重新批改</button></div>
  if (!grading || !results.length) return <div className="reader-panel-empty">本次作答还没有可显示的批改结果。</div>

  const summary = gradingSummaryOf(attempt)!
  const activeQuestionId = results.some((result) => result.question_id === selectedQuestionId) ? selectedQuestionId : results[0].question_id
  const selectedIndex = Math.max(0, results.findIndex((result) => result.question_id === activeQuestionId))
  const selectedResult = results[selectedIndex]
  return (
    <section className="question-answer-grading">
      <header><div><small>整份答案 · 共 {summary.resultCount} 题</small><strong>{Math.round(summary.score * 100)}%</strong></div><span>{summary.reviewCount ? `${summary.reviewCount} 题需要确认` : '全部题目已批改'}</span></header>
      <div className="question-answer-grading__switcher" role="tablist" aria-label="切换题目批改结果">
        {results.map((result) => <button key={result.question_id} type="button" role="tab" aria-selected={result.question_id === selectedResult.question_id} className={result.question_id === selectedResult.question_id ? 'is-active' : ''} onClick={() => setSelectedQuestionId(result.question_id)}><span>第 {result.question_index} 题</span><strong>{Math.round(effectiveQuestionScore(attempt, result) * 100)}%</strong><small>{effectiveQuestionReview(attempt, result.question_id) ? '已确认' : result.grading.needs_review ? '需确认' : userAnswerGradingLabel(result.grading)}</small></button>)}
      </div>
      <QuestionGradingResult attempt={attempt} result={selectedResult} isReviewSaving={reviewSavingQuestionId === selectedResult.question_id} onSaveReview={(errors) => onSaveReview(selectedResult.question_id, errors)} />
      {results.length > 1 ? <nav className="question-answer-grading__pager" aria-label="题目批改结果翻页"><button type="button" disabled={selectedIndex === 0} onClick={() => setSelectedQuestionId(results[selectedIndex - 1].question_id)}>上一题</button><span>{selectedIndex + 1} / {results.length}</span><button type="button" disabled={selectedIndex === results.length - 1} onClick={() => setSelectedQuestionId(results[selectedIndex + 1].question_id)}>下一题</button></nav> : null}
      <footer>模型 {attempt.grading_model || '未记录'} · {attempt.grading_version}</footer>
      <button type="button" className="ghost-button" onClick={onRetry}>重新批改</button>
    </section>
  )
}

