import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import type { ChatMessage, StoredDoubtAnnotation } from '../../../types'
import type { ComposerAttachment, DraftDoubt } from '../types'

function resolveRoleLabel(role: ChatMessage['role']) {
  if (role === 'user') return '我'
  if (role === 'teacher') return '老师'
  if (role === 'assistant') return 'AI'
  return '系统'
}

export function ChatPanel({
  messages,
  isAsking,
  latestAssistantMessageId,
  messagesContainerRef,
  composerAttachments,
  onRemoveAttachment,
  questionInput,
  currentPage,
  pageFilter,
  pageAnnotations,
  draftDoubt,
  selectedAnnotation,
  onCreateDoubt,
  onSelectAnnotation,
  onQuestionInputChange,
  onQuestionInputKeyDown,
  onToggleCapture,
  onOpenUpload,
  availableModels,
  activeModel,
  onModelChange,
  onSend,
  isSavingDoubt,
  canSend,
}: {
  messages: ChatMessage[]
  isAsking: boolean
  latestAssistantMessageId: string | null
  messagesContainerRef: React.RefObject<HTMLDivElement | null>
  composerAttachments: ComposerAttachment[]
  onRemoveAttachment: (attachmentId: string) => void
  questionInput: string
  currentPage: number
  pageFilter: number | null
  pageAnnotations: StoredDoubtAnnotation[]
  draftDoubt: DraftDoubt | null
  selectedAnnotation: StoredDoubtAnnotation | null
  onCreateDoubt: () => void
  onSelectAnnotation: (annotationId: string) => void
  onQuestionInputChange: (value: string) => void
  onQuestionInputKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onToggleCapture: () => void
  onOpenUpload: () => void
  availableModels: string[]
  activeModel: string
  onModelChange: (model: string) => void
  onSend: () => void
  isSavingDoubt: boolean
  canSend: boolean
}) {
  const referenceGroups = new Map<string, { pageNumber: number; attachmentIds: string[] }>()
  const nonReferenceAttachments: ComposerAttachment[] = []
  for (const attachment of composerAttachments) {
    const reference = attachment.blockReference
    if (!reference) {
      nonReferenceAttachments.push(attachment)
      continue
    }
    const key = `${reference.viewer}:${reference.documentId || ''}:${reference.pageNumber}`
    const group = referenceGroups.get(key) ?? {
      pageNumber: reference.pageNumber,
      attachmentIds: [],
    }
    group.attachmentIds.push(attachment.id)
    referenceGroups.set(key, group)
  }

  return (
    <aside className="pdf-workspace__qa pdf-workspace__qa--fixed">
      <div className={`pdf-chat pdf-chat--reader${pageFilter !== null ? ' pdf-chat--with-doubt-sessions' : ''}`}>
        {pageFilter !== null ? (
          <section className="doubt-session-list" aria-label={`第 ${pageFilter} 页疑点会话`}>
            <button type="button" className="doubt-session-list__create" onClick={onCreateDoubt}>
              <span aria-hidden="true">+</span>
              新建疑问
            </button>
            <div className="doubt-session-list__items">
              {pageAnnotations.length ? (
                pageAnnotations.map((annotation, index) => (
                  <button
                    key={annotation.id}
                    type="button"
                    className={`doubt-session-list__item${selectedAnnotation?.id === annotation.id ? ' is-active' : ''}`}
                    onClick={() => onSelectAnnotation(annotation.id)}
                    title={annotation.question}
                  >
                    <span>疑点 {index + 1}</span>
                    <strong>{annotation.question}</strong>
                  </button>
                ))
              ) : (
                <p className="doubt-session-list__empty">这一页还没有疑点，点击上方新建疑问。</p>
              )}
            </div>
          </section>
        ) : null}
        <div className="pdf-chat__messages" ref={messagesContainerRef}>
          {messages.map((message) => (
            <article
              key={message.id}
              className={[
                'chat-message',
                `chat-message--${message.role}`,
                isAsking &&
                message.role === 'assistant' &&
                message.id === latestAssistantMessageId
                  ? 'chat-message--streaming'
                  : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="chat-message__meta">{resolveRoleLabel(message.role)}</div>
              <div className="chat-message__content">
                {message.role === 'assistant' || message.role === 'teacher' ? (
                  <>
                    <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {message.content}
                    </ReactMarkdown>
                    {isAsking && message.id === latestAssistantMessageId ? (
                      <span className="chat-stream-caret" aria-hidden="true" />
                    ) : null}
                  </>
                ) : (
                  <p>{message.content}</p>
                )}
              </div>
            </article>
          ))}
        </div>
        <div className="pdf-chat__composer">
          {composerAttachments.length ? (
            <div className="chat-attachment-list">
              {[...referenceGroups.values()].map((group) => (
                <button
                  key={`page-reference-${group.attachmentIds.join('-')}`}
                  type="button"
                  className="chat-attachment-chip chat-attachment-chip--reference"
                  onClick={() => group.attachmentIds.forEach(onRemoveAttachment)}
                  title="移除本页全部引用"
                >
                  引用第 {group.pageNumber} 页 ×
                </button>
              ))}
              {nonReferenceAttachments.map((attachment) => (
                <button
                  key={attachment.id}
                  type="button"
                  className="chat-attachment-chip"
                  onClick={() => onRemoveAttachment(attachment.id)}
                >
                  {attachment.name} ×
                </button>
              ))}
            </div>
          ) : null}
          <label className="chat-composer" htmlFor="pdf-chat-input">
            <textarea
              id="pdf-chat-input"
              value={questionInput}
              placeholder={
                draftDoubt
                  ? `请输入第 ${draftDoubt.pageNumber ?? currentPage} 页的新疑点问题，发送后会自动创建记录。`
                  : selectedAnnotation
                    ? '继续围绕当前疑点追问。'
                    : `直接提问即可，我会按当前第 ${pageFilter ?? currentPage} 页自动创建疑点并回复。`
              }
              onChange={(event) => onQuestionInputChange(event.target.value)}
              onKeyDown={onQuestionInputKeyDown}
            />
          </label>
          <div className="pdf-chat__composer-actions">
            <div className="pdf-chat__toolrow">
              <button type="button" className="chat-tool-button" onClick={onToggleCapture}>
                截图
              </button>
              <button type="button" className="chat-tool-button" onClick={onOpenUpload}>
                上传图片/文档
              </button>
              <label className="chat-model-select">
                <span>模型</span>
                <select value={activeModel} onChange={(event) => onModelChange(event.target.value)}>
                  {availableModels.length ? (
                    availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  ) : (
                    <option value="">未配置模型</option>
                  )}
                </select>
              </label>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={onSend}
              disabled={!canSend}
            >
              {isAsking ? '回答中...' : isSavingDoubt ? '创建中...' : '发送'}
            </button>
          </div>
        </div>
      </div>
    </aside>
  )
}
