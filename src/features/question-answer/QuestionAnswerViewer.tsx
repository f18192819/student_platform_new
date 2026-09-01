import { useEffect, useRef, useState, type ReactNode } from 'react'
import { userAnswerAssetUrl, type QuestionAnswerIdentity } from '../../lib/userAnswers'
import { useQuestionAnswer } from './useQuestionAnswer'

const ACCEPTED_ANSWERS = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp'

export function QuestionAnswerViewer({
  children,
  courseId,
  sourceDocumentId,
  questionId,
  sourceType,
}: {
  children: ReactNode
  courseId: string | null
  sourceDocumentId: string | null
  questionId: string | null
  sourceType: 'homework' | 'past-exam'
}) {
  const enabled = Boolean(courseId && sourceDocumentId && questionId)
  const identity: QuestionAnswerIdentity = {
    courseId: courseId ?? '',
    sourceDocumentId: sourceDocumentId ?? '',
    questionId: questionId ?? '',
  }
  const { answer, isLoading, isSaving, error, upload, remove } = useQuestionAnswer({
    enabled,
    identity,
    sourceType,
  })
  const [activeTab, setActiveTab] = useState<'question' | 'answer'>('question')
  const [previewImage, setPreviewImage] = useState<string | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const identityKey = `${courseId}:${sourceDocumentId}:${questionId}`

  useEffect(() => {
    setActiveTab('question')
    setPreviewImage(null)
  }, [identityKey])

  if (!enabled) return children

  const orderedAssets = [...(answer?.assets ?? [])].sort((left, right) => left.order - right.order)
  const openUpload = () => uploadInputRef.current?.click()

  return (
    <section className="question-answer-viewer">
      <div className="question-answer-viewer__tabs" role="tablist" aria-label="题目查看方式">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'question'}
          className={activeTab === 'question' ? 'is-active' : ''}
          onClick={() => setActiveTab('question')}
        >
          原题
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'answer'}
          className={activeTab === 'answer' ? 'is-active' : ''}
          onClick={() => setActiveTab('answer')}
        >
          我的答案{answer ? ` · ${answer.assets.length}` : ''}
        </button>
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        accept={ACCEPTED_ANSWERS}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (!files.length) return
          void upload(files).then((saved) => {
            if (saved) setActiveTab('answer')
          })
        }}
      />

      {activeTab === 'question' ? children : (
        <div className="question-answer-viewer__answer" role="tabpanel">
          {isLoading ? (
            <div className="question-answer-viewer__empty">正在读取我的答案…</div>
          ) : answer ? (
            <>
              <div className="question-answer-viewer__actions">
                <div>
                  <strong>我的答案</strong>
                  <span>第 {answer.attempt_number} 次上传 · {orderedAssets.length} 个文件</span>
                </div>
                <div>
                  <button type="button" onClick={openUpload} disabled={isSaving}>重新上传</button>
                  <button
                    type="button"
                    className="is-danger"
                    disabled={isSaving}
                    onClick={() => {
                      if (window.confirm('确定删除这道题的全部答案记录吗？')) void remove()
                    }}
                  >
                    删除我的答案
                  </button>
                </div>
              </div>
              <div className="question-answer-viewer__assets">
                {orderedAssets.map((asset) => {
                  const url = userAnswerAssetUrl(identity, asset.id)
                  return asset.kind === 'image' ? (
                    <button
                      key={asset.id}
                      type="button"
                      className="question-answer-viewer__image"
                      onClick={() => setPreviewImage(url)}
                    >
                      <img src={url} alt={asset.filename} />
                      <span>{asset.order + 1}. {asset.filename}</span>
                    </button>
                  ) : (
                    <article key={asset.id} className="question-answer-viewer__pdf">
                      <header>{asset.order + 1}. {asset.filename}</header>
                      <iframe src={url} title={asset.filename} />
                    </article>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="question-answer-viewer__empty">
              <strong>暂无答案</strong>
              <span>上传 PDF 或按顺序选择多张手写图片。</span>
              <button type="button" onClick={openUpload} disabled={isSaving}>
                {isSaving ? '上传中…' : '上传答案'}
              </button>
            </div>
          )}
          {error ? <p className="question-answer-viewer__error">{error}</p> : null}
        </div>
      )}

      {previewImage ? (
        <div className="question-answer-lightbox" role="dialog" aria-modal="true" aria-label="答案图片预览">
          <button type="button" aria-label="关闭大图" onClick={() => setPreviewImage(null)}>×</button>
          <img src={previewImage} alt="我的答案大图" onClick={() => setPreviewImage(null)} />
        </div>
      ) : null}
    </section>
  )
}
