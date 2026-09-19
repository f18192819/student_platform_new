import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildReaderChatContext,
  migrateReaderChatSessions,
} from '../src/lib/chatMemory.ts'
import type { ReaderChatSession, StoredDoubtAnnotation } from '../src/types.ts'

const now = '2026-09-20T00:00:00.000Z'

function legacyAnnotation(): StoredDoubtAnnotation {
  return {
    id: 'annotation-20',
    pageNumber: 20,
    question: '为什么这里取逆矩阵？',
    imageAssetId: null,
    imageName: null,
    createdAt: now,
    updatedAt: now,
    relatedQuestionIds: [],
    chatSession: {
      id: 'old-page-session',
      title: '第 20 页疑点',
      messages: [{ id: 'legacy-user', role: 'user', content: '解释第 20 页', createdAt: now }],
      compactionPoints: [],
      createdAt: now,
      updatedAt: now,
    },
  }
}

test('legacy annotation chat migration is deterministic and idempotent', () => {
  const first = migrateReaderChatSessions({
    documentId: 'lecture-1',
    annotations: [legacyAnnotation()],
  })
  const second = migrateReaderChatSessions({
    documentId: 'lecture-1',
    sessions: first.sessions,
    activeSessionId: first.activeSessionId,
    annotations: [legacyAnnotation()],
  })

  assert.equal(first.sessions[0].id, 'legacy-annotation-annotation-20')
  assert.deepEqual(second.sessions.map((session) => session.id), first.sessions.map((session) => session.id))
  assert.equal(new Set(second.sessions.map((session) => session.id)).size, second.sessions.length)
  assert.equal(second.activeSessionId, first.activeSessionId)
})

test('message references survive normalization and are included in model history', () => {
  const session: ReaderChatSession = {
    id: 'reader-session',
    title: '跨页讨论',
    createdAt: now,
    updatedAt: now,
    compactionPoints: [],
    messages: [{
      id: 'user-1',
      role: 'user',
      content: '解释这个推导',
      createdAt: now,
      references: [{
        id: 'ref-page-20',
        sourceType: 'lecture',
        documentId: 'lecture-1',
        documentName: '线性代数讲义',
        pageNumber: 20,
        blockId: 'block-20',
        label: '定理 4.2',
        excerpt: 'A 可逆当且仅当 det(A) 不为零。',
      }],
    }],
  }

  const migrated = migrateReaderChatSessions({ documentId: 'lecture-1', sessions: [session] })
  const message = migrated.sessions[0].messages[0]
  const context = buildReaderChatContext(migrated.sessions[0])

  assert.equal(message.references?.[0].pageNumber, 20)
  assert.equal(message.references?.[0].documentId, 'lecture-1')
  assert.match(context[0].content, /线性代数讲义/)
  assert.match(context[0].content, /20/)
  assert.match(context[0].content, /det\(A\)/)
})

test('reader sessions are document-scoped and page navigation does not mutate chat identity', () => {
  const types = readFileSync('src/types.ts', 'utf8')
  const workspace = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  const sessionType = types.match(/export type ReaderChatSession = \{([\s\S]*?)\n\}/)?.[1] ?? ''

  assert.doesNotMatch(sessionType, /pageNumber|annotationId/)
  assert.match(workspace, /const handlePrevPage = \(\) => \{\s*setCurrentPage/)
  assert.match(workspace, /const handleNextPage = \(\) => \{\s*setCurrentPage/)
  assert.doesNotMatch(workspace, /setCurrentPage[\s\S]{0,180}setActiveChatSessionId/)
  assert.match(workspace, /\.\.\.\(explicitReferenceContext \? \[\] : \[\{/)
  assert.match(workspace, /const referenceDocumentId = viewerSource\.kind === 'homework'[\s\S]*?: knowledgeFileId/)
  assert.match(workspace, /documentId: referenceDocumentId/)
})

test('stop generation keeps partial output and locks session controls while streaming', () => {
  const workspace = readFileSync('src/pages/PdfWorkspacePage.tsx', 'utf8')
  const panel = readFileSync('src/features/pdf-workspace/components/ChatPanel.tsx', 'utf8')

  assert.match(panel, /disabled=\{isAsking\}/)
  assert.match(panel, /onClick=\{isAsking \? onStop : onSend\}/)
  assert.match(panel, /\{isAsking \? '停止' : '发送'\}/)
  assert.match(workspace, /const partialAnswer = currentSession\?\.messages\.find/)
  assert.match(workspace, /if \(controller\.signal\.aborted\) \{[\s\S]*?if \(!partialAnswer\)/)
  assert.match(workspace, /batcher\.flush\(\)[\s\S]*?persistRequestState\(requestSessions, sessionId\)/)
  assert.match(workspace, /onStop=\{handleStopGeneration\}/)
})
