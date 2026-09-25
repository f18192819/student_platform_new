import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  AUTO_SYNC_TTL_MS,
  shouldRunAutoSync,
} from '../src/features/knowledge-library/autoSyncPolicy.ts'
import {
  PDF_FIRST_VISUAL_READY_EVENT,
  scheduleStartupTask,
} from '../src/lib/startupScheduler.ts'

test('auto sync TTL suppresses repeated startup checks for fifteen minutes', () => {
  const now = 1_000_000
  assert.equal(shouldRunAutoSync(now - AUTO_SYNC_TTL_MS + 1, now), false)
  assert.equal(shouldRunAutoSync(now - AUTO_SYNC_TTL_MS, now), true)
  assert.equal(shouldRunAutoSync(null, now), true)
})

test('reader startup work waits for the first PDF visual event', () => {
  const target = new EventTarget()
  const timers: Array<() => void> = []
  const idleTasks: Array<() => void> = []
  const fakeWindow = {
    setTimeout(callback: () => void) {
      timers.push(callback)
      return timers.length
    },
    clearTimeout() {},
    requestIdleCallback(callback: () => void) {
      idleTasks.push(callback)
      return idleTasks.length
    },
    cancelIdleCallback() {},
  }
  let calls = 0
  const cancel = scheduleStartupTask(() => { calls += 1 }, {
    waitForPdfVisual: true,
    target,
    browserWindow: fakeWindow as never,
  })

  assert.equal(timers.length, 0)
  assert.equal(calls, 0)
  target.dispatchEvent(new Event(PDF_FIRST_VISUAL_READY_EVENT))
  timers.splice(0).forEach(callback => callback())
  idleTasks.splice(0).forEach(callback => callback())
  assert.equal(calls, 1)
  cancel()
})

test('auto imports use fast PDF metadata and enqueue heavy processing', async () => {
  const courseware = await readFile(
    new URL('../src/features/knowledge-library/coursewareImport.ts', import.meta.url),
    'utf8',
  )
  const autoSync = await readFile(
    new URL('../src/features/knowledge-library/autoCoursewareSync.ts', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(courseware, /extractPdfPreview\(/)
  assert.match(courseware, /probePdfPageCountFromBuffer/)
  assert.match(autoSync, /processingMode: 'background'/)
})
