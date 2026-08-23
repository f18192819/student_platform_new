from __future__ import annotations

# KNOWLEDGE_GRAPH_PAUSED: preserved implementation; app.py no longer imports or executes this module.

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Protocol

import requests
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import PROJECT_ROOT
from .document_pipeline import DOCUMENTS_ROOT, _read_json, _safe_name, _write_json
from .question_pipeline import QUESTION_DOCUMENTS_ROOT
from .question_relations import RELATIONS_DIR
from .runtime_config import load_api_config

KNOWLEDGE_GRAPH_ROOT = PROJECT_ROOT / '.runtime' / 'knowledge-graph'
GRAPH_DOCUMENTS_ROOT = KNOWLEDGE_GRAPH_ROOT / 'documents'
GRAPH_VERSION = 1


class GraphUnavailable(RuntimeError):
  """The optional Neo4j service has not been configured or is offline."""


class PageKnowledgeAnalysis(BaseModel):
  """Small, bounded schema used to turn a lecture page into graph facts."""

  model_config = ConfigDict(extra='forbid')
  concepts: list[str] = Field(default_factory=list, max_length=12)
  formulas: list[str] = Field(default_factory=list, max_length=12)
  chapter: str = Field(default='', max_length=160)
  section: str = Field(default='', max_length=160)
  is_summary_or_directory: bool = False


class GraphStore(Protocol):
  def available(self) -> None: ...

  def upsert_lecture(
    self,
    document: dict[str, Any],
    pages: list[dict[str, Any]],
    page_analyses: dict[str, dict[str, Any]],
  ) -> None: ...

  def upsert_questions(
    self,
    document: dict[str, Any],
    questions: list[dict[str, Any]],
    relation_records: dict[str, dict[str, Any]],
  ) -> None: ...

  def upsert_teacher_statements(self, course_id: str, statements: list[dict[str, Any]]) -> None: ...

  def delete_document(self, document_id: str) -> None: ...

  def overview(self, course_id: str) -> dict[str, Any]: ...

  def close(self) -> None: ...


def _stable_id(kind: str, course_id: str, value: str) -> str:
  normalized = re.sub(r'\s+', ' ', value).strip().casefold()
  digest = hashlib.sha256(f'{kind}:{course_id}:{normalized}'.encode('utf-8')).hexdigest()[:24]
  return f'{kind}-{digest}'


def _labels(values: Any, limit: int = 12) -> list[str]:
  result: list[str] = []
  if not isinstance(values, list):
    return result
  for value in values:
    text = re.sub(r'\s+', ' ', str(value or '')).strip(' ,;，；。')
    if len(text) < 2 or len(text) > 180:
      continue
    if text not in result:
      result.append(text)
    if len(result) >= limit:
      break
  return result


def _page_is_low_value(page: dict[str, Any]) -> bool:
  title = str(page.get('title') or '')
  content = str(page.get('content') or '')
  text = f'{title}\n{content}'.casefold()
  return len(content.strip()) < 40 or any(marker in text for marker in ('目录', 'contents', '参考文献', 'thank you', '总结', '小结'))


class PageKnowledgeExtractor:
  """Uses the configured text model, with a deterministic fallback for outages."""

  def analyze(self, page: dict[str, Any]) -> dict[str, Any]:
    fallback = self._fallback(page)
    if _page_is_low_value(page):
      fallback['is_summary_or_directory'] = True
      return fallback

    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      return fallback

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = PageKnowledgeAnalysis.model_json_schema()
    prompt = {
      'page_number': page.get('page_number'),
      'title': page.get('title'),
      'chapter': page.get('chapter'),
      'section': page.get('section'),
      'content': str(page.get('content') or '')[:8000],
    }
    payload: dict[str, Any] = {
      'model': model,
      'temperature': 0,
      'messages': [
        {
          'role': 'system',
          'content': (
            'Extract a compact course knowledge graph from one lecture page. Return JSON only. '
            'List the explicit teachable concepts and formulas present on this page, not generic words. '
            'Keep terminology in the source language. Mark only table-of-contents, recap, or closing pages as '
            'is_summary_or_directory. Do not infer facts that are absent from the page.'
          ),
        },
        {'role': 'user', 'content': json.dumps({'json_schema': schema, 'page': prompt}, ensure_ascii=False)},
      ],
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'page_knowledge_analysis', 'strict': True, 'schema': schema},
      },
    }
    try:
      response = requests.post(
        f'{root}/chat/completions',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        json=payload,
        timeout=120,
      )
      if response.status_code == 400:
        payload['response_format'] = {'type': 'json_object'}
        response = requests.post(
          f'{root}/chat/completions',
          headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
          json=payload,
          timeout=120,
        )
      response.raise_for_status()
      message = response.json()['choices'][0]['message']['content']
      raw = json.loads(str(message).strip().removeprefix('```json').removesuffix('```').strip())
      analysis = PageKnowledgeAnalysis.model_validate(raw).model_dump()
      analysis['concepts'] = _labels(analysis.get('concepts'))
      analysis['formulas'] = _labels(analysis.get('formulas'))
      analysis['model'] = model
      analysis['method'] = 'llm-page-knowledge-extraction'
      return analysis
    except (requests.RequestException, KeyError, ValueError, ValidationError, json.JSONDecodeError):
      # A graph enrichment outage must never make a successfully indexed PDF unavailable.
      return fallback

  @staticmethod
  def _fallback(page: dict[str, Any]) -> dict[str, Any]:
    title = str(page.get('title') or '').strip()
    chapter = str(page.get('chapter') or '').strip()
    section = str(page.get('section') or '').strip()
    concepts = _labels([section, title])
    content = str(page.get('content') or '')
    formulas = _labels(re.findall(r'[^\n]{0,80}(?:=|≈|≡|∂|∫|∑|√)[^\n]{0,80}', content))
    return {
      'concepts': concepts,
      'formulas': formulas,
      'chapter': chapter,
      'section': section,
      'is_summary_or_directory': False,
      'method': 'document-metadata-fallback',
    }


class Neo4jGraphStore:
  """Minimal Neo4j 5+ store. It intentionally does not require APOC or vectors."""

  def __init__(self, config: dict[str, Any] | None = None) -> None:
    self._provided_config = config
    self.uri = ''
    self.username = ''
    self.password = ''
    self.database = 'neo4j'
    self.enabled = False
    self._signature: tuple[str, str, str, str, bool] | None = None
    self._driver: Any = None
    self._refresh_config()

  def _refresh_config(self) -> None:
    config = self._provided_config or load_api_config() or {}
    values = (
      str(config.get('neo4jUri') or '').strip(),
      str(config.get('neo4jUsername') or '').strip(),
      str(config.get('neo4jPassword') or '').strip(),
      str(config.get('neo4jDatabase') or 'neo4j').strip() or 'neo4j',
      bool(config.get('neo4jEnabled')),
    )
    if self._signature is not None and values != self._signature:
      self.close()
    self.uri, self.username, self.password, self.database, self.enabled = values
    self._signature = values

  def _driver_or_raise(self):
    self._refresh_config()
    if not self.enabled:
      raise GraphUnavailable('Neo4j graph is disabled in API configuration.')
    if not self.uri or not self.username or not self.password:
      raise GraphUnavailable('Configure Neo4j URI, username, and password before building the graph.')
    if self._driver is None:
      try:
        from neo4j import GraphDatabase
      except ImportError as exc:
        raise GraphUnavailable('The neo4j Python package is not installed.') from exc
      self._driver = GraphDatabase.driver(self.uri, auth=(self.username, self.password))
      try:
        self._driver.verify_connectivity()
      except Exception as exc:  # noqa: BLE001
        self.close()
        raise GraphUnavailable(f'Unable to connect to Neo4j: {exc}') from exc
      self._ensure_schema()
    return self._driver

  def available(self) -> None:
    """Validate configuration before an LLM page analysis is allowed to start."""
    self._driver_or_raise()

  def _execute(self, query: str, **parameters: Any) -> list[dict[str, Any]]:
    driver = self._driver_or_raise()
    with driver.session(database=self.database) as session:
      return [record.data() for record in session.run(query, **parameters)]

  def _ensure_schema(self) -> None:
    constraints = (
      'CREATE CONSTRAINT course_id_unique IF NOT EXISTS FOR (n:Course) REQUIRE n.course_id IS UNIQUE',
      'CREATE CONSTRAINT document_id_unique IF NOT EXISTS FOR (n:Document) REQUIRE n.document_id IS UNIQUE',
      'CREATE CONSTRAINT page_id_unique IF NOT EXISTS FOR (n:DocumentPage) REQUIRE n.page_id IS UNIQUE',
      'CREATE CONSTRAINT question_id_unique IF NOT EXISTS FOR (n:Question) REQUIRE n.question_id IS UNIQUE',
      'CREATE CONSTRAINT chapter_id_unique IF NOT EXISTS FOR (n:Chapter) REQUIRE n.chapter_id IS UNIQUE',
      'CREATE CONSTRAINT concept_id_unique IF NOT EXISTS FOR (n:Concept) REQUIRE n.concept_id IS UNIQUE',
      'CREATE CONSTRAINT formula_id_unique IF NOT EXISTS FOR (n:Formula) REQUIRE n.formula_id IS UNIQUE',
      'CREATE CONSTRAINT teacher_statement_id_unique IF NOT EXISTS FOR (n:TeacherStatement) REQUIRE n.statement_id IS UNIQUE',
    )
    driver = self._driver
    with driver.session(database=self.database) as session:
      for query in constraints:
        session.run(query).consume()

  def upsert_lecture(self, document: dict[str, Any], pages: list[dict[str, Any]], page_analyses: dict[str, dict[str, Any]]) -> None:
    course_id = str(document['course_id'])
    rows = []
    for page in pages:
      page_id = str(page.get('page_id') or '')
      if not page_id:
        continue
      analysis = page_analyses.get(page_id, {})
      chapter = str(analysis.get('chapter') or page.get('chapter') or '').strip()
      rows.append({
        'page': {
          'page_id': page_id, 'document_id': document['document_id'], 'course_id': course_id,
          'page_number': int(page.get('page_number') or 0), 'title': str(page.get('title') or ''),
          'section': str(analysis.get('section') or page.get('section') or ''),
          'content': str(page.get('content') or ''), 'metadata': json.dumps(page.get('metadata') or {}, ensure_ascii=False),
          'is_summary_or_directory': bool(analysis.get('is_summary_or_directory')),
        },
        'chapter': self._entity(course_id, 'chapter', chapter),
        'concepts': [self._entity(course_id, 'concept', item) for item in _labels(analysis.get('concepts'))],
        'formulas': [self._entity(course_id, 'formula', item) for item in _labels(analysis.get('formulas'))],
      })
    self._execute(
      '''MERGE (course:Course {course_id: $document.course_id}) SET course.name = $document.course_id
         MERGE (document:Document {document_id: $document.document_id})
         SET document += $document
         MERGE (course)-[:HAS_DOCUMENT]->(document)
         WITH document, course, $rows AS rows
         UNWIND rows AS row
         MERGE (page:DocumentPage {page_id: row.page.page_id}) SET page += row.page
         MERGE (document)-[:HAS_PAGE]->(page)
         FOREACH (_ IN CASE WHEN row.chapter IS NULL THEN [] ELSE [1] END |
           MERGE (chapter:Chapter {chapter_id: row.chapter.id}) SET chapter += row.chapter
           MERGE (course)-[:HAS_CHAPTER]->(chapter)
           MERGE (chapter)-[:HAS_PAGE]->(page))
         FOREACH (conceptRow IN row.concepts |
           MERGE (concept:Concept {concept_id: conceptRow.id}) SET concept += conceptRow
           MERGE (page)-[:MENTIONS]->(concept))
         FOREACH (formulaRow IN row.formulas |
           MERGE (formula:Formula {formula_id: formulaRow.id}) SET formula += formulaRow
           MERGE (page)-[:USES_FORMULA]->(formula))''',
      document={
        'document_id': str(document['document_id']), 'course_id': course_id,
        'document_name': str(document.get('document_name') or ''), 'document_type': str(document.get('document_type') or 'lecture'),
      }, rows=rows,
    )

  def upsert_questions(self, document: dict[str, Any], questions: list[dict[str, Any]], relation_records: dict[str, dict[str, Any]]) -> None:
    course_id = str(document['course_id'])
    rows = []
    for question in questions:
      analysis = question.get('analysis') if isinstance(question.get('analysis'), dict) else {}
      question_id = str(question.get('question_id') or '')
      if not question_id:
        continue
      chapter = self._entity(course_id, 'chapter', str(analysis.get('chapter') or ''))
      concepts = _labels((analysis.get('knowledge_points') or []) + (analysis.get('prerequisites') or []))
      rows.append({
        'question': {
          'question_id': question_id, 'document_id': str(document['document_id']), 'course_id': course_id,
          'question_index': int(question.get('index') or 0), 'page_number': int(question.get('page_number') or 0),
          'title': str(question.get('title') or ''), 'content': str(question.get('content') or ''),
          'question_type': str(analysis.get('question_type') or ''), 'summary': str(analysis.get('summary') or ''),
          'difficulty_level': int((analysis.get('difficulty') or {}).get('level') or 0),
        },
        'chapter': chapter,
        'concepts': [self._entity(course_id, 'concept', item) for item in concepts],
        'formulas': [self._entity(course_id, 'formula', item) for item in _labels(analysis.get('formulas'))],
        'prerequisites': [self._entity(course_id, 'concept', item) for item in _labels(analysis.get('prerequisites'))],
        'relations': self._relation_rows(question_id, relation_records.get(question_id, {})),
      })
    self._execute(
      '''MERGE (course:Course {course_id: $document.course_id}) SET course.name = $document.course_id
         MERGE (document:Document {document_id: $document.document_id}) SET document += $document
         MERGE (course)-[:HAS_DOCUMENT]->(document)
         WITH document, course, $rows AS rows
         UNWIND rows AS row
         MERGE (question:Question {question_id: row.question.question_id}) SET question += row.question
         MERGE (document)-[:HAS_QUESTION]->(question)
         FOREACH (_ IN CASE WHEN row.chapter IS NULL THEN [] ELSE [1] END |
           MERGE (chapter:Chapter {chapter_id: row.chapter.id}) SET chapter += row.chapter
           MERGE (course)-[:HAS_CHAPTER]->(chapter)
           MERGE (question)-[:BELONGS_TO]->(chapter))
         FOREACH (conceptRow IN row.concepts |
           MERGE (concept:Concept {concept_id: conceptRow.id}) SET concept += conceptRow
           MERGE (question)-[:TESTS]->(concept))
         FOREACH (formulaRow IN row.formulas |
           MERGE (formula:Formula {formula_id: formulaRow.id}) SET formula += formulaRow
           MERGE (question)-[:USES_FORMULA]->(formula))
         FOREACH (prerequisiteRow IN row.prerequisites |
           MERGE (concept:Concept {concept_id: prerequisiteRow.id}) SET concept += prerequisiteRow
           MERGE (question)-[:REQUIRES]->(concept))
         FOREACH (relationRow IN row.relations |
           FOREACH (_ IN CASE WHEN relationRow.target_kind = 'page' THEN [1] ELSE [] END |
             MERGE (target:DocumentPage {page_id: relationRow.target_id})
             MERGE (question)-[link:RELATED_TO_PAGE]->(target) SET link += relationRow.properties)
           FOREACH (_ IN CASE WHEN relationRow.target_kind = 'question' THEN [1] ELSE [] END |
             MERGE (target:Question {question_id: relationRow.target_id})
             MERGE (question)-[link:RELATED_TO_QUESTION]->(target) SET link += relationRow.properties))''',
      document={
        'document_id': str(document['document_id']), 'course_id': course_id,
        'document_name': str(document.get('document_name') or ''), 'document_type': str(document.get('document_type') or ''),
      }, rows=rows,
    )

  def upsert_teacher_statements(self, course_id: str, statements: list[dict[str, Any]]) -> None:
    rows = []
    for index, statement in enumerate(statements, start=1):
      text = str(statement.get('text') or statement.get('polishedText') or '').strip()
      if not text:
        continue
      statement_id = str(statement.get('statement_id') or statement.get('id') or _stable_id('teacher-statement', course_id, f'{index}:{text}'))
      page_ids = [str(page_id) for page_id in statement.get('page_ids', []) if str(page_id).strip()]
      if not page_ids:
        document_id = str(statement.get('document_id') or '').strip()
        page_ids = [f'{document_id}:page:{int(number)}' for number in statement.get('page_numbers', []) if document_id and int(number) > 0]
      rows.append({
        'statement': {
          'statement_id': statement_id, 'course_id': course_id, 'text': text,
          'start_seconds': statement.get('start_seconds', statement.get('startSeconds')),
          'end_seconds': statement.get('end_seconds', statement.get('endSeconds')),
          'source_sentence_ids': list(statement.get('source_sentence_ids') or statement.get('sourceSentenceIds') or []),
        },
        'page_ids': page_ids,
        'concepts': [self._entity(course_id, 'concept', item) for item in _labels(statement.get('concepts') or [])],
      })
    self._execute(
      '''MERGE (course:Course {course_id: $course_id}) SET course.name = $course_id
         WITH course, $rows AS rows
         UNWIND rows AS row
         MERGE (statement:TeacherStatement {statement_id: row.statement.statement_id}) SET statement += row.statement
         MERGE (course)-[:HAS_TEACHER_STATEMENT]->(statement)
         FOREACH (pageId IN row.page_ids |
           MERGE (page:DocumentPage {page_id: pageId})
           MERGE (statement)-[:EXPLAINS]->(page))
         FOREACH (conceptRow IN row.concepts |
           MERGE (concept:Concept {concept_id: conceptRow.id}) SET concept += conceptRow
           MERGE (statement)-[:EXPLAINS_CONCEPT]->(concept))''', course_id=course_id, rows=rows)

  @staticmethod
  def _entity(course_id: str, kind: str, name: str) -> dict[str, str] | None:
    clean = re.sub(r'\s+', ' ', name).strip()
    if not clean:
      return None
    return {'id': _stable_id(kind, course_id, clean), f'{kind}_id': _stable_id(kind, course_id, clean), 'course_id': course_id, 'name': clean}

  @staticmethod
  def _relation_rows(question_id: str, record: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for relation in record.get('relations') if isinstance(record.get('relations'), list) else []:
      if not isinstance(relation, dict):
        continue
      target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
      relation_type = str(relation.get('relation_type') or '')
      if relation_type == 'question_to_lecture_page':
        target_id = str(target.get('page_id') or '')
        if not target_id:
          document_id = str(target.get('document_id') or '')
          page_number = int(target.get('page_number') or 0)
          target_id = f'{document_id}:page:{page_number}' if document_id and page_number else ''
        target_kind = 'page'
      elif relation_type in {'question_to_assignment_question', 'question_to_past_exam_question'}:
        target_id, target_kind = str(target.get('question_id') or ''), 'question'
      else:
        continue
      if not target_id:
        continue
      rows.append({
        'target_kind': target_kind, 'target_id': target_id,
        'properties': {
          'source_question_id': question_id, 'relation_type': relation_type,
          'source': str(relation.get('source') or ''),
          'vector_score': float(relation.get('vector_score') or 0),
          'rerank_score': float(relation.get('rerank_score') or 0),
          'confidence': float(relation.get('confidence') or 0),
          'updated_at': time.time(),
        },
      })
    return rows

  def delete_document(self, document_id: str) -> None:
    self._execute(
      '''MATCH (document:Document {document_id: $document_id})
         OPTIONAL MATCH (document)-[:HAS_PAGE|HAS_QUESTION]->(child)
         DETACH DELETE document, child
         WITH 1 AS ignored
         MATCH (node) WHERE (node:Chapter OR node:Concept OR node:Formula)
           AND NOT (node)--()
         DELETE node''', document_id=document_id)

  def overview(self, course_id: str) -> dict[str, Any]:
    rows = self._execute(
      '''MATCH (course:Course {course_id: $course_id})
         OPTIONAL MATCH (course)-[:HAS_CHAPTER]->(chapter:Chapter)
         OPTIONAL MATCH (chapter)<-[:BELONGS_TO]-(question:Question)
         OPTIONAL MATCH (chapter)-[:HAS_PAGE]->(page:DocumentPage)
         RETURN course.course_id AS course_id, collect(DISTINCT {name: chapter.name, id: chapter.chapter_id}) AS chapters,
                count(DISTINCT question) AS question_count, count(DISTINCT page) AS page_count''', course_id=course_id)
    return rows[0] if rows else {'course_id': course_id, 'chapters': [], 'question_count': 0, 'page_count': 0}

  def close(self) -> None:
    if self._driver is not None:
      self._driver.close()
      self._driver = None


class KnowledgeGraphPipeline:
  """Consumes persisted pipeline artifacts; it never calls MinerU or Qdrant."""

  def __init__(self, store: GraphStore | None = None, extractor: PageKnowledgeExtractor | None = None) -> None:
    self.store = store or Neo4jGraphStore()
    self.extractor = extractor or PageKnowledgeExtractor()

  def _dir(self, document_id: str) -> Path:
    return GRAPH_DOCUMENTS_ROOT / _safe_name(document_id)

  def status(self, document_id: str) -> dict[str, Any]:
    state = _read_json(self._dir(document_id) / 'state.json', {})
    if not state:
      raise HTTPException(status_code=404, detail='Knowledge graph job not found.')
    return state

  def sync_document(self, document_id: str) -> dict[str, Any]:
    lecture_dir = DOCUMENTS_ROOT / _safe_name(document_id)
    question_dir = QUESTION_DOCUMENTS_ROOT / _safe_name(document_id)
    if (lecture_dir / 'state.json').is_file():
      return self._sync_lecture(lecture_dir)
    if (question_dir / 'state.json').is_file():
      return self._sync_questions(question_dir)
    raise HTTPException(status_code=404, detail='Document pipeline artifact not found for graph sync.')

  def sync_course(self, course_id: str) -> dict[str, Any]:
    results = []
    for root in (DOCUMENTS_ROOT, QUESTION_DOCUMENTS_ROOT):
      if not root.is_dir():
        continue
      for directory in root.iterdir():
        state = _read_json(directory / 'state.json', {})
        if state.get('course_id') == course_id and state.get('status') == 'completed':
          results.append(self.sync_document(str(state.get('document_id') or directory.name)))
    return {'course_id': course_id, 'document_count': len(results), 'documents': results}

  def delete_document(self, document_id: str) -> None:
    try:
      self.store.delete_document(document_id)
    except GraphUnavailable:
      # There is no remote graph to clean, but retaining the local state would be misleading.
      pass
    graph_dir = self._dir(document_id)
    if graph_dir.is_dir():
      import shutil
      shutil.rmtree(graph_dir)

  def overview(self, course_id: str) -> dict[str, Any]:
    try:
      return self.store.overview(course_id)
    except GraphUnavailable as exc:
      return {'course_id': course_id, 'status': 'disabled', 'reason': str(exc), 'chapters': []}

  def sync_teacher_statements(self, course_id: str, statements: list[dict[str, Any]]) -> dict[str, Any]:
    try:
      self._require_store_available()
      self.store.upsert_teacher_statements(course_id, statements)
      return {'course_id': course_id, 'statement_count': len(statements), 'status': 'completed'}
    except GraphUnavailable as exc:
      return {'course_id': course_id, 'statement_count': 0, 'status': 'disabled', 'error': str(exc)}

  def close(self) -> None:
    self.store.close()

  def _sync_lecture(self, directory: Path) -> dict[str, Any]:
    state = _read_json(directory / 'state.json', {})
    document_id = str(state.get('document_id') or directory.name)
    graph_state = self._base_state(state, document_id)
    if state.get('status') != 'completed':
      return self._save_state(graph_state | {'status': 'waiting_for_document'})
    try:
      self._require_store_available()
      pages_path = directory / 'pages.json'
      pages = json.loads(pages_path.read_text(encoding='utf-8')) if pages_path.is_file() else []
      if not isinstance(pages, list):
        raise HTTPException(status_code=422, detail='Lecture pages artifact is invalid.')
      analyses_path = self._dir(document_id) / 'page-analyses.json'
      analyses = json.loads(analyses_path.read_text(encoding='utf-8')) if analyses_path.is_file() else {}
      if not isinstance(analyses, dict):
        analyses = {}
      for page in pages:
        page_id = str(page.get('page_id') or '')
        if page_id and page_id not in analyses:
          analyses[page_id] = self.extractor.analyze(page)
          _write_json(analyses_path, analyses)
      self.store.upsert_lecture(state, pages, analyses)
      return self._save_state(graph_state | {
        'status': 'completed', 'page_count': len(pages), 'analyzed_page_count': len(analyses),
        'updated_at': time.time(), 'error': '',
      })
    except GraphUnavailable as exc:
      return self._save_state(graph_state | {'status': 'disabled', 'error': str(exc), 'updated_at': time.time()})
    except Exception as exc:  # noqa: BLE001
      return self._save_state(graph_state | {'status': 'failed', 'error': str(exc), 'updated_at': time.time()})

  def _sync_questions(self, directory: Path) -> dict[str, Any]:
    state = _read_json(directory / 'state.json', {})
    document_id = str(state.get('document_id') or directory.name)
    graph_state = self._base_state(state, document_id)
    if state.get('status') != 'completed':
      return self._save_state(graph_state | {'status': 'waiting_for_document'})
    try:
      self._require_store_available()
      questions_path = directory / 'questions.json'
      questions = json.loads(questions_path.read_text(encoding='utf-8')) if questions_path.is_file() else []
      records = {
        str(question.get('question_id')): _read_json(RELATIONS_DIR / f"{_safe_name(str(question.get('question_id')))}.json", {})
        for question in questions if isinstance(question, dict) and question.get('question_id')
      }
      self.store.upsert_questions(state, questions, records)
      return self._save_state(graph_state | {
        'status': 'completed', 'question_count': len(questions), 'updated_at': time.time(), 'error': '',
      })
    except GraphUnavailable as exc:
      return self._save_state(graph_state | {'status': 'disabled', 'error': str(exc), 'updated_at': time.time()})
    except Exception as exc:  # noqa: BLE001
      return self._save_state(graph_state | {'status': 'failed', 'error': str(exc), 'updated_at': time.time()})

  @staticmethod
  def _base_state(document: dict[str, Any], document_id: str) -> dict[str, Any]:
    return {
      'version': GRAPH_VERSION, 'document_id': document_id,
      'course_id': str(document.get('course_id') or ''),
      'document_name': str(document.get('document_name') or ''),
      'document_type': str(document.get('document_type') or ''),
      'updated_at': time.time(),
    }

  def _save_state(self, state: dict[str, Any]) -> dict[str, Any]:
    _write_json(self._dir(str(state['document_id'])) / 'state.json', state)
    return state

  def _require_store_available(self) -> None:
    check = getattr(self.store, 'available', None)
    if callable(check):
      check()
