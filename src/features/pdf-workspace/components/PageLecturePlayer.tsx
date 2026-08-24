import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { ActivePageLecturePlayer } from '../hooks/usePageLecturePlayback'

function formatPlaybackTime(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

export function PageLecturePlayer({
  player,
  playingPage,
  playbackSeconds,
  playbackRate,
  onToggle,
  onSeek,
  onSkip,
  onStop,
  onChangeRate,
}: {
  player: ActivePageLecturePlayer | null
  playingPage: number | null
  playbackSeconds: number | null
  playbackRate: number
  onToggle: () => void
  onSeek: (seconds: number) => void
  onSkip: (seconds: number) => void
  onStop: () => void
  onChangeRate: (rate: number) => void
}) {
  const [isMinimized, setIsMinimized] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const dragRef = useRef<{
    pointerId: number
    offsetX: number
    offsetY: number
    width: number
    height: number
  } | null>(null)

  useEffect(() => {
    setIsMinimized(false)
  }, [player?.pageNumber, player?.recordingId, player?.startSeconds])

  if (!player) {
    return null
  }

  const elapsedSeconds = Math.max(0, (playbackSeconds ?? player.startSeconds) - player.startSeconds)
  const durationSeconds = Math.max(0.1, player.endSeconds - player.startSeconds)
  const currentSeconds = Math.min(
    player.endSeconds,
    Math.max(player.startSeconds, playbackSeconds ?? player.startSeconds),
  )

  const handleDragStart = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return
    }
    const container = event.currentTarget.closest<HTMLElement>('.lecture-player')
    if (!container) {
      return
    }
    const bounds = container.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - bounds.left,
      offsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  const handleDragMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    const margin = 12
    setPosition({
      left: Math.min(window.innerWidth - drag.width - margin, Math.max(margin, event.clientX - drag.offsetX)),
      top: Math.min(window.innerHeight - drag.height - margin, Math.max(margin, event.clientY - drag.offsetY)),
    })
  }

  const handleDragEnd = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const dragHandlers = {
    onPointerDown: handleDragStart,
    onPointerMove: handleDragMove,
    onPointerUp: handleDragEnd,
    onPointerCancel: handleDragEnd,
  }

  return (
    <section
      className={`lecture-player ${isMinimized ? 'is-minimized' : ''}`}
      aria-label={`第 ${player.pageNumber} 页课堂讲解播放器`}
      style={position ? { left: `${position.left}px`, top: `${position.top}px`, right: 'auto', bottom: 'auto' } : undefined}
    >
      {isMinimized ? (
        <div className="lecture-player__compact-shell">
          <button type="button" className="lecture-player__drag-handle" {...dragHandlers} aria-label="拖动课堂讲解播放器" title="拖动播放器">
            ⠿
          </button>
          <button type="button" className="lecture-player__compact" onClick={() => setIsMinimized(false)} title="展开课堂讲解播放器">
            <span className={`lecture-player__pulse ${playingPage ? 'is-playing' : ''}`} />
            <span>第 {player.pageNumber} 页</span>
            <strong>{formatPlaybackTime(elapsedSeconds)}</strong>
          </button>
        </div>
      ) : (
        <>
          <div className="lecture-player__header">
            <button type="button" className="lecture-player__drag-handle" {...dragHandlers} aria-label="拖动课堂讲解播放器" title="拖动播放器">
              ⠿
            </button>
            <div><span>课堂讲解</span><strong>第 {player.pageNumber} 页</strong></div>
            <button type="button" className="lecture-player__minimize" onClick={() => setIsMinimized(true)} aria-label="最小化课堂讲解播放器" title="最小化">−</button>
          </div>
          <div className="lecture-player__progress">
            <span style={{ width: `${Math.min(100, Math.max(0, elapsedSeconds / durationSeconds * 100))}%` }} />
            <input className="lecture-player__seek" type="range" min={player.startSeconds} max={player.endSeconds} step="0.1" value={currentSeconds} onChange={(event) => onSeek(Number(event.currentTarget.value))} aria-label="课堂讲解播放进度" />
          </div>
          <div className="lecture-player__time"><span>{formatPlaybackTime(elapsedSeconds)}</span><span>{formatPlaybackTime(durationSeconds)}</span></div>
          <div className="lecture-player__controls">
            <button type="button" className="lecture-player__stop" onClick={onStop} aria-label="停止课堂讲解" title="停止并关闭播放器"><span /></button>
            <button type="button" className="lecture-player__skip" onClick={() => onSkip(-10)} aria-label="后退 10 秒" title="后退 10 秒">-10s</button>
            <button type="button" className="lecture-player__play" onClick={onToggle}>{playingPage === player.pageNumber ? '暂停' : '继续播放'}</button>
            <button type="button" className="lecture-player__skip" onClick={() => onSkip(10)} aria-label="快进 10 秒" title="快进 10 秒">+10s</button>
            <div className="lecture-player__rates" aria-label="播放速度">
              {[1, 1.25, 1.5, 2].map((rate) => <button key={rate} type="button" className={playbackRate === rate ? 'is-active' : ''} onClick={() => onChangeRate(rate)}>{rate}x</button>)}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
