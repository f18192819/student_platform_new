from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from backend.document_pipeline import read_json_file, write_json_atomic
from backend.question_relation_query import FileQuestionRelationQuery
from backend.question_relations import QuestionRelationPipeline


class QuestionRelationQueryTest(unittest.TestCase):
  def setUp(self):
    self.temporary_directory = tempfile.TemporaryDirectory()
    root = Path(self.temporary_directory.name)
    self.relations = root / 'relations'
    self.pages = root / 'lecture-pages'
    self.lecture_index = root / 'lecture-document-index'
    self.reverse = root / 'question-targets'
    self.questions = root / 'question-documents'
    self.lectures = root / 'lecture-documents'
    self.query = FileQuestionRelationQuery(
      relations_dir=self.relations,
      lecture_page_index_dir=self.pages,
      lecture_document_index_dir=self.lecture_index,
      question_reverse_index_dir=self.reverse,
      question_documents_root=self.questions,
      lecture_documents_root=self.lectures,
    )

  def tearDown(self):
    self.temporary_directory.cleanup()

  def seed(self):
    write_json_atomic(self.lectures / 'lecture-1' / 'pages.json', [
      {'page_id': 'p1', 'page_number': 1, 'content': 'Lecture content'},
    ])
    write_json_atomic(self.questions / 'homework-1' / 'state.json', {
      'document_id': 'homework-1',
      'document_name': 'Homework',
      'document_type': 'homework',
    })
    write_json_atomic(self.questions / 'homework-1' / 'questions' / 'q1.json', {
      'question_id': 'q1',
      'page_number': 2,
      'content': 'Question text',
      'analysis': {'knowledge_points': ['concept-a']},
    })
    relation = {
      'relation_id': 'r1',
      'relation_type': 'question_to_lecture_page',
      'rerank_score': 0.8,
      'target': {'document_id': 'lecture-1', 'page_id': 'p1', 'page_number': 1},
    }
    write_json_atomic(self.relations / 'q1.json', {
      'status': 'completed',
      'course_id': 'c1',
      'question_id': 'q1',
      'question_document_id': 'homework-1',
      'relations': [relation],
    })

  def test_returns_only_questions_linked_to_real_pages(self):
    self.seed()

    result = self.query.lecture_document_questions('c1', 'lecture-1')

    self.assertEqual(['q1'], [item['question_id'] for item in result['questions']])
    self.assertEqual(1, result['questions'][0]['lecture_relations'][0]['target']['page_number'])

  def test_document_query_prefers_lecture_reverse_index(self):
    self.seed()
    write_json_atomic(self.lecture_index / 'lecture-1.json', {
      'course_id': 'c1',
      'lecture_document_id': 'lecture-1',
      'question_ids': ['q1'],
      'updated_at': 1,
    })
    write_json_atomic(self.relations / 'unrelated.json', {
      'status': 'completed',
      'course_id': 'c1',
      'question_id': 'unrelated',
      'question_document_id': 'missing-document',
      'relations': [{
        'relation_type': 'question_to_lecture_page',
        'target': {'document_id': 'lecture-1', 'page_number': 1},
      }],
    })

    result = self.query.lecture_document_questions('c1', 'lecture-1')

    self.assertEqual(['q1'], [item['question_id'] for item in result['questions']])

  def test_document_query_falls_back_when_index_belongs_to_another_course(self):
    self.seed()
    write_json_atomic(self.lecture_index / 'lecture-1.json', {
      'course_id': 'another-course',
      'lecture_document_id': 'lecture-1',
      'question_ids': [],
      'updated_at': 1,
    })

    result = self.query.lecture_document_questions('c1', 'lecture-1')

    self.assertEqual(['q1'], [item['question_id'] for item in result['questions']])

  def test_assessment_targets_are_filterable(self):
    self.seed()

    self.assertEqual([], self.query.assessment_relation_targets({'missing'}))
    targets = self.query.assessment_relation_targets({'q1'})

    self.assertEqual(['lecture-1'], targets[0]['lecture_document_ids'])

  def test_page_query_reads_reverse_index_without_builder(self):
    self.seed()
    write_json_atomic(self.pages / 'lecture-1' / 'page-1.json', {
      'course_id': 'c1',
      'lecture_document_id': 'lecture-1',
      'page_number': 1,
      'relations': [{'relation_id': 'r1'}],
    })

    result = self.query.lecture_page_relations('c1', 'lecture-1', 1)

    self.assertEqual('r1', result['relations'][0]['relation_id'])

  def test_pipeline_syncs_and_removes_lecture_document_index(self):
    pipeline = QuestionRelationPipeline.__new__(QuestionRelationPipeline)
    pipeline.lecture_document_index_dir = self.lecture_index
    record = {
      'course_id': 'c1',
      'question_id': 'q1',
      'relations': [{
        'relation_type': 'question_to_lecture_page',
        'target': {'document_id': 'lecture-1', 'page_number': 1},
      }],
    }

    pipeline._sync_lecture_document_indexes({}, record)
    index = read_json_file(self.lecture_index / 'lecture-1.json', {})
    self.assertEqual(['q1'], index['question_ids'])
    self.assertEqual('c1', index['course_id'])

    pipeline._sync_lecture_document_indexes(record, {})
    self.assertFalse((self.lecture_index / 'lecture-1.json').exists())


if __name__ == '__main__':
  unittest.main()
