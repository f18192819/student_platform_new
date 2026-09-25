import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = fileURLToPath(new URL('..', import.meta.url))
const origin = 'http://127.0.0.1:4175'
const browserPath = process.env.PDF_SMOKE_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const profile = await mkdtemp(join(tmpdir(), 'student-recording-recovery-'))
let server
let context

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(origin)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Vite did not start for recording recovery test.')
}

async function openProfile() {
  return chromium.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone'],
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
}

async function waitForUploads(count, getCount) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (getCount() >= count) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${count} ASR uploads; saw ${getCount()}.`)
}

async function readDraftSizes(page) {
  return page.evaluate(async () => {
    const store = await import('/src/features/lesson-recording/recordingDraftStore.ts')
    return (await store.readLessonRecordingDrafts(store.getLessonRecordingOwnerId(), true))
      .map((item) => ({ ownerId: item.draft.ownerId, size: item.blob.size }))
  })
}

async function waitForDrafts(page, isReady) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const drafts = await readDraftSizes(page)
    if (isReady(drafts)) return drafts
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for persisted recording drafts.')
}

async function cleanupProfile() {
  const resolvedProfile = await realpath(profile)
  const resolvedTemp = await realpath(tmpdir())
  const relativeProfile = relative(resolvedTemp, resolvedProfile)
  if (!relativeProfile || relativeProfile.startsWith('..')) {
    throw new Error('Refusing to remove a profile outside the temp directory.')
  }
  await rm(resolvedProfile, { recursive: true, force: true })
}

try {
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4175', '--strictPort'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  server.stdout.on('data', (chunk) => process.stdout.write(chunk))
  server.stderr.on('data', (chunk) => process.stderr.write(chunk))
  await waitForServer()

  context = await openProfile()
  let page = context.pages()[0] || await context.newPage()
  let shutdownUploads = 0
  await page.route('**/api/audio/transcribe', (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'ASR offline during shutdown' }),
  }).then(() => { shutdownUploads += 1 }))
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  const previousOwner = await page.evaluate(async () => {
    const store = await import('/src/features/lesson-recording/recordingDraftStore.ts')
    const ownerId = store.getLessonRecordingOwnerId()
    return ownerId
  })
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('student-platform:lesson-recording-toggle', {
    detail: { nextRecording: true },
  })))
  await waitForDrafts(page, (drafts) => drafts.some((draft) => draft.ownerId === previousOwner && draft.size > 0))
  await page.evaluate(async () => {
    const store = await import('/src/features/lesson-recording/recordingDraftStore.ts')
    const legacy = await store.createLessonRecordingDraft({
      ownerId: 'lost-session-owner', courseId: null, documentId: null, mimeType: 'audio/webm',
    })
    await store.appendLessonRecordingChunk(legacy.id, 0, new Blob(['legacy'], { type: 'audio/webm' }))
  })
  const beforeClose = await page.evaluate(async () => {
    const store = await import('/src/features/lesson-recording/recordingDraftStore.ts')
    return (await store.readLessonRecordingDrafts(store.getLessonRecordingOwnerId(), true))
      .map((item) => ({ ownerId: item.draft.ownerId, size: item.blob.size, state: item.draft.state }))
  })
  assert.equal(beforeClose.length, 2)
  assert.equal(shutdownUploads, 0)
  await context.close()
  context = null

  context = await openProfile()
  page = context.pages()[0] || await context.newPage()
  let shouldFail = true
  let uploads = 0
  await page.route('**/api/audio/transcribe', async (route) => {
    uploads += 1
    if (shouldFail) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'ASR offline' }) })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        text: 'Recovered classroom speech',
        chunks: [{ text: 'Recovered classroom speech', start_seconds: 0, end_seconds: 1 }],
        recording: { id: `recovered-${uploads}`, course_id: '__unassigned__', document_id: null },
      }),
    })
  })
  await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await waitForUploads(2, () => uploads)
  assert.equal(uploads, 2, 'Both the current and legacy browser-session drafts should be retried.')

  const persistedAfterFailure = await page.evaluate(async () => {
    const store = await import('/src/features/lesson-recording/recordingDraftStore.ts')
    const ownerId = store.getLessonRecordingOwnerId()
    const drafts = await store.readLessonRecordingDrafts(ownerId, true)
    return { ownerId, sizes: drafts.map((item) => item.blob.size).sort((a, b) => a - b) }
  })
  assert.equal(persistedAfterFailure.ownerId, previousOwner)
  assert.equal(persistedAfterFailure.sizes.length, 2, 'Failed ASR must not delete recorded chunks.')
  assert.equal(persistedAfterFailure.sizes[0], 6, 'The old session draft should survive browser restart.')
  assert.ok(persistedAfterFailure.sizes[1] > 6, 'The interrupted MediaRecorder audio should survive browser restart.')

  shouldFail = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await waitForUploads(4, () => uploads)
  assert.equal(uploads, 4, 'Going online should retry each preserved draft exactly once.')
  await waitForDrafts(page, (drafts) => drafts.length === 0)

  console.log(JSON.stringify({ recordingRecovery: 'passed', interruptedDrafts: 2, failedUploads: 2, recoveredUploads: 2 }))
} finally {
  if (context) await context.close()
  if (server) server.kill()
  await cleanupProfile()
}
