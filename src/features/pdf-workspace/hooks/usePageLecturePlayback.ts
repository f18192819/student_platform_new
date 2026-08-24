import { useCallback, useEffect, useRef, useState } from 'react'
import { resolveBackendApiUrl } from '../../../lib/apiConfig'
import type { ClassroomLectureSegment } from '../../../types'

export type PageLecturePlaybackRange = {
  recordingId: string
  startSeconds: number
  endSeconds: number
}

export type ActivePageLecturePlayer = PageLecturePlaybackRange & {
  pageNumber: number
}

function findLongestContinuousLectureRange(
  segments: ClassroomLectureSegment[],
): PageLecturePlaybackRange | null {
  const candidates = segments
    .flatMap((segment) => {
      if (
        !segment.recordingId ||
        segment.startSeconds === null ||
        segment.endSeconds === null ||
        segment.endSeconds <= segment.startSeconds
      ) {
        return []
      }
      return [{
        recordingId: segment.recordingId,
        startSeconds: segment.startSeconds,
        endSeconds: segment.endSeconds,
      }]
    })
    .sort(
      (left, right) =>
        left.recordingId.localeCompare(right.recordingId) || left.startSeconds - right.startSeconds,
    )

  const ranges: PageLecturePlaybackRange[] = []
  for (const candidate of candidates) {
    const previous = ranges.at(-1)
    if (
      previous &&
      previous.recordingId === candidate.recordingId &&
      candidate.startSeconds <= previous.endSeconds + 1
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, candidate.endSeconds)
      continue
    }
    ranges.push({ ...candidate })
  }

  return ranges.reduce<PageLecturePlaybackRange | null>(
    (longest, range) =>
      !longest || range.endSeconds - range.startSeconds > longest.endSeconds - longest.startSeconds
        ? range
        : longest,
    null,
  )
}

export function usePageLecturePlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [playingPage, setPlayingPage] = useState<number | null>(null)
  const [activePlayer, setActivePlayer] = useState<ActivePageLecturePlayer | null>(null)
  const [playbackSeconds, setPlaybackSeconds] = useState<number | null>(null)
  const [playbackRate, setPlaybackRate] = useState(1)

  const stop = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    setPlayingPage(null)
    setActivePlayer(null)
    setPlaybackSeconds(null)
  }, [])

  useEffect(() => stop, [stop])

  const playPageSegments = useCallback(
    (pageNumber: number, segments: ClassroomLectureSegment[], courseId: string | null) => {
      const playbackRange = findLongestContinuousLectureRange(segments)
      if (!playbackRange || !courseId) {
        return
      }

      const audio = audioRef.current ?? new Audio()
      audioRef.current = audio
      audio.pause()
      audio.playbackRate = playbackRate
      setActivePlayer({ pageNumber, ...playbackRange })
      setPlaybackSeconds(playbackRange.startSeconds)
      audio.onplay = () => setPlayingPage(pageNumber)
      audio.onpause = () => setPlayingPage((current) => (current === pageNumber ? null : current))
      audio.onended = () => setPlayingPage(null)
      audio.onerror = () => {
        setPlayingPage(null)
        setActivePlayer(null)
        setPlaybackSeconds(null)
      }
      audio.ontimeupdate = () => {
        setPlaybackSeconds(audio.currentTime)
        if (audio.currentTime >= playbackRange.endSeconds) {
          audio.currentTime = playbackRange.endSeconds
          audio.pause()
        }
      }
      audio.onloadedmetadata = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : playbackRange.endSeconds
        audio.currentTime = Math.min(playbackRange.startSeconds, Math.max(0, duration - 0.05))
        void audio.play().then(
          () => setPlayingPage(pageNumber),
          () => setPlayingPage(null),
        )
      }
      audio.src = resolveBackendApiUrl(
        `/api/audio/recordings/${encodeURIComponent(playbackRange.recordingId)}/media?course_id=${encodeURIComponent(courseId)}`,
      )
      audio.load()
    },
    [playbackRate],
  )

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !activePlayer) {
      return
    }

    if (audio.paused) {
      if (audio.currentTime < activePlayer.startSeconds || audio.currentTime >= activePlayer.endSeconds) {
        audio.currentTime = activePlayer.startSeconds
        setPlaybackSeconds(activePlayer.startSeconds)
      }
      audio.playbackRate = playbackRate
      void audio.play().catch(() => setPlayingPage(null))
      return
    }

    audio.pause()
  }, [activePlayer, playbackRate])

  const seek = useCallback(
    (targetSeconds: number) => {
      const audio = audioRef.current
      if (!audio || !activePlayer) {
        return
      }

      const nextSeconds = Math.min(
        activePlayer.endSeconds,
        Math.max(activePlayer.startSeconds, targetSeconds),
      )
      audio.currentTime = nextSeconds
      setPlaybackSeconds(nextSeconds)
      if (nextSeconds >= activePlayer.endSeconds) {
        audio.pause()
      }
    },
    [activePlayer],
  )

  const skip = useCallback(
    (seconds: number) => {
      if (!activePlayer) {
        return
      }
      seek((playbackSeconds ?? activePlayer.startSeconds) + seconds)
    },
    [activePlayer, playbackSeconds, seek],
  )

  const changeRate = useCallback((rate: number) => {
    setPlaybackRate(rate)
    if (audioRef.current) {
      audioRef.current.playbackRate = rate
    }
  }, [])

  return {
    activePlayer,
    playingPage,
    playbackSeconds,
    playbackRate,
    playPageSegments,
    toggle,
    seek,
    skip,
    stop,
    changeRate,
  }
}
