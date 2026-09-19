export const MINERU_FIRST_PAINT_GRACE_MS = 1800

type TimerScheduler = (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
type TimerCanceller = (timer: ReturnType<typeof setTimeout>) => void

export function createMineruHydrationGate(
  onAllow: () => void,
  graceMs = MINERU_FIRST_PAINT_GRACE_MS,
  schedule: TimerScheduler = setTimeout,
  cancelTimer: TimerCanceller = clearTimeout,
) {
  let allowed = false
  const allow = () => {
    if (allowed) return
    allowed = true
    onAllow()
  }
  const timer = schedule(allow, graceMs)

  return {
    allow,
    cancel: () => cancelTimer(timer),
  }
}
