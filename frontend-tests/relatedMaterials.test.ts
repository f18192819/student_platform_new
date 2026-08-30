import assert from 'node:assert/strict'
import test from 'node:test'
import {
  mapLecturePageRelationCards,
  mapQuestionRelationCards,
} from '../src/features/pdf-workspace/hooks/useRelatedMaterials'

test('maps question relations without losing navigation identity', () => {
  const cards = mapQuestionRelationCards([
    {
      relation_id: 'r1',
      relation_type: 'question_to_lecture_page',
      confidence: 0.9,
      target: {
        document_id: 'lecture-1',
        document_name: 'Lecture',
        document_type: 'lecture',
        page_number: 7,
        content: 'Page content',
      },
    },
  ])

  assert.equal(cards.length, 1)
  assert.deepEqual(
    { kind: cards[0].kind, documentId: cards[0].documentId, pageNumber: cards[0].pageNumber },
    { kind: 'lecture', documentId: 'lecture-1', pageNumber: 7 },
  )
})

test('lecture page mapping rejects relations for another page', () => {
  const relation = {
    relation_id: 'r1',
    relation_type: 'question_to_lecture_page',
    target: { document_id: 'lecture-1', page_number: 8 },
    question: {
      question_id: 'q1',
      document_id: 'homework-1',
      document_type: 'homework',
      page_number: 2,
    },
  }

  assert.equal(mapLecturePageRelationCards([relation], 'lecture-1', 7).length, 0)
  assert.equal(mapLecturePageRelationCards([relation], 'lecture-1', 8)[0].questionId, 'q1')
})
