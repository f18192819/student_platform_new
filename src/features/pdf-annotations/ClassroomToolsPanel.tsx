import { useEffect, useState } from 'react'
import {
  isLessonRecordingActive,
  LESSON_RECORDING_TOGGLE_EVENT,
  LESSON_RECORDING_STATE_EVENT,
  requestLessonRecordingState,
} from '../lesson-recording/lessonRecordingState'
import { PDF_ANNOTATION_COLORS } from './usePdfAnnotations'
import type { PdfAnnotationTool } from './pdfAnnotationStore'
import './pdf-annotations.css'

function ToolIcon({ tool }: { tool: PdfAnnotationTool }) {
  if (tool === 'highlight') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 15 8.5-8.5 2 2L9 17H7v-2Z" /><path d="M5 20h14M14.5 7.5l2 2" /></svg>
  }
  if (tool === 'text') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14M12 6v13M8.5 19h7" /></svg>
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 4 11 9-5 1.2L9.5 19 6 4Z" /></svg>
}

export function ClassroomToolsPanel({
  tool,
  color,
  canAnnotate,
  pageAnnotationCount,
  onToolChange,
  onColorChange,
  onClearPage,
}: {
  tool: PdfAnnotationTool
  color: string
  canAnnotate: boolean
  pageAnnotationCount: number
  onToolChange: (tool: PdfAnnotationTool) => void
  onColorChange: (color: string) => void
  onClearPage: () => void
}) {
  const [isRecording, setIsRecording] = useState(isLessonRecordingActive)
  const [processingStatus, setProcessingStatus] = useState('')

  useEffect(() => {
    const handleRecordingState = (event: Event) => {
      setIsRecording(Boolean((event as CustomEvent<{ isRecording?: boolean }>).detail?.isRecording))
    }
    const handleProcessingState = (event: Event) => {
      setProcessingStatus(
        (event as CustomEvent<{ label?: string }>).detail?.label?.trim() || '',
      )
    }
    window.addEventListener(LESSON_RECORDING_STATE_EVENT, handleRecordingState)
    window.addEventListener('student-platform:lesson-processing-state', handleProcessingState)
    requestLessonRecordingState()
    return () => {
      window.removeEventListener(LESSON_RECORDING_STATE_EVENT, handleRecordingState)
      window.removeEventListener('student-platform:lesson-processing-state', handleProcessingState)
    }
  }, [])

  const toggleRecording = () => {
    window.dispatchEvent(new CustomEvent(LESSON_RECORDING_TOGGLE_EVENT, {
      detail: { action: 'toggle' },
    }))
  }

  return (
    <div className="classroom-tools">
      <section className="classroom-tools__section">
        <div className="classroom-tools__heading">
          <div>
            <strong>课堂录音</strong>
            <span>{processingStatus || (isRecording ? '正在持续录音' : '尚未开始')}</span>
          </div>
          <span className={`classroom-tools__recording-dot${isRecording ? ' is-active' : ''}`} aria-hidden="true" />
        </div>
        <button
          type="button"
          className={`classroom-tools__record${isRecording ? ' is-recording' : ''}`}
          onClick={toggleRecording}
        >
          <span aria-hidden="true" />
          {isRecording ? '结束录音并转写' : '开始上课录音'}
        </button>
        <div className="classroom-tools__file-actions">
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('student-platform:lesson-audio-upload'))}>上传录音</button>
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent('student-platform:lesson-transcript-upload'))}>上传原文</button>
        </div>
        <p>切换课程或页面不会中断录音；结束后自动保存原音频并进行 ASR。</p>
      </section>

      <section className="classroom-tools__section">
        <div className="classroom-tools__heading">
          <div><strong>页面批注</strong><span>{pageAnnotationCount ? `当前页 ${pageAnnotationCount} 条` : '当前页暂无批注'}</span></div>
        </div>
        <div className="classroom-tools__modes" role="group" aria-label="批注模式">
          {([
            ['pointer', '浏览'],
            ['highlight', '高亮'],
            ['text', '文本框'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={tool === value ? 'is-active' : ''}
              aria-pressed={tool === value}
              disabled={!canAnnotate && value !== 'pointer'}
              onClick={() => onToolChange(value)}
            >
              <ToolIcon tool={value} />
              <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="classroom-tools__palette" role="group" aria-label="批注颜色">
          <span>颜色</span>
          {PDF_ANNOTATION_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              className={color === value ? 'is-active' : ''}
              style={{ '--annotation-color': value } as React.CSSProperties}
              aria-label={`选择颜色 ${value}`}
              aria-pressed={color === value}
              onClick={() => onColorChange(value)}
            />
          ))}
        </div>
        {!canAnnotate ? <p className="classroom-tools__notice">打开 PDF 后即可使用高亮和文本框。</p> : (
          <p>{tool === 'highlight' ? '在页面上拖动以添加高亮。' : tool === 'text' ? '点击页面位置，输入批注内容。' : '选择一种工具后即可在页面上批注。'}</p>
        )}
        <button
          type="button"
          className="classroom-tools__clear"
          disabled={!pageAnnotationCount}
          onClick={onClearPage}
        >
          清空当前页批注
        </button>
      </section>
    </div>
  )
}
