import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import {
  userAnswerAssetUrl,
  type QuestionAnswerIdentity,
  type UserAnswerQuestionResult,
  type UserQuestionAnswer,
} from '../../lib/userAnswers'
import { prepareAssessmentMarkdownMath } from '../../lib/latexMarkdown'
import { useQuestionAnswer } from './useQuestionAnswer'
import { userAnswerGradingLabel } from './questionAnswerState'

const ACCEPTED_ANSWERS = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp'

function MathContent({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
      {prepareAssessmentMarkdownMath(children)}
    </ReactMarkdown>
  )
}

function QuestionGradingResult({ result }: { result: UserAnswerQuestionResult }) {
  const { grading, understanding } = result
  return (
    <article className="question-answer-grading__question">
      <header>
        <div>
          <small>第 {result.question_index} 题</small>
          <strong>{result.title || `题目 ${result.question_index}`}</strong>
        </div>
        <span>{Math.round(grading.score * 100)}% · {userAnswerGradingLabel(grading)}</span>
      </header>
      {result.content ? <div className="question-answer-grading__prompt"><MathContent>{result.content}</MathContent></div> : null}
      {grading.needs_review ? (
        <p className="question-answer-grading__review">该题识别或批改把握较低，请结合原答案核对。</p>
      ) : null}
      <section className="question-answer-understanding">
        <h4>AI 识别结果</h4>
        <div className="question-answer-understanding__transcription">
          <MathContent>{understanding.transcription || '本题没有识别到可展示的作答内容。'}</MathContent>
        </div>
        {understanding.final_answer ? <div><strong>最终答案</strong><MathContent>{understanding.final_answer}</MathContent></div> : null}
        {understanding.steps.length ? <div><strong>解题步骤</strong><ol>{understanding.steps.map((step, index) => (
          <li key={`${index}-${step}`}><MathContent>{step}</MathContent></li>
        ))}</ol></div> : null}
        {understanding.uncertain_parts.length ? (
          <div className="question-answer-understanding__uncertain"><strong>不确定部分</strong><MathContent>{understanding.uncertain_parts.join('；')}</MathContent></div>
        ) : null}
      </section>
      {grading.summary ? <MathContent>{grading.summary}</MathContent> : null}
      {grading.errors.length ? <div><h4>错误原因</h4><ol>{grading.errors.map((error, index) => (
        <li key={`${error.type}-${index}`}><MathContent>{[error.problem, error.correction ? `建议：${error.correction}` : ''].filter(Boolean).join('；')}</MathContent></li>
      ))}</ol></div> : null}
      {grading.knowledge_points.length ? <div><h4>知识点分析</h4><ul>{grading.knowledge_points.map((point, index) => (
        <li key={`${point.name}-${index}`}><strong>{point.name}</strong><span>{point.status}</span>{point.evidence ? <MathContent>{point.evidence}</MathContent> : null}</li>
      ))}</ul></div> : null}
      {grading.correct_parts.length ? <div><h4>做对的部分</h4><ul>{grading.correct_parts.map((item, index) => <li key={`${index}-${item}`}><MathContent>{item}</MathContent></li>)}</ul></div> : null}
      {grading.improvement_suggestions.length ? <div><h4>改进建议</h4><ul>{grading.improvement_suggestions.map((item, index) => <li key={`${index}-${item}`}><MathContent>{item}</MathContent></li>)}</ul></div> : null}
      {grading.feedback ? <div className="question-answer-grading__feedback"><MathContent>{grading.feedback}</MathContent></div> : null}
    </article>
  )
}

function GradingPanel({ attempt, onRetry }: {
  attempt: UserQuestionAnswer
  onRetry: () => void
}) {
  const grading = attempt.grading
  const results = attempt.question_results?.length ? [...attempt.question_results].sort(
    (left, right) => left.question_index - right.question_index,
  ) : (
    grading && attempt.understanding ? [{
      question_id: attempt.question_id,
      question_index: 1,
      title: '',
      content: '',
      understanding: attempt.understanding,
      grading,
    }] : []
  )
  const [selectedQuestionId, setSelectedQuestionId] = useState('')

  if (['pending', 'processing', 'mineru_processing', 'reconstructing', 'grading'].includes(attempt.processing_status)) {
    const statusLabels: Record<string, string> = {
      pending: '等待处理',
      processing: '正在处理',
      mineru_processing: '正在分析手写版面',
      reconstructing: '正在重建各题答案',
      grading: '正在批改答案',
    }
    const statusText = statusLabels[attempt.processing_status] || '正在处理'
    return <div className="question-answer-grading is-processing"><i />{statusText}，请稍候…</div>
  }
  if (attempt.processing_status === 'failed') {
    return (
      <div className="question-answer-grading is-failed">
        <strong>批改失败</strong>
        <span>{attempt.grading_error || '模型服务暂时不可用，原始答案已安全保存。'}</span>
        <button type="button" onClick={onRetry}>重新批改</button>
      </div>
    )
  }
  if (!grading || !results.length) return null
  const overallScore = results.reduce((sum, result) => sum + result.grading.score, 0) / results.length
  const reviewCount = results.filter((result) => result.grading.needs_review).length
  const activeQuestionId = results.some((result) => result.question_id === selectedQuestionId)
    ? selectedQuestionId
    : results[0].question_id
  const selectedIndex = Math.max(0, results.findIndex((result) => result.question_id === activeQuestionId))
  const selectedResult = results[selectedIndex]
  return (
    <section className="question-answer-grading">
      <header>
        <div><small>整份答案批改结果 · 共 {results.length} 题</small><strong>{Math.round(overallScore * 100)}%</strong></div>
        <span>{reviewCount ? `${reviewCount} 题需要确认` : '全部题目已批改'}</span>
      </header>
      <div className="question-answer-grading__switcher" role="tablist" aria-label="切换题目批改结果">
        {results.map((result) => (
          <button
            key={result.question_id}
            type="button"
            role="tab"
            aria-selected={result.question_id === selectedResult.question_id}
            className={result.question_id === selectedResult.question_id ? 'is-active' : ''}
            onClick={() => setSelectedQuestionId(result.question_id)}
          >
            <span>第 {result.question_index} 题</span>
            <strong>{Math.round(result.grading.score * 100)}%</strong>
            <small>{result.grading.needs_review ? '需确认' : userAnswerGradingLabel(result.grading)}</small>
          </button>
        ))}
      </div>
      <QuestionGradingResult result={selectedResult} />
      {results.length > 1 ? (
        <nav className="question-answer-grading__pager" aria-label="题目批改结果翻页">
          <button
            type="button"
            disabled={selectedIndex === 0}
            onClick={() => setSelectedQuestionId(results[selectedIndex - 1].question_id)}
          >上一题</button>
          <span>{selectedIndex + 1} / {results.length}</span>
          <button
            type="button"
            disabled={selectedIndex === results.length - 1}
            onClick={() => setSelectedQuestionId(results[selectedIndex + 1].question_id)}
          >下一题</button>
        </nav>
      ) : null}
      <footer>模型 {attempt.grading_model || '未记录'} · {attempt.grading_version}</footer>
      <button type="button" className="ghost-button" onClick={onRetry}>重新批改</button>
    </section>
  )
}

export function QuestionAnswerViewer({ children, courseId, sourceDocumentId, questionId, sourceType }: {
  children: ReactNode
  courseId: string | null
  sourceDocumentId: string | null
  questionId: string | null
  sourceType: 'homework' | 'past-exam'
}) {
  const enabled = Boolean(courseId && sourceDocumentId && questionId)
  const identity: QuestionAnswerIdentity = {
    courseId: courseId ?? '', sourceDocumentId: sourceDocumentId ?? '', questionId: questionId ?? '',
  }
  const { attempts, details, isLoading, isSaving, error, loadAttempt, upload, retry, remove } = useQuestionAnswer({
    enabled, identity, sourceType,
  })
  const [activeTab, setActiveTab] = useState<'question' | 'answer'>('question')
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const identityKey = `${courseId}:${sourceDocumentId}:${questionId}`

  useEffect(() => {
    setActiveTab('question')
    setSelectedAttemptId(null)
    setPreviewImage(null)
  }, [identityKey])

  const selectedSummary = attempts.find((attempt) => attempt.id === selectedAttemptId) ?? attempts[0] ?? null
  const selected = selectedSummary ? details[selectedSummary.id] ?? null : null

  useEffect(() => {
    if (activeTab !== 'answer' || !selectedSummary) return
    const cached = details[selectedSummary.id]
    void loadAttempt(selectedSummary.id, Boolean(cached && cached.updated_at !== selectedSummary.updated_at))
    // The summary timestamp is the cache version; the hook guards stale identity responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, identityKey, selectedSummary?.id, selectedSummary?.updated_at])

  if (!enabled) return children
  const orderedAssets = [...(selected?.assets ?? [])].sort((left, right) => left.order - right.order)
  const openUpload = () => uploadInputRef.current?.click()

  return (
    <section className="question-answer-viewer">
      <div className="question-answer-viewer__tabs" role="tablist" aria-label="题目查看方式">
        <button type="button" role="tab" aria-selected={activeTab === 'question'} className={activeTab === 'question' ? 'is-active' : ''} onClick={() => setActiveTab('question')}>原题</button>
        <button type="button" role="tab" aria-selected={activeTab === 'answer'} className={activeTab === 'answer' ? 'is-active' : ''} onClick={() => setActiveTab('answer')}>我的答案{attempts.length ? ` · ${attempts.length}` : ''}</button>
      </div>

      <input ref={uploadInputRef} type="file" accept={ACCEPTED_ANSWERS} multiple hidden onChange={(event) => {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ''
        if (!files.length) return
        void upload(files).then((saved) => {
          if (saved) {
            setSelectedAttemptId(saved.id)
            setActiveTab('answer')
          }
        })
      }} />

      {activeTab === 'question' ? children : (
        <div className="question-answer-viewer__answer" role="tabpanel">
          {isLoading ? <div className="question-answer-viewer__empty">正在读取我的答案…</div> : selectedSummary && !selected ? (
            <div className="question-answer-viewer__empty">正在读取本次作答详情…</div>
          ) : selected ? (
            <>
              <div className="question-answer-viewer__actions">
                <div><strong>整份文档第 {selected.attempt_number} 次作答</strong><span>{new Date(selected.created_at).toLocaleString()} · {orderedAssets.length} 个文件</span></div>
                <div><button type="button" onClick={openUpload} disabled={isSaving}>提交整份新答案</button><button type="button" className="is-danger" disabled={isSaving} onClick={() => {
                  if (window.confirm('确定删除这份作业或往年题的全部作答历史吗？')) void remove()
                }}>删除全部记录</button></div>
              </div>
              <div className="question-answer-viewer__assets">
                {orderedAssets.map((asset) => {
                  const url = userAnswerAssetUrl(identity, asset.id, selected.id)
                  return asset.kind === 'image' ? (
                    <button key={asset.id} type="button" className="question-answer-viewer__image" onClick={() => setPreviewImage(url)}>
                      <img src={url} alt={asset.filename} /><span>{asset.order + 1}. {asset.filename}</span>
                    </button>
                  ) : (
                    <article key={asset.id} className="question-answer-viewer__pdf"><header>{asset.order + 1}. {asset.filename}</header><iframe src={url} title={asset.filename} /></article>
                  )
                })}
              </div>
              <GradingPanel attempt={selected} onRetry={() => void retry(selected.id)} />
              {attempts.length > 1 ? (
                <section className="question-answer-history"><h3>历史作答记录</h3><div>{attempts.map((attempt) => (
                  <button key={attempt.id} type="button" className={attempt.id === selected.id ? 'is-active' : ''} onClick={() => setSelectedAttemptId(attempt.id)}>
                    <strong>Attempt {attempt.attempt_number}</strong><span>{attempt.score != null ? `${Math.round(attempt.score * 100)}%` : attempt.processing_status}</span><small>{new Date(attempt.created_at).toLocaleString()}</small>
                  </button>
                ))}</div></section>
              ) : null}
            </>
          ) : (
            <div className="question-answer-viewer__empty"><strong>暂无整份答案</strong><span>上传包含这份作业或往年题全部作答的 PDF，或按顺序选择多张手写图片。AI 会自动分题并逐题批改。</span><button type="button" onClick={openUpload} disabled={isSaving}>{isSaving ? '上传中…' : '上传整份答案'}</button></div>
          )}
          {error ? <p className="question-answer-viewer__error">{error}</p> : null}
        </div>
      )}

      {previewImage ? <div className="question-answer-lightbox" role="dialog" aria-modal="true" aria-label="答案图片预览"><button type="button" aria-label="关闭大图" onClick={() => setPreviewImage(null)}>×</button><img src={previewImage} alt="我的答案大图" onClick={() => setPreviewImage(null)} /></div> : null}
    </section>
  )
}
