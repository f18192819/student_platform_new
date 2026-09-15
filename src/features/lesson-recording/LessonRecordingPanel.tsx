import { useState } from 'react'
import { lectureRecordingMediaUrl, type LectureRecordingView } from './lessonRecordingApi'
import './lesson-recording.css'

const STATUS_LABELS: Record<string, string> = {
  transcribed: 'ASR 已完成，等待讲义',
  aligning: '正在映射讲义页',
  aligned: '已完成页码映射',
  alignment_failed: '页码映射失败，可重试',
}

function formatTime(seconds: number) {
  const minutes = Math.floor(Math.max(0, seconds) / 60)
  const remainder = Math.floor(Math.max(0, seconds) % 60)
  return `${minutes}:${String(remainder).padStart(2, '0')}`
}

export function LessonRecordingPanel({
  records,
  isLoading,
  error,
  onRefresh,
}: {
  records: LectureRecordingView[]
  isLoading: boolean
  error: string
  onRefresh: () => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <section className="lesson-recordings">
      <header className="lesson-recordings__toolbar">
        <p>原始录音与后台 ASR 转写会永久保存在这里。</p>
        <button type="button" onClick={onRefresh} disabled={isLoading}>
          {isLoading ? '刷新中' : '刷新'}
        </button>
      </header>
      {error ? <p className="lesson-recordings__error">{error}</p> : null}
      {!records.length && !isLoading ? (
        <div className="lesson-recordings__empty">
          <strong>还没有课堂录音</strong>
          <span>点击顶部“开始上课”，结束录音后即可查看原音频和 ASR 原文。</span>
        </div>
      ) : (
        <div className="lesson-recordings__list">
          {records.map((item, index) => {
            const expanded = expandedId === item.recording.id
            const transcript = item.transcript_segments
              .map((segment) => segment.text.trim())
              .filter(Boolean)
              .join('\n')
            return (
              <article className="lesson-recording" key={item.recording.id}>
                <button
                  type="button"
                  className="lesson-recording__summary"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? null : item.recording.id)}
                >
                  <span className="lesson-recording__index">{index + 1}</span>
                  <span>
                    <strong>{item.recording.created_at
                      ? new Date(item.recording.created_at * 1000).toLocaleString()
                      : '课堂录音'}</strong>
                    <small>{formatTime(item.recording.duration)} · {STATUS_LABELS[item.status] || item.status}</small>
                  </span>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
                </button>
                {expanded ? (
                  <div className="lesson-recording__detail">
                    <audio controls preload="metadata" src={lectureRecordingMediaUrl(item.recording)}>
                      当前浏览器不支持音频播放。
                    </audio>
                    <div className="lesson-recording__transcript">
                      <div><strong>ASR 识别原文</strong><span>{item.transcript_segments.length} 个时间片段</span></div>
                      {item.transcript_segments.length ? item.transcript_segments.map((segment) => (
                        <p key={segment.id}>
                          <time>{formatTime(segment.start_time)}</time>
                          <span>{segment.text}</span>
                        </p>
                      )) : <p className="lesson-recording__missing">{transcript || '暂无可展示的识别文本。'}</p>}
                    </div>
                    {item.alignment_error ? <p className="lesson-recording__warning">{item.alignment_error}</p> : null}
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
