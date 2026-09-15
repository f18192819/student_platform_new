import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  fetchTsinghuaHomeworkFile,
  listTsinghuaHomeworkByCourse,
  pullTsinghuaHomeworkByCourse,
} from '../src/lib/tsinghuaCourses.ts'
import {
  buildHomeworkImportName,
  homeworkSourceKey,
} from '../src/features/knowledge-library/homeworkImport.ts'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('homework source identity and import name stay stable', () => {
  assert.equal(homeworkSourceKey('homework-123'), 'tsinghua-homework:homework-123')
  assert.equal(buildHomeworkImportName({
    id: 'homework-123',
    resourceType: 'homework',
    courseName: '形式语言与自动机',
    fileName: '第一次作业.pdf',
    displayName: '第一次作业 - 第一次作业.pdf',
    assignmentId: 'assignment-1',
    assignmentTitle: '第一次作业',
    byteSize: 42,
    mimeType: 'application/pdf',
    kind: 'pdf',
    downloadedAt: '',
    batchId: '',
  }), '第一次作业 - 第一次作业.pdf')
})

test('homework API uses dedicated list, pull and asset routes', async () => {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method || 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    })
    if (url.endsWith('/homework/download-1')) {
      return new Response(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), { status: 200 })
    }
    return new Response(JSON.stringify({ files: [], skipped: [], count: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  const identity = {
    courseName: '形式语言与自动机',
    semesterId: '2026-2027-1',
    courseCode: '44100563',
    wlkcid: '2026-2027-1152227978',
    strictIdentity: true,
  }
  await listTsinghuaHomeworkByCourse('session-1', identity)
  await pullTsinghuaHomeworkByCourse('session-1', {
    ...identity,
    requestedFileIds: ['download-1'],
    knownFileIds: ['known-1'],
  })
  const blob = await fetchTsinghuaHomeworkFile('session-1', 'download-1')

  assert.match(calls[0]!.url, /\/session-1\/homework\/list-by-course$/)
  assert.match(calls[1]!.url, /\/session-1\/homework\/pull-by-course$/)
  assert.deepEqual(calls[1]!.body?.requestedFileIds, ['download-1'])
  assert.equal(calls[1]!.body?.strictIdentity, true)
  assert.match(calls[2]!.url, /\/session-1\/homework\/download-1$/)
  assert.equal(blob.type, 'application/pdf')
})

test('startup synchronization checks courseware and homework independently', async () => {
  const source = await readFile(
    new URL('../src/features/knowledge-library/autoCoursewareSync.ts', import.meta.url),
    'utf8',
  )

  assert.match(source, /await syncCoursewareForCourse\(/)
  assert.match(source, /await syncHomeworkForCourse\(/)
  assert.match(source, /\[homework auto sync\] skipped homework after sync error/)
  assert.match(source, /网络学堂课件与作业检查完成/)
})

test('knowledge library exposes manual homework download and processing', async () => {
  const source = await readFile(
    new URL('../src/pages/KnowledgeLibraryPage.tsx', import.meta.url),
    'utf8',
  )

  assert.match(source, /下载作业/)
  assert.match(source, /listTsinghuaHomeworkByCourse/)
  assert.match(source, /pullTsinghuaHomeworkByCourse/)
  assert.match(source, /importHomeworkFiles/)
  assert.match(source, /下载并处理作业/)
})
