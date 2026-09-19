import { Component, type ReactNode, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import type { ChatMessage, ReaderChatSession } from '../../../types'
import { prepareChatMarkdownMath } from '../../../lib/latexMarkdown'
import type { ComposerAttachment } from '../types'

function resolveRoleLabel(role: ChatMessage['role']) {
  if (role === 'user') return '我'
  if (role === 'teacher') return '老师'
  if (role === 'assistant') return 'AI'
  return '系统'
}

class ChatMarkdownBoundary extends Component<
  { content: string; children: ReactNode },
  { failed: boolean; content: string }
> {
  state = { failed: false, content: this.props.content }

  static getDerivedStateFromProps(
    props: { content: string },
    state: { failed: boolean; content: string },
  ) {
    return props.content === state.content
      ? null
      : { failed: false, content: props.content }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed
      ? <pre className="chat-markdown-fallback">{this.props.content}</pre>
      : this.props.children
  }
}

function ChatMarkdown({ content }: { content: string }) {
  const prepared = prepareChatMarkdownMath(content)
  return (
    <ChatMarkdownBoundary content={prepared}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]}
      >
        {prepared}
      </ReactMarkdown>
    </ChatMarkdownBoundary>
  )
}

export function ChatPanel({
  messages,
  sessions,
  activeSessionId,
  onSessionChange,
  onNewSession,
  isAsking,
  latestAssistantMessageId,
  messagesContainerRef,
  composerAttachments,
  onRemoveAttachment,
  questionInput,
  onQuestionInputChange,
  onQuestionInputKeyDown,
  onToggleCapture,
  onOpenUpload,
  showModelSelector = true,
  availableModels,
  activeModel,
  onModelChange,
  onSend,
  onStop,
  canSend,
}: {
  messages: ChatMessage[]
  sessions: ReaderChatSession[]
  activeSessionId: string
  onSessionChange: (sessionId: string) => void
  onNewSession: () => void
  isAsking: boolean
  latestAssistantMessageId: string | null
  messagesContainerRef: RefObject<HTMLDivElement | null>
  composerAttachments: ComposerAttachment[]
  onRemoveAttachment: (attachmentId: string) => void
  questionInput: string
  onQuestionInputChange: (value: string) => void
  onQuestionInputKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onToggleCapture: () => void
  onOpenUpload: () => void
  showModelSelector?: boolean
  availableModels: string[]
  activeModel: string
  onModelChange: (model: string) => void
  onSend: () => void
  onStop: () => void
  canSend: boolean
}) {
  const referenceGroups = new Map<string, { label: string; attachmentIds: string[] }>()
  const nonReferenceAttachments: ComposerAttachment[] = []
  for (const attachment of composerAttachments) {
    const reference = attachment.blockReference
    if (!reference) {
      nonReferenceAttachments.push(attachment)
      continue
    }
    const key = `${reference.documentId}:${reference.pageNumber ?? 'unknown'}`
    const pageLabel = reference.pageNumber === null ? '页码未知' : `第 ${reference.pageNumber} 页`
    const group = referenceGroups.get(key) ?? {
      label: `${reference.documentName} · ${pageLabel}`,
      attachmentIds: [],
    }
    group.attachmentIds.push(attachment.id)
    referenceGroups.set(key, group)
  }

  return (
    <div className="pdf-chat pdf-chat--reader">
      <header className="reader-chat-session-bar">
        <div className="reader-chat-session-bar__title">AI 助手</div>
        <select
          aria-label="选择对话"
          value={activeSessionId}
          onChange={(event) => onSessionChange(event.target.value)}
          disabled={isAsking}
          title={sessions.find((session) => session.id === activeSessionId)?.title}
        >
          {sessions.map((session) => (
            <option key={session.id} value={session.id}>{session.title}</option>
          ))}
        </select>
        <button type="button" onClick={onNewSession} disabled={isAsking}>+ 新建对话</button>
      </header>

      <div className="pdf-chat__messages" ref={messagesContainerRef}>
        {messages.length ? messages.map((message) => (
          <article
            key={message.id}
            className={[
              'chat-message',
              `chat-message--${message.role}`,
              isAsking && message.role === 'assistant' && message.id === latestAssistantMessageId
                ? 'chat-message--streaming'
                : '',
            ].filter(Boolean).join(' ')}
          >
            <div className="chat-message__meta">{resolveRoleLabel(message.role)}</div>
            <div className="chat-message__content">
              {message.role === 'assistant' || message.role === 'teacher' ? (
                <>
                  <ChatMarkdown content={message.content} />
                  {isAsking && message.id === latestAssistantMessageId ? (
                    <span className="chat-stream-caret" aria-hidden="true" />
                  ) : null}
                </>
              ) : <p>{message.content}</p>}
              {message.references?.length ? (
                <div className="chat-message__references" aria-label="本条消息引用">
                  {Array.from(new Map(message.references.map((reference) => {
                    const page = reference.pageNumber === null ? '页码未知' : `第 ${reference.pageNumber} 页`
                    return [
                      `${reference.documentId}:${reference.pageNumber}`,
                      `${reference.documentName} · ${page}`,
                    ]
                  })).values()).map((label) => <span key={label}>{label}</span>)}
                </div>
              ) : null}
            </div>
          </article>
        )) : (
          <div className="reader-chat-empty">
            <strong>开始一段新对话</strong>
            <p>可以直接提问，也可以先在 PDF 中选择文字或公式作为显式引用。</p>
          </div>
        )}
      </div>

      <div className="pdf-chat__composer">
        {composerAttachments.length ? (
          <div className="chat-attachment-list">
            {[...referenceGroups.values()].map((group) => (
              <button
                key={group.label}
                type="button"
                className="chat-attachment-chip chat-attachment-chip--reference"
                onClick={() => group.attachmentIds.forEach(onRemoveAttachment)}
                title="移除这组引用"
              >
                引用 {group.label} ×
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
            placeholder="向 AI 提问；当前页只作为辅助背景，显式引用会优先使用。"
            onChange={(event) => onQuestionInputChange(event.target.value)}
            onKeyDown={onQuestionInputKeyDown}
          />
        </label>
        <div className="pdf-chat__composer-actions">
          <div className="pdf-chat__toolrow">
            <button type="button" className="chat-tool-button" onClick={onToggleCapture}>截图</button>
            <button type="button" className="chat-tool-button" onClick={onOpenUpload}>上传图片/文档</button>
            {showModelSelector ? (
              <label className="chat-model-select">
                <span>模型</span>
                <select
                  value={activeModel}
                  onChange={(event) => onModelChange(event.target.value)}
                  disabled={isAsking}
                >
                  {availableModels.length ? availableModels.map((model) => (
                    <option key={model} value={model}>{model}</option>
                  )) : <option value="">未配置模型</option>}
                </select>
              </label>
            ) : null}
          </div>
          <button
            type="button"
            className="primary-button"
            onClick={isAsking ? onStop : onSend}
            disabled={!isAsking && !canSend}
          >
            {isAsking ? '停止' : '发送'}
          </button>
        </div>
      </div>
    </div>
  )
}
