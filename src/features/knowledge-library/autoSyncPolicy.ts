export const AUTO_SYNC_TTL_MS = 15 * 60 * 1_000
export const AUTO_SYNC_LAST_CHECKED_AT_KEY = 'student-platform:tsinghua-auto-sync:last-checked-at'

export function shouldRunAutoSync(lastCheckedAt: number | null, now = Date.now()) {
  return lastCheckedAt === null
    || !Number.isFinite(lastCheckedAt)
    || now - lastCheckedAt >= AUTO_SYNC_TTL_MS
}

export function readAutoSyncLastCheckedAt(storage: Pick<Storage, 'getItem'>) {
  const raw = storage.getItem(AUTO_SYNC_LAST_CHECKED_AT_KEY)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

export function writeAutoSyncLastCheckedAt(storage: Pick<Storage, 'setItem'>, value = Date.now()) {
  storage.setItem(AUTO_SYNC_LAST_CHECKED_AT_KEY, String(value))
}
