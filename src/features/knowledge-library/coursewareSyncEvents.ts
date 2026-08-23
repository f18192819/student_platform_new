export const COURSEWARE_AUTO_SYNC_DELETION_EVENT = 'student-platform:courseware-auto-sync-deletion'
export const COURSEWARE_AUTO_SYNC_STATUS_EVENT = 'student-platform:courseware-auto-sync-status'

export type CoursewareAutoSyncDeletionDetail = {
  sourceKey: string
  action: 'suppress' | 'restore'
}

export type CoursewareAutoSyncStatusDetail = {
  state: 'syncing' | 'completed' | 'deferred'
  message: string
}

export function notifyCoursewareAutoSyncDeletion(detail: CoursewareAutoSyncDeletionDetail) {
  window.dispatchEvent(
    new CustomEvent<CoursewareAutoSyncDeletionDetail>(COURSEWARE_AUTO_SYNC_DELETION_EVENT, {
      detail,
    }),
  )
}

export function notifyCoursewareAutoSyncStatus(detail: CoursewareAutoSyncStatusDetail) {
  window.dispatchEvent(
    new CustomEvent<CoursewareAutoSyncStatusDetail>(COURSEWARE_AUTO_SYNC_STATUS_EVENT, {
      detail,
    }),
  )
}
