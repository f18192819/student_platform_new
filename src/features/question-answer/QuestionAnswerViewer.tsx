import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  userAnswerAssetUrl,
  type QuestionAnswerIdentity,
  type UserQuestionAnswer,
} from '../../lib/userAnswers'
import { useQuestionAnswer } from './useQuestionAnswer'

const ACCEPTED_ANSWERS = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp'

function GradingPanel({ attempt, onRetry }: {
  attempt: UserQuestionAnswer
  onRetry: () => void
}) {
  if (attempt.processing_status === 'pending' || attempt.processing_status === 'processing') {
    return <div className="question-answer-grading is-processing"><i />正在批改，请稍候…</div>
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
  const grading = attempt.grading
  if (!grading) return null
  return (
    <section className="question-answer-grading">
      <header>
        <div><small>批改结果</small><strong>{Math.round(grading.score * 100)}%</strong></div>
        <span>{grading.correct ? '基本正确' : grading.needs_review ? '需要人工确认' : '仍需改进'}</span>
      </header>
      {grading.needs_review ? (
        <p className="question-answer-grading__review">AI 对该答案的判断把握较低，请结合原答案核对，不将其视为确定结论。</p>
      ) : null}
      {grading.summary ? <p>{grading.summary}</p> : null}
      {grading.errors.length ? (
        <div><h4>错误原因</h4><ol>{grading.errors.map((error, index) => (
          <li key={`${error.type}-${index}`}><strong>{error.problem}</strong>{error.correction ? `；建议：${error.correction}` : ''}</li>
        ))}</ol></div>
      ) : null}
      {grading.knowledge_points.length ? (
        <div><h4>知识点分析</h4><ul>{grading.knowledge_points.map((point) => (
          <li key={point.name}><strong>{point.name}</strong><span>{point.status}</span>{point.evidence ? `：${point.evidence}` : ''}</li>
        ))}</ul></div>
      ) : null}
      {grading.correct_parts.length ? (
        <div><h4>做对的部分</h4><ul>{grading.correct_parts.map((item) => <li key={item}>{item}</li>)}</ul></div>
      ) : null}
      {grading.improvement_suggestions.length ? (
        <div><h4>改进建议</h4><ul>{grading.improvement_suggestions.map((item) => <li key={item}>{item}</li>)}</ul></div>
      ) : null}
      {grading.feedback ? <p className="question-answer-grading__feedback">{grading.feedback}</p> : null}
      {attempt.understanding?.transcription ? (
        <details><summary>查看 AI 识别文本</summary><p>{attempt.understanding.transcription}</p></details>
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
  const { attempts, isLoading, isSaving, error, upload, retry, remove } = useQuestionAnswer({
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

  if (!enabled) return children
  const selected = attempts.find((attempt) => attempt.id === selectedAttemptId) ?? attempts[0] ?? null
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
          {isLoading ? <div className="question-answer-viewer__empty">正在读取我的答案…</div> : selected ? (
            <>
              <div className="question-answer-viewer__actions">
                <div><strong>第 {selected.attempt_number} 次作答</strong><span>{new Date(selected.created_at).toLocaleString()} · {orderedAssets.length} 个文件</span></div>
                <div><button type="button" onClick={openUpload} disabled={isSaving}>提交新答案</button><button type="button" className="is-danger" disabled={isSaving} onClick={() => {
                  if (window.confirm('确定删除这道题的全部作答历史吗？')) void remove()
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
                    <strong>Attempt {attempt.attempt_number}</strong><span>{attempt.grading ? `${Math.round(attempt.grading.score * 100)}%` : attempt.processing_status}</span><small>{new Date(attempt.created_at).toLocaleString()}</small>
                  </button>
                ))}</div></section>
              ) : null}
            </>
          ) : (
            <div className="question-answer-viewer__empty"><strong>暂无答案</strong><span>上传 PDF 或按顺序选择多张手写图片，保存后将在后台自动批改。</span><button type="button" onClick={openUpload} disabled={isSaving}>{isSaving ? '上传中…' : '上传答案'}</button></div>
          )}
          {error ? <p className="question-answer-viewer__error">{error}</p> : null}
        </div>
      )}

      {previewImage ? <div className="question-answer-lightbox" role="dialog" aria-modal="true" aria-label="答案图片预览"><button type="button" aria-label="关闭大图" onClick={() => setPreviewImage(null)}>×</button><img src={previewImage} alt="我的答案大图" onClick={() => setPreviewImage(null)} /></div> : null}
    </section>
  )
}
