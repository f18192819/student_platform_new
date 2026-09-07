import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ReaderWorkspaceLayout } from '../pdf-workspace/components/ReaderWorkspaceLayout'
import { userAnswerAssetUrl, type QuestionAnswerIdentity } from '../../lib/userAnswers'
import { useQuestionAnswer } from './useQuestionAnswer'
import { AttemptHistoryTray } from './AttemptHistoryTray'
import { GradingInspector, gradingSummaryOf } from './GradingInspector'
import { ReaderSegmentedControl } from './ReaderSegmentedControl'
import { UserAnswerPdfPreview, type UserAnswerPdfPreviewCache } from './UserAnswerPdfPreview'
import './question-answer.css'

const ACCEPTED_ANSWERS = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp'

export function QuestionAnswerViewer({ children, courseId, sourceDocumentId, questionId, sourceType, relatedPanel, chatPanel }: {
  children: ReactNode
  courseId: string | null
  sourceDocumentId: string | null
  questionId: string | null
  sourceType: 'homework' | 'past-exam'
  relatedPanel: ReactNode
  chatPanel: ReactNode
}) {
  const enabled = Boolean(courseId && sourceDocumentId && questionId)
  const identity: QuestionAnswerIdentity = {
    courseId: courseId ?? '', sourceDocumentId: sourceDocumentId ?? '', questionId: questionId ?? '',
  }
  const {
    attempts, details, isLoading, isSaving, reviewSavingQuestionId, deletingAttemptId, error,
    loadAttempt, upload, retry, saveReview, removeAttempt, remove,
  } = useQuestionAnswer({ enabled, identity, sourceType })
  const [activeTab, setActiveTab] = useState<'question' | 'answer'>('question')
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const pdfPreviewCacheRef = useRef<UserAnswerPdfPreviewCache>(new Map())
  const identityKey = `${courseId}:${sourceDocumentId}:${questionId}`

  useEffect(() => {
    setActiveTab('question')
    setSelectedAttemptId(null)
    setSelectedAssetId(null)
    setPreviewImage(null)
    pdfPreviewCacheRef.current.clear()
  }, [identityKey])

  const selectedSummary = attempts.find((attempt) => attempt.id === selectedAttemptId) ?? attempts[0] ?? null
  const selected = selectedSummary ? details[selectedSummary.id] ?? null : null
  const orderedAssets = [...(selected?.assets ?? [])].sort((left, right) => left.order - right.order)
  const selectedAsset = orderedAssets.find((asset) => asset.id === selectedAssetId) ?? orderedAssets[0] ?? null
  const selectedAssetIndex = selectedAsset ? orderedAssets.findIndex((asset) => asset.id === selectedAsset.id) : -1
  const selectedAssetUrl = selected && selectedAsset ? userAnswerAssetUrl(identity, selectedAsset.id, selected.id) : null
  const gradingSummary = gradingSummaryOf(selected)

  useEffect(() => {
    setSelectedAssetId(null)
    setPreviewImage(null)
  }, [selected?.id])

  useEffect(() => {
    if (!selectedSummary) return
    const cached = details[selectedSummary.id]
    void loadAttempt(selectedSummary.id, Boolean(cached && cached.updated_at !== selectedSummary.updated_at))
    // The summary timestamp is the cache version; the hook guards stale identity responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKey, selectedSummary?.id, selectedSummary?.updated_at])

  const openUpload = () => uploadInputRef.current?.click()
  const gradingPanel = selected ? (
    <GradingInspector
      attempt={selected}
      onRetry={() => void retry(selected.id)}
      reviewSavingQuestionId={reviewSavingQuestionId}
      onSaveReview={(reviewQuestionId, errors) => saveReview(selected.id, reviewQuestionId, selected.grading_revisions?.length ?? 0, errors)}
    />
  ) : null
  const historyPanel = attempts.length ? (
    <AttemptHistoryTray
      attempts={attempts}
      selectedAttemptId={selected?.id ?? selectedAttemptId}
      deletingAttemptId={deletingAttemptId}
      onSelect={(attemptId) => {
        setSelectedAttemptId(attemptId)
        setActiveTab('answer')
      }}
      onDelete={(attemptId, fallbackAttemptId) => {
        void removeAttempt(attemptId).then((result) => {
          if (result && (selectedAttemptId === attemptId || selected?.id === attemptId)) setSelectedAttemptId(fallbackAttemptId)
        })
      }}
    />
  ) : null

  const viewer = !enabled ? children : (
    <section className="question-answer-viewer">
      <ReaderSegmentedControl value={activeTab} answerCount={attempts.length} onChange={setActiveTab} />
      <input ref={uploadInputRef} type="file" accept={ACCEPTED_ANSWERS} multiple hidden onChange={(event) => {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ''
        if (!files.length) return
        void upload(files).then((saved) => {
          if (!saved) return
          setSelectedAttemptId(saved.id)
          setActiveTab('answer')
        })
      }} />

      {activeTab === 'question' ? <div className="question-answer-viewer__question" role="tabpanel">{children}</div> : (
        <div className="question-answer-viewer__answer" role="tabpanel">
          {isLoading ? <div className="question-answer-viewer__empty">正在读取我的答案…</div> : selectedSummary && !selected ? (
            <div className="question-answer-viewer__empty">正在读取本次作答详情…</div>
          ) : selected ? <>
            <div className="question-answer-viewer__actions">
              <div><strong>第 {selected.attempt_number} 次作答</strong><span>{new Date(selected.created_at).toLocaleString()} · {orderedAssets.length} 个文件</span></div>
              <div>
                {gradingSummary ? <span className="question-answer-viewer__score">{Math.round(gradingSummary.score * 100)}%{gradingSummary.reviewCount ? ` · ${gradingSummary.reviewCount} 题需确认` : ''}</span> : null}
                <button type="button" onClick={openUpload} disabled={isSaving || Boolean(deletingAttemptId)}>提交新答案</button>
                <button type="button" className="is-danger" disabled={isSaving || Boolean(deletingAttemptId)} onClick={() => {
                  if (window.confirm('确定删除这份作业或往年题的全部作答历史吗？')) void remove()
                }}>删除全部</button>
              </div>
            </div>
            <div className="question-answer-viewer__assets">
              {orderedAssets.length > 1 ? <nav className="question-answer-viewer__asset-pager" aria-label="切换答案文件">
                <button type="button" disabled={selectedAssetIndex <= 0} onClick={() => setSelectedAssetId(orderedAssets[selectedAssetIndex - 1]?.id ?? null)}>上一份</button>
                <span>{selectedAssetIndex + 1} / {orderedAssets.length}</span>
                <button type="button" disabled={selectedAssetIndex >= orderedAssets.length - 1} onClick={() => setSelectedAssetId(orderedAssets[selectedAssetIndex + 1]?.id ?? null)}>下一份</button>
              </nav> : null}
              {selectedAsset && selectedAssetUrl ? selectedAsset.kind === 'image' ? (
                <button key={selectedAsset.id} type="button" className="question-answer-viewer__image" aria-label={`查看答案图片 ${selectedAsset.order + 1}`} onClick={() => setPreviewImage(selectedAssetUrl)}>
                  <img src={selectedAssetUrl} alt={selectedAsset.filename} />
                </button>
              ) : (
                <UserAnswerPdfPreview key={selectedAsset.id} url={selectedAssetUrl} fileName={selectedAsset.filename} assetKey={`${selected.id}:${selectedAsset.id}`} cache={pdfPreviewCacheRef.current} />
              ) : null}
            </div>
          </> : <div className="question-answer-viewer__empty"><strong>暂无整份答案</strong><span>上传包含全部作答的 PDF，或按顺序选择多张手写图片。AI 会自动分题并逐题批改。</span><button type="button" onClick={openUpload} disabled={isSaving}>{isSaving ? '上传中…' : '上传整份答案'}</button></div>}
          {error ? <p className="question-answer-viewer__error">{error}</p> : null}
        </div>
      )}
      {previewImage ? <div className="question-answer-lightbox" role="dialog" aria-modal="true" aria-label="答案图片预览"><button type="button" aria-label="关闭大图" onClick={() => setPreviewImage(null)}>×</button><img src={previewImage} alt="我的答案大图" onClick={() => setPreviewImage(null)} /></div> : null}
    </section>
  )

  return (
    <ReaderWorkspaceLayout
      relatedPanel={relatedPanel}
      chatPanel={chatPanel}
      gradingPanel={gradingPanel}
      historyPanel={historyPanel}
      gradingBadge={gradingSummary ? `${Math.round(gradingSummary.score * 100)}%` : selected ? '…' : null}
      historyBadge={attempts.length || null}
    >{viewer}</ReaderWorkspaceLayout>
  )
}
