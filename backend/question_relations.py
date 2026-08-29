from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock
from typing import Any, Literal

import requests
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import PROJECT_ROOT
from .document_pipeline import (
  ApiEmbeddingProvider,
  DOCUMENTS_ROOT,
  QDRANT_COLLECTION,
  QdrantVectorStore,
)
from .question_pipeline import (
  QUESTION_COLLECTION,
  QUESTION_DOCUMENTS_ROOT,
  build_question_retrieval_text,
)
from .knowledge_storage import read_knowledge_library
from .runtime_config import load_api_config

QUESTION_RELATIONS_ROOT = PROJECT_ROOT / '.runtime' / 'question-relations'
RELATION_CONFIG_PATH = QUESTION_RELATIONS_ROOT / 'config.json'
RELATIONS_DIR = QUESTION_RELATIONS_ROOT / 'relations'
DOCUMENT_INDEX_DIR = QUESTION_RELATIONS_ROOT / 'documents'
JSON_WRITE_RETRY_COUNT = 6
JSON_WRITE_RETRY_SECONDS = 0.1
_JSON_WRITE_LOCKS: dict[Path, Lock] = {}
_JSON_WRITE_LOCKS_GUARD = Lock()
_RELATION_RUN_LOCKS: dict[str, Lock] = {}
_RELATION_RUN_LOCKS_GUARD = Lock()

DEFAULT_RELATION_CONFIG: dict[str, Any] = {
  'retrieval_top_n': 20,
  'rerank_top_k': 20,
  'rerank_batch_size': 10,
  'rerank_max_text_chars': 4000,
  'min_rerank_score': 0.5,
  'include_same_document_questions': False,
  'ai_verification_enabled': True,
  'ai_verification_min_confidence': 0.45,
  'ai_verification_max_candidates': 20,
  'ai_verification_concurrency': 4,
  'ai_verification_max_page_chars': 7000,
}

_TARGETS = (
  ('lecture', QDRANT_COLLECTION, ('lecture',), 'question_to_lecture_page'),
  ('assignment', QUESTION_COLLECTION, ('homework', 'exercise-set'), 'question_to_assignment_question'),
  ('past_exam', QUESTION_COLLECTION, ('past-exam',), 'question_to_past_exam_question'),
)


def _safe_name(value: str) -> str:
  return re.sub(r'[^A-Za-z0-9._-]+', '-', value).strip('.-') or 'unknown'


def _document_name_key(value: Any) -> str:
  """Match the same uploaded source even if it was indexed under an older ID."""
  name = Path(str(value or '').strip()).stem
  return re.sub(r'\s+', '', name).casefold()


def _truncate_for_rerank(value: Any, max_chars: int) -> str:
  text = str(value or '').strip()
  if len(text) <= max_chars:
    return text
  head_length = max(1, int(max_chars * 0.7))
  tail_length = max(1, max_chars - head_length - 17)
  return f'{text[:head_length]}\n...[truncated]...\n{text[-tail_length:]}'


def _write_json(path: Path, value: Any) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  target = path.resolve()
  serialized = json.dumps(value, ensure_ascii=False, indent=2)
  with _json_write_lock(target):
    last_error: PermissionError | None = None
    for attempt in range(JSON_WRITE_RETRY_COUNT):
      temporary = target.with_name(f'.{target.name}.{uuid.uuid4().hex}.tmp')
      try:
        temporary.write_text(serialized, encoding='utf-8')
        os.replace(temporary, target)
        return
      except PermissionError as exc:
        last_error = exc
        if attempt + 1 < JSON_WRITE_RETRY_COUNT:
          time.sleep(JSON_WRITE_RETRY_SECONDS * (attempt + 1))
      finally:
        try:
          temporary.unlink(missing_ok=True)
        except OSError:
          pass
    if last_error is not None:
      raise last_error


def _json_write_lock(path: Path) -> Lock:
  with _JSON_WRITE_LOCKS_GUARD:
    return _JSON_WRITE_LOCKS.setdefault(path, Lock())


def _relation_run_lock(question_id: str) -> Lock:
  with _RELATION_RUN_LOCKS_GUARD:
    return _RELATION_RUN_LOCKS.setdefault(question_id, Lock())


def _read_json(path: Path, fallback: Any) -> Any:
  if not path.is_file():
    return fallback
  try:
    value = json.loads(path.read_text(encoding='utf-8'))
  except (OSError, json.JSONDecodeError):
    return fallback
  return value


def _clamp_int(value: Any, default: int, lower: int, upper: int) -> int:
  try:
    return max(lower, min(int(value), upper))
  except (TypeError, ValueError):
    return default


def _clamp_float(value: Any, default: float, lower: float, upper: float) -> float:
  try:
    return max(lower, min(float(value), upper))
  except (TypeError, ValueError):
    return default


def normalize_relation_config(payload: dict[str, Any] | None) -> dict[str, Any]:
  payload = payload or {}
  top_n = _clamp_int(payload.get('retrieval_top_n'), DEFAULT_RELATION_CONFIG['retrieval_top_n'], 1, 100)
  return {
    'retrieval_top_n': top_n,
    # Score every retrieved candidate; the score threshold decides which relations survive.
    'rerank_top_k': top_n,
    'rerank_batch_size': _clamp_int(
      payload.get('rerank_batch_size'),
      DEFAULT_RELATION_CONFIG['rerank_batch_size'],
      1,
      top_n,
    ),
    'rerank_max_text_chars': _clamp_int(
      payload.get('rerank_max_text_chars'),
      DEFAULT_RELATION_CONFIG['rerank_max_text_chars'],
      256,
      50000,
    ),
    'min_rerank_score': _clamp_float(payload.get('min_rerank_score'), DEFAULT_RELATION_CONFIG['min_rerank_score'], -1.0, 1.0),
    'include_same_document_questions': bool(payload.get('include_same_document_questions', False)),
    'ai_verification_enabled': bool(payload.get('ai_verification_enabled', True)),
    'ai_verification_min_confidence': _clamp_float(
      payload.get('ai_verification_min_confidence'),
      DEFAULT_RELATION_CONFIG['ai_verification_min_confidence'],
      0.0,
      1.0,
    ),
    'ai_verification_max_candidates': _clamp_int(
      payload.get('ai_verification_max_candidates'),
      DEFAULT_RELATION_CONFIG['ai_verification_max_candidates'],
      1,
      top_n,
    ),
    'ai_verification_concurrency': _clamp_int(
      payload.get('ai_verification_concurrency'),
      DEFAULT_RELATION_CONFIG['ai_verification_concurrency'],
      1,
      8,
    ),
    'ai_verification_max_page_chars': _clamp_int(
      payload.get('ai_verification_max_page_chars'),
      DEFAULT_RELATION_CONFIG['ai_verification_max_page_chars'],
      1000,
      30000,
    ),
  }


class LectureRelationVerification(BaseModel):
  """Strict decision made by the configured text model for one lecture page."""

  model_config = ConfigDict(extra='forbid')
  related: bool
  confidence: float = Field(ge=0.0, le=1.0)
  page_role: Literal[
    'cover',
    'table_of_contents',
    'chapter_title',
    'summary',
    'concept',
    'derivation',
    'worked_example',
    'exercise',
    'other',
  ]
  reason: str = Field(max_length=600)
  concrete_evidence: list[str] = Field(default_factory=list, max_length=8)


class AiLectureRelationVerifier:
  """Uses the configured text-processing model as the final lecture-page gate."""

  _FIELDS = set(LectureRelationVerification.model_fields)

  @staticmethod
  def _extract_json_object(content: str) -> dict[str, Any]:
    cleaned = content.strip()
    if cleaned.startswith('```'):
      cleaned = re.sub(r'^```(?:json)?\s*|\s*```$', '', cleaned, flags=re.IGNORECASE).strip()
    decoder = json.JSONDecoder()
    for match in re.finditer(r'\{', cleaned):
      try:
        value, _ = decoder.raw_decode(cleaned[match.start():])
      except json.JSONDecodeError:
        continue
      if isinstance(value, dict):
        return value
    raise ValueError('Text model response does not contain a JSON object.')

  @classmethod
  def _validate_content(cls, content: str) -> LectureRelationVerification:
    payload = cls._extract_json_object(content)
    for wrapper in ('verification', 'result', 'data'):
      wrapped = payload.get(wrapper)
      if isinstance(wrapped, dict) and not cls._FIELDS.intersection(payload):
        payload = wrapped
        break
    if 'related' not in payload and 'relevant' in payload:
      payload['related'] = payload.get('relevant')
    normalized = {key: value for key, value in payload.items() if key in cls._FIELDS}
    evidence = normalized.get('concrete_evidence')
    if isinstance(evidence, str):
      normalized['concrete_evidence'] = [evidence] if evidence.strip() else []
    elif evidence is None:
      normalized['concrete_evidence'] = []
    return LectureRelationVerification.model_validate(normalized)

  @staticmethod
  def _post(root: str, api_key: str, payload: dict[str, Any]) -> requests.Response:
    return requests.post(
      f'{root}/chat/completions',
      headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
      json=payload,
      timeout=120,
    )

  @staticmethod
  def _content(response: requests.Response) -> str:
    return str((((response.json().get('choices') or [{}])[0].get('message') or {}).get('content') or '')).strip()

  def verify(
    self,
    question: dict[str, Any],
    retrieval_query: str,
    page: dict[str, Any],
    *,
    max_page_chars: int,
    expansion_context: dict[str, Any] | None = None,
  ) -> dict[str, Any]:
    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      raise HTTPException(status_code=422, detail='Text model configuration is required for lecture relation verification.')

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = LectureRelationVerification.model_json_schema()
    expected_shape = {
      'related': False,
      'confidence': 0.0,
      'page_role': 'other',
      'reason': '',
      'concrete_evidence': [],
    }
    user_content = {
      'json_schema': schema,
      'required_output_shape': expected_shape,
      'question': {
        'title': question.get('title'),
        'content': question.get('content'),
        'analysis': question.get('analysis'),
        'retrieval_query': retrieval_query,
      },
      'lecture_page': {
        'document_name': page.get('document_name'),
        'page_number': page.get('page_number'),
        'title': page.get('title'),
        'chapter': page.get('chapter'),
        'section': page.get('section'),
        'content': str(page.get('content') or '')[:max_page_chars],
      },
      'expansion_context': expansion_context or {'kind': 'seed'},
    }
    payload = {
      'model': model,
      'temperature': 0,
      'messages': [
        {
          'role': 'system',
          'content': (
            '你是课程题目与讲义页关联审核器，只输出一个符合 JSON Schema 的 JSON 对象。'
            '采用宽松但有实质依据的关联标准：只要题目理解或解答使用了该页的公式、知识点、'
            '定理条件、推导思路、解题方法、先修概念或相似例题中的任意一项，就判定 related=true。'
            '不要求页面覆盖完整答案，也不要求公式或题目表述完全相同；能提供一个可用步骤、'
            '基础关系或解题思路也属于关联。'
            '封面、目录、纯章节标题、总结/回顾页、仅有课程介绍或只有宽泛主题词而没有教学内容的页面'
            '必须判定 related=false。只审核给出的 reranker 候选，不扩展或推荐任何相邻页面。'
            'concrete_evidence 应列出可核对的对应公式、知识点或思路；若页面明显相关但难以逐字摘录，'
            '仍应判定 related=true，并在 reason 中说明对应关系。'
            'confidence 表示关联把握：基础知识或可复用思路通常可为 0.45-0.7，'
            '直接公式或同类例题可为 0.7-1.0。'
          ),
        },
        {'role': 'user', 'content': json.dumps(user_content, ensure_ascii=False)},
      ],
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'lecture_relation_verification', 'strict': True, 'schema': schema},
      },
    }
    response = self._post(root, api_key, payload)
    if response.status_code == 400:
      response = self._post(root, api_key, {**payload, 'response_format': {'type': 'json_object'}})
      if response.status_code == 400:
        response = self._post(root, api_key, {key: value for key, value in payload.items() if key != 'response_format'})
    response.raise_for_status()
    content = self._content(response)
    try:
      decision = self._validate_content(content)
    except (ValidationError, ValueError) as first_error:
      repair_payload = {
        'model': model,
        'temperature': 0,
        'messages': [
          {
            'role': 'system',
            'content': '修复讲义关联审核 JSON。只输出一个符合给定结构的 JSON 对象，不要增加事实。',
          },
          {
            'role': 'user',
            'content': json.dumps({
              'required_output_shape': expected_shape,
              'validation_error': str(first_error),
              'invalid_response': content,
            }, ensure_ascii=False),
          },
        ],
        'response_format': {'type': 'json_object'},
      }
      repair_response = self._post(root, api_key, repair_payload)
      if repair_response.status_code == 400:
        repair_response = self._post(
          root,
          api_key,
          {key: value for key, value in repair_payload.items() if key != 'response_format'},
        )
      repair_response.raise_for_status()
      decision = self._validate_content(self._content(repair_response))
    normalized = decision.model_dump()
    normalized['reason'] = re.sub(r'</?item(?:\s[^>]*)?>', '', normalized['reason'], flags=re.IGNORECASE).strip()
    normalized['concrete_evidence'] = [
      re.sub(r'</?item(?:\s[^>]*)?>', '', item, flags=re.IGNORECASE).strip()
      for item in normalized['concrete_evidence']
      if re.sub(r'</?item(?:\s[^>]*)?>', '', item, flags=re.IGNORECASE).strip()
    ]
    return normalized | {'model': model}


class ApiReranker:
  """Calls the configured reranker and records a transparent vector-only fallback."""

  def rerank(
    self,
    query: str,
    candidates: list[dict[str, Any]],
    top_k: int,
    batch_size: int = 1,
    max_text_chars: int = 4000,
  ) -> tuple[list[dict[str, Any]], str, str | None]:
    if not candidates:
      return [], 'none', None
    config = load_api_config() or {}
    base_url = str(config.get('rerankBaseUrl') or config.get('baseUrl') or '').strip().rstrip('/')
    api_key = str(config.get('rerankApiKey') or config.get('apiKey') or '').strip()
    model = str(config.get('rerankModel') or '').strip()
    if not base_url or not api_key or not model:
      return self._vector_only(candidates, top_k), 'vector-only', 'Reranker API is not configured.'

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url)
    resolved: list[dict[str, Any]] = []
    errors: list[str] = []
    successful_batches = 0
    batch_size = max(1, min(int(batch_size), len(candidates)))
    safe_query = _truncate_for_rerank(query, max_text_chars)
    for start in range(0, len(candidates), batch_size):
      batch = candidates[start:start + batch_size]
      try:
        response = requests.post(
          f'{root}/rerank',
          headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
          json={
            'model': model,
            'query': safe_query,
            'documents': [_truncate_for_rerank(item['content'], max_text_chars) for item in batch],
            'top_n': len(batch),
          },
          timeout=120,
        )
        if not response.ok:
          detail = response.text.strip().replace('\n', ' ')[:500]
          raise RuntimeError(f'HTTP {response.status_code}: {detail or response.reason}')
        payload = response.json()
        ranked = payload.get('results') if isinstance(payload, dict) else None
        if not isinstance(ranked, list) and isinstance(payload, dict):
          ranked = payload.get('data')
        if not isinstance(ranked, list):
          raise ValueError('Reranker response does not contain results.')
        batch_resolved: list[dict[str, Any]] = []
        for item in ranked:
          if not isinstance(item, dict):
            continue
          index = int(item.get('index', -1))
          if index < 0 or index >= len(batch):
            continue
          score = float(item.get('relevance_score', item.get('score', batch[index]['vector_score'])))
          batch_resolved.append(batch[index] | {'rerank_score': score})
        if not batch_resolved:
          raise ValueError('Reranker returned no usable candidates.')
        resolved.extend(batch_resolved)
        successful_batches += 1
      except Exception as exc:  # noqa: BLE001
        errors.append(f'batch {start // batch_size + 1}: {exc}')
        resolved.extend(self._vector_only(batch, len(batch)))

    resolved.sort(key=lambda item: float(item['rerank_score']), reverse=True)
    if successful_batches == len(range(0, len(candidates), batch_size)):
      source = 'reranker'
    elif successful_batches:
      source = 'reranker-partial'
    else:
      source = 'vector-only'
    return resolved[:top_k], source, '; '.join(errors) or None

  @staticmethod
  def _vector_only(candidates: list[dict[str, Any]], top_k: int) -> list[dict[str, Any]]:
    return [item | {'rerank_score': float(item['vector_score'])} for item in candidates[:top_k]]


class QuestionRelationPipeline:
  """Associates one analyzed question with course material without reprocessing documents."""

  def __init__(
    self,
    embedding: ApiEmbeddingProvider | None = None,
    vector_store: QdrantVectorStore | None = None,
    reranker: ApiReranker | None = None,
    verifier: AiLectureRelationVerifier | None = None,
    root: Path = QUESTION_RELATIONS_ROOT,
    question_documents_root: Path = QUESTION_DOCUMENTS_ROOT,
    lecture_documents_root: Path = DOCUMENTS_ROOT,
  ) -> None:
    self.embedding = embedding or ApiEmbeddingProvider()
    self.vector_store = vector_store or QdrantVectorStore()
    self.reranker = reranker or ApiReranker()
    self.verifier = verifier or AiLectureRelationVerifier()
    self.root = root
    self.config_path = root / 'config.json'
    self.relations_dir = root / 'relations'
    self.document_index_dir = root / 'documents'
    self.lecture_page_index_dir = root / 'lecture-pages'
    self.question_reverse_index_dir = root / 'question-targets'
    self.question_documents_root = question_documents_root
    self.lecture_documents_root = lecture_documents_root

  def config(self) -> dict[str, Any]:
    return normalize_relation_config(_read_json(self.config_path, DEFAULT_RELATION_CONFIG))

  def update_config(self, payload: dict[str, Any]) -> dict[str, Any]:
    config = normalize_relation_config(payload)
    _write_json(self.config_path, config)
    return config

  def build_retrieval_query(self, question: dict[str, Any]) -> str:
    return build_question_retrieval_text(question)

  def link_question(self, question: dict[str, Any], document: dict[str, Any]) -> dict[str, Any]:
    question_id = str(question.get('question_id') or '').strip()
    with _relation_run_lock(question_id or 'unknown'):
      return self._link_question_unlocked(question, document)

  def _link_question_unlocked(self, question: dict[str, Any], document: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(question.get('analysis'), dict):
      raise HTTPException(status_code=422, detail='Question analysis is required before creating relations.')
    question_id = str(question.get('question_id') or '').strip()
    course_id = str(document.get('course_id') or '').strip()
    document_id = str(document.get('document_id') or '').strip()
    if not question_id or not course_id or not document_id:
      raise HTTPException(status_code=422, detail='question_id, course_id, and document_id are required.')

    config = self.config()
    query = self.build_retrieval_query(question)
    vector = self.embedding.embed([query])[0]
    target_runs: list[dict[str, Any]] = []
    relations: list[dict[str, Any]] = []
    source_document_type = str(document.get('document_type') or '').strip()
    targets = (
      tuple(target for target in _TARGETS if target[0] != 'past_exam')
      if source_document_type in {'homework', 'exercise-set'}
      else _TARGETS
    )
    # Question-to-question links are inexpensive and should become visible
    # before the slower per-page lecture verification finishes.
    targets = tuple(sorted(targets, key=lambda target: target[0] == 'lecture'))
    record_path = self.relations_dir / f'{_safe_name(question_id)}.json'
    previous_record = _read_json(record_path, {})
    record = {
      'version': 2,
      'generated_at': time.time(),
      'question_id': question_id,
      'question_document_id': document_id,
      'question_document_name': str(document.get('document_name') or ''),
      'course_id': course_id,
      'question_page_number': int(question.get('page_number') or 0),
      'retrieval_query': query,
      'settings': config,
      'status': 'processing',
      'current_target': None,
      'relations': relations,
      'runs': target_runs,
    }
    _write_json(record_path, record)
    # A retry replaces the authoritative relation set immediately. Remove the
    # previous reverse-page entries now so an interrupted retry cannot leave
    # stale lecture cards behind.
    self._sync_lecture_page_indexes(previous_record, record)
    self._sync_question_reverse_indexes(previous_record, record)
    for target_name, collection, document_types, relation_type in targets:
      record['current_target'] = target_name
      record['generated_at'] = time.time()
      _write_json(record_path, record)
      candidates: list[dict[str, Any]] = []
      retrieval_errors: list[str] = []
      for document_type in document_types:
        found, retrieval_error = self._retrieve_candidates(
          vector=vector,
          course_id=course_id,
          collection=collection,
          document_type=document_type,
          question_id=question_id,
          source_document_id=document_id,
          source_document_name=str(document.get('document_name') or ''),
          config=config,
        )
        candidates.extend(found)
        if retrieval_error:
          retrieval_errors.append(retrieval_error)
      candidates.sort(key=lambda item: float(item['vector_score']), reverse=True)
      candidates = candidates[:config['retrieval_top_n']]
      reranked, rerank_source, rerank_error = self.reranker.rerank(
        query,
        candidates,
        config['rerank_top_k'],
        config['rerank_batch_size'],
        config['rerank_max_text_chars'],
      )
      final = self._deduplicate_targets(reranked, target_name)
      accepted = [item for item in final if float(item['rerank_score']) >= config['min_rerank_score']]
      verification_records: list[dict[str, Any]] = []
      if target_name == 'lecture' and config['ai_verification_enabled']:
        accepted, verification_records = self._verify_lecture_candidates(
          question=question,
          query=query,
          candidates=accepted[:config['ai_verification_max_candidates']],
          config=config,
        )
      target_runs.append({
        'target': target_name,
        'collection': collection,
        'document_type_filter': list(document_types),
        'retrieval_error': '; '.join(retrieval_errors) or None,
        'rerank_source': rerank_source,
        'rerank_error': rerank_error,
        'retrieved_candidates': candidates,
        'reranked_candidates': reranked,
        'ai_verification': verification_records,
      })
      relations.extend(
        self._to_relation(
          item,
          question_id,
          relation_type,
          str(item.get('relation_source') or rerank_source),
        )
        for item in accepted
      )
      record['generated_at'] = time.time()
      _write_json(record_path, record)
      self._sync_question_reverse_indexes(previous_record, record)
    record.update({'generated_at': time.time(), 'status': 'completed', 'current_target': None})
    _write_json(record_path, record)
    self._sync_lecture_page_indexes(previous_record, record)
    self._sync_question_reverse_indexes(previous_record, record)
    return record

  def link_document(self, document_id: str) -> dict[str, Any]:
    document, questions = self._load_question_document(document_id)
    index_path = self.document_index_dir / f'{_safe_name(document_id)}.json'
    index = {
      'generated_at': time.time(),
      'document_id': document_id,
      'course_id': document['course_id'],
      'question_count': len(questions),
      'linked_question_count': 0,
      'question_ids': [],
      'status': 'processing',
      'error': None,
    }
    _write_json(index_path, index)
    try:
      records = [self.link_question(question, document) for question in questions if isinstance(question.get('analysis'), dict)]
      index.update({
        'generated_at': time.time(),
        'linked_question_count': len(records),
        'question_ids': [record['question_id'] for record in records],
        'status': 'completed',
        'error': None,
      })
    except Exception as exc:
      index.update({
        'generated_at': time.time(),
        'status': 'failed',
        'error': str(getattr(exc, 'detail', None) or exc),
      })
      _write_json(index_path, index)
      raise
    _write_json(index_path, index)
    return index

  def missing_document_ids(self) -> list[str]:
    """Return completed question documents whose relation projection is absent or incomplete."""
    missing: list[str] = []
    if not self.question_documents_root.is_dir():
      return missing
    for directory in self.question_documents_root.iterdir():
      if not directory.is_dir():
        continue
      state = _read_json(directory / 'state.json', {})
      if not isinstance(state, dict) or state.get('status') != 'completed':
        continue
      document_id = str(state.get('document_id') or directory.name)
      index = _read_json(self.document_index_dir / f'{_safe_name(document_id)}.json', {})
      legacy_completed = (
        isinstance(index, dict)
        and not index.get('status')
        and str(index.get('document_id') or '') == document_id
        and bool(index.get('generated_at'))
      )
      if not isinstance(index, dict) or (index.get('status') != 'completed' and not legacy_completed):
        missing.append(document_id)
    return missing

  def link_document_question(self, document_id: str, question_id: str) -> dict[str, Any]:
    document, questions = self._load_question_document(document_id)
    question = next(
      (item for item in questions if str(item.get('question_id') or '') == question_id),
      None,
    )
    if not isinstance(question, dict):
      raise HTTPException(status_code=404, detail='Question not found in document.')
    return self.link_question(question, document)

  def link_course(self, course_id: str) -> dict[str, Any]:
    indexes = []
    if self.question_documents_root.is_dir():
      for directory in self.question_documents_root.iterdir():
        if not directory.is_dir():
          continue
        state = _read_json(directory / 'state.json', {})
        if state.get('course_id') != course_id or state.get('status') != 'completed':
          continue
        indexes.append(self.link_document(str(state.get('document_id') or directory.name)))
    return {'course_id': course_id, 'document_count': len(indexes), 'documents': indexes}

  def result(self, question_id: str) -> dict[str, Any]:
    record = _read_json(self.relations_dir / f'{_safe_name(question_id)}.json', None)
    reverse = _read_json(self.question_reverse_index_dir / f'{_safe_name(question_id)}.json', None)
    if not isinstance(record, dict) and not isinstance(reverse, dict):
      raise HTTPException(status_code=404, detail='Question relation record not found.')
    result = dict(record) if isinstance(record, dict) else {
      'version': 2,
      'question_id': question_id,
      'status': 'completed',
      'relations': [],
      'runs': [],
    }
    relations = list(result.get('relations') or [])
    if isinstance(reverse, dict):
      relations.extend(reverse.get('relations') or [])
    unique: dict[tuple[str, str, int], dict[str, Any]] = {}
    for relation in relations:
      if not isinstance(relation, dict):
        continue
      target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
      key = (
        str(target.get('question_id') or target.get('document_id') or ''),
        str(relation.get('relation_type') or ''),
        int(target.get('page_number') or 0),
      )
      previous = unique.get(key)
      if previous is None or float(relation.get('rerank_score') or 0.0) > float(previous.get('rerank_score') or 0.0):
        unique[key] = relation
    result['relations'] = sorted(
      unique.values(),
      key=lambda item: float(item.get('rerank_score') or 0.0),
      reverse=True,
    )
    return result

  def assessment_relation_targets(
    self,
    question_ids: set[str] | None = None,
  ) -> list[dict[str, Any]]:
    """List questions that have at least one persisted relation to a real lecture page."""
    selected = {
      str(value or '').strip()
      for value in question_ids or set()
      if str(value or '').strip()
    }
    if question_ids is not None and not selected:
      return []
    targets: list[dict[str, Any]] = []
    paths = sorted(self.relations_dir.glob('*.json')) if self.relations_dir.is_dir() else []
    for path in paths:
      record = _read_json(path, {})
      if not isinstance(record, dict) or record.get('status') != 'completed':
        continue
      question_id = str(record.get('question_id') or '').strip()
      if not question_id or (selected and question_id not in selected):
        continue
      lecture_document_ids: set[str] = set()
      for relation in record.get('relations') or []:
        if not isinstance(relation, dict) or relation.get('relation_type') != 'question_to_lecture_page':
          continue
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        document_id = str(target.get('document_id') or '').strip()
        if document_id and int(target.get('page_number') or 0) > 0:
          lecture_document_ids.add(document_id)
      if lecture_document_ids:
        targets.append({
          'course_id': str(record.get('course_id') or '').strip(),
          'question_id': question_id,
          'source_document_id': str(record.get('question_document_id') or '').strip(),
          'lecture_document_ids': sorted(lecture_document_ids),
        })
    return targets

  def lecture_page_relations(
    self,
    course_id: str,
    lecture_document_id: str,
    page_number: int,
  ) -> dict[str, Any]:
    """Return question sources that have been linked to one lecture page."""
    index_path = self._lecture_page_index_path(lecture_document_id, page_number)
    indexed = _read_json(index_path, None)
    if isinstance(indexed, dict) and indexed.get('course_id') == course_id:
      return indexed

    return self._scan_lecture_page_relations(course_id, lecture_document_id, page_number)

  def lecture_document_questions(
    self,
    course_id: str,
    lecture_document_id: str,
  ) -> dict[str, Any]:
    """Return original questions related to any real page in one lecture."""
    questions: dict[str, dict[str, Any]] = {}
    valid_page_numbers = {
      int(page.get('page_number') or 0)
      for page in self._lecture_pages(lecture_document_id)
      if int(page.get('page_number') or 0) > 0
    }
    if not valid_page_numbers:
      return {
        'course_id': course_id,
        'lecture_document_id': lecture_document_id,
        'questions': [],
      }
    if not self.relations_dir.is_dir():
      return {
        'course_id': course_id,
        'lecture_document_id': lecture_document_id,
        'questions': [],
      }

    for path in self.relations_dir.glob('*.json'):
      record = _read_json(path, {})
      if not isinstance(record, dict) or str(record.get('course_id') or '') != course_id:
        continue
      matching_relations = []
      for relation in record.get('relations') if isinstance(record.get('relations'), list) else []:
        if not isinstance(relation, dict) or relation.get('relation_type') != 'question_to_lecture_page':
          continue
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        if str(target.get('document_id') or '') != lecture_document_id:
          continue
        page_number = int(target.get('page_number') or 0)
        if page_number not in valid_page_numbers:
          continue
        matching_relations.append(relation)
      if not matching_relations:
        continue

      question_id = str(record.get('question_id') or '').strip()
      source_document_id = str(record.get('question_document_id') or '').strip()
      question = self._question_summary(source_document_id, question_id)
      if not question:
        continue
      existing = questions.setdefault(question_id, {
        **question,
        'lecture_relations': [],
      })
      existing['lecture_relations'].extend(matching_relations)

    result = []
    for question in questions.values():
      deduplicated: dict[tuple[str, int], dict[str, Any]] = {}
      for relation in question['lecture_relations']:
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        key = (str(target.get('document_id') or ''), int(target.get('page_number') or 0))
        previous = deduplicated.get(key)
        if previous is None or float(relation.get('rerank_score') or 0.0) > float(previous.get('rerank_score') or 0.0):
          deduplicated[key] = relation
      question['lecture_relations'] = sorted(
        deduplicated.values(),
        key=lambda item: int((item.get('target') or {}).get('page_number') or 0),
      )
      result.append(question)
    result.sort(key=lambda item: (
      str(item.get('document_name') or ''),
      int(item.get('page_number') or 0),
      str(item.get('question_id') or ''),
    ))
    return {
      'course_id': course_id,
      'lecture_document_id': lecture_document_id,
      'questions': result,
    }

  def _scan_lecture_page_relations(
    self,
    course_id: str,
    lecture_document_id: str,
    page_number: int,
  ) -> dict[str, Any]:
    """Compatibility path for relation records created before reverse indexes existed."""
    if not self.relations_dir.is_dir():
      return {
        'course_id': course_id,
        'lecture_document_id': lecture_document_id,
        'page_number': page_number,
        'relations': [],
      }

    matches: list[dict[str, Any]] = []
    for path in self.relations_dir.glob('*.json'):
      record = _read_json(path, {})
      if not isinstance(record, dict) or record.get('course_id') != course_id:
        continue

      source_question = self._question_summary(
        str(record.get('question_document_id') or ''),
        str(record.get('question_id') or ''),
      )
      for relation in record.get('relations') if isinstance(record.get('relations'), list) else []:
        if not isinstance(relation, dict) or relation.get('relation_type') != 'question_to_lecture_page':
          continue
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        if (
          str(target.get('document_id') or '') != lecture_document_id
          or int(target.get('page_number') or 0) != page_number
        ):
          continue
        matches.append({
          **relation,
          'question': source_question,
        })

    matches.sort(key=lambda item: float(item.get('rerank_score') or 0.0), reverse=True)
    return {
      'course_id': course_id,
      'lecture_document_id': lecture_document_id,
      'page_number': page_number,
      'relations': matches,
    }

  def rebuild_lecture_page_indexes(self) -> dict[str, Any]:
    """Rebuild all reverse indexes without rerunning retrieval or AI review."""
    if self.lecture_page_index_dir.is_dir():
      for path in self.lecture_page_index_dir.rglob('*.json'):
        path.unlink()
    if self.question_reverse_index_dir.is_dir():
      for path in self.question_reverse_index_dir.rglob('*.json'):
        path.unlink()
    indexed_records = 0
    for path in self.relations_dir.glob('*.json') if self.relations_dir.is_dir() else []:
      record = _read_json(path, {})
      if not isinstance(record, dict):
        continue
      self._sync_lecture_page_indexes({}, record)
      self._sync_question_reverse_indexes({}, record)
      indexed_records += 1
    page_files = (
      sum(1 for _ in self.lecture_page_index_dir.rglob('*.json'))
      if self.lecture_page_index_dir.is_dir()
      else 0
    )
    question_target_files = (
      sum(1 for _ in self.question_reverse_index_dir.glob('*.json'))
      if self.question_reverse_index_dir.is_dir()
      else 0
    )
    return {
      'question_records': indexed_records,
      'lecture_pages': page_files,
      'question_targets': question_target_files,
    }

  def delete_question_document(self, document_id: str) -> None:
    """Delete source-question relation records before its question document is removed."""
    index = _read_json(self.document_index_dir / f'{_safe_name(document_id)}.json', {})
    question_ids = index.get('question_ids') if isinstance(index, dict) else []
    if not isinstance(question_ids, list):
      question_ids = []

    relation_paths = {
      self.relations_dir / f'{_safe_name(str(question_id))}.json'
      for question_id in question_ids
      if str(question_id).strip()
    }
    # A failed write or an older application version may leave the document
    # index missing. The relation records themselves remain authoritative.
    if self.relations_dir.is_dir():
      for path in self.relations_dir.glob('*.json'):
        record = _read_json(path, {})
        if (
          isinstance(record, dict)
          and str(record.get('question_document_id') or '') == document_id
        ):
          relation_paths.add(path)

    for path in relation_paths:
      if path.is_file():
        previous_record = _read_json(path, {})
        self._sync_lecture_page_indexes(previous_record, {})
        self._sync_question_reverse_indexes(previous_record, {})
        path.unlink()
    for question_id in question_ids:
      reverse_path = self.question_reverse_index_dir / f'{_safe_name(str(question_id))}.json'
      if reverse_path.is_file():
        reverse_path.unlink()
    index_path = self.document_index_dir / f'{_safe_name(document_id)}.json'
    if index_path.is_file():
      index_path.unlink()

  def remove_target_document(self, document_id: str) -> None:
    """Remove stale target links when a lecture or question document is deleted."""
    if self.relations_dir.is_dir():
      for path in self.relations_dir.glob('*.json'):
        record = _read_json(path, {})
        if not isinstance(record, dict):
          continue
        previous_record = json.loads(json.dumps(record))
        original_relations = record.get('relations') if isinstance(record.get('relations'), list) else []
        relations = [
          relation for relation in original_relations
          if not isinstance(relation, dict) or (relation.get('target') or {}).get('document_id') != document_id
        ]
        changed = len(relations) != len(original_relations)
        for run in record.get('runs') if isinstance(record.get('runs'), list) else []:
          if not isinstance(run, dict):
            continue
          for key in ('retrieved_candidates', 'reranked_candidates'):
            candidates = run.get(key)
            if not isinstance(candidates, list):
              continue
            filtered = [
              candidate for candidate in candidates
              if not isinstance(candidate, dict) or (candidate.get('payload') or {}).get('document_id') != document_id
            ]
            if len(filtered) != len(candidates):
              run[key] = filtered
              changed = True
        if changed:
          record['relations'] = relations
          record['updated_at'] = time.time()
          _write_json(path, record)
          self._sync_lecture_page_indexes(previous_record, record)
          self._sync_question_reverse_indexes(previous_record, record)

    reverse_index_directory = self.lecture_page_index_dir / _safe_name(document_id)
    if reverse_index_directory.is_dir():
      shutil.rmtree(reverse_index_directory)

  def _lecture_page_index_path(self, document_id: str, page_number: int) -> Path:
    return self.lecture_page_index_dir / _safe_name(document_id) / f'page-{page_number}.json'

  @staticmethod
  def _lecture_page_keys(record: dict[str, Any]) -> set[tuple[str, int]]:
    keys: set[tuple[str, int]] = set()
    relations = record.get('relations') if isinstance(record.get('relations'), list) else []
    for relation in relations:
      if not isinstance(relation, dict) or relation.get('relation_type') != 'question_to_lecture_page':
        continue
      target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
      document_id = str(target.get('document_id') or '')
      page_number = int(target.get('page_number') or 0)
      if document_id and page_number > 0:
        keys.add((document_id, page_number))
    return keys

  def _sync_lecture_page_indexes(
    self,
    previous_record: dict[str, Any],
    current_record: dict[str, Any],
  ) -> None:
    affected_keys = self._lecture_page_keys(previous_record) | self._lecture_page_keys(current_record)
    question_ids = {
      str(record.get('question_id') or '')
      for record in (previous_record, current_record)
      if isinstance(record, dict) and record.get('question_id')
    }
    current_question = (
      self._question_summary(
        str(current_record.get('question_document_id') or ''),
        str(current_record.get('question_id') or ''),
      )
      if current_record
      else {}
    )
    current_relations = (
      current_record.get('relations')
      if isinstance(current_record.get('relations'), list)
      else []
    )

    for document_id, page_number in affected_keys:
      path = self._lecture_page_index_path(document_id, page_number)
      existing = _read_json(path, {})
      relations = [
        relation
        for relation in existing.get('relations', [])
        if (
          isinstance(relation, dict)
          and str((relation.get('question') or {}).get('question_id') or '') not in question_ids
        )
      ] if isinstance(existing, dict) else []

      for relation in current_relations:
        if not isinstance(relation, dict) or relation.get('relation_type') != 'question_to_lecture_page':
          continue
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        if (
          str(target.get('document_id') or '') != document_id
          or int(target.get('page_number') or 0) != page_number
        ):
          continue
        relations.append({
          **relation,
          'reverse_relation_type': 'lecture_page_to_question',
          'question': current_question,
        })

      unique = {
        str(relation.get('relation_id') or ''): relation
        for relation in relations
        if isinstance(relation, dict) and relation.get('relation_id')
      }
      relations = sorted(
        unique.values(),
        key=lambda item: float(item.get('rerank_score') or 0.0),
        reverse=True,
      )
      if not relations:
        if path.is_file():
          path.unlink()
        continue
      _write_json(path, {
        'course_id': str(current_record.get('course_id') or existing.get('course_id') or ''),
        'lecture_document_id': document_id,
        'page_number': page_number,
        'relations': relations,
        'updated_at': time.time(),
      })

  @staticmethod
  def _question_target_ids(record: dict[str, Any]) -> set[str]:
    target_ids: set[str] = set()
    relations = record.get('relations') if isinstance(record.get('relations'), list) else []
    for relation in relations:
      if not isinstance(relation, dict) or relation.get('relation_type') == 'question_to_lecture_page':
        continue
      target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
      question_id = str(target.get('question_id') or '').strip()
      if question_id:
        target_ids.add(question_id)
    return target_ids

  def _sync_question_reverse_indexes(
    self,
    previous_record: dict[str, Any],
    current_record: dict[str, Any],
  ) -> None:
    """Persist incoming question links so either question can load the other."""
    affected_ids = self._question_target_ids(previous_record) | self._question_target_ids(current_record)
    source_ids = {
      str(record.get('question_id') or '')
      for record in (previous_record, current_record)
      if isinstance(record, dict) and record.get('question_id')
    }
    source_question = (
      self._question_summary(
        str(current_record.get('question_document_id') or ''),
        str(current_record.get('question_id') or ''),
      )
      if current_record
      else {}
    )
    current_relations = (
      current_record.get('relations')
      if isinstance(current_record.get('relations'), list)
      else []
    )

    for target_question_id in affected_ids:
      path = self.question_reverse_index_dir / f'{_safe_name(target_question_id)}.json'
      existing = _read_json(path, {})
      relations = [
        relation
        for relation in existing.get('relations', [])
        if (
          isinstance(relation, dict)
          and str(relation.get('reverse_source_question_id') or '') not in source_ids
        )
      ] if isinstance(existing, dict) else []

      for relation in current_relations:
        if not isinstance(relation, dict) or relation.get('relation_type') == 'question_to_lecture_page':
          continue
        target = relation.get('target') if isinstance(relation.get('target'), dict) else {}
        if str(target.get('question_id') or '') != target_question_id:
          continue
        relations.append({
          **relation,
          'relation_id': f"{relation.get('relation_id')}:reverse",
          'reverse_relation_type': 'question_to_question',
          'reverse_source_question_id': str(current_record.get('question_id') or ''),
          'target': source_question,
        })

      unique = {
        str(relation.get('relation_id') or ''): relation
        for relation in relations
        if isinstance(relation, dict) and relation.get('relation_id')
      }
      relations = sorted(
        unique.values(),
        key=lambda item: float(item.get('rerank_score') or 0.0),
        reverse=True,
      )
      if not relations:
        if path.is_file():
          path.unlink()
        continue
      _write_json(path, {
        'question_id': target_question_id,
        'relations': relations,
        'updated_at': time.time(),
      })

  def _load_question_document(self, document_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    directory = self.question_documents_root / _safe_name(document_id)
    state = _read_json(directory / 'state.json', {})
    question_files_directory = directory / 'questions'
    questions = (
      [
        question
        for path in sorted(question_files_directory.glob('*.json'))
        if isinstance((question := _read_json(path, {})), dict) and question
      ]
      if question_files_directory.is_dir()
      else _read_json(directory / 'questions.json', [])
    )
    if not isinstance(state, dict) or not state:
      raise HTTPException(status_code=404, detail='Question document not found.')
    if not isinstance(questions, list):
      questions = []
    document = {
      'document_id': str(state.get('document_id') or document_id),
      'document_name': str(state.get('document_name') or ''),
      'course_id': str(state.get('course_id') or ''),
      'document_type': str(state.get('document_type') or ''),
    }
    return document, [item for item in questions if isinstance(item, dict)]

  def _question_summary(self, document_id: str, question_id: str) -> dict[str, Any]:
    if not document_id or not question_id:
      return {}
    try:
      document, questions = self._load_question_document(document_id)
    except HTTPException:
      return {}
    question = next(
      (item for item in questions if str(item.get('question_id') or '') == question_id),
      {},
    )
    if not question:
      return {}
    return {
      'question_id': question_id,
      'document_id': document['document_id'],
      'document_name': document['document_name'],
      'document_type': document['document_type'],
      'page_number': question.get('page_number'),
      'title': question.get('title'),
      'content': question.get('content'),
      'analysis': question.get('analysis'),
      'page_numbers': question.get('page_numbers') or [question.get('page_number')],
      'source_block_ids': question.get('source_block_ids') or [],
      'source_segment_ids': question.get('source_segment_ids') or [],
    }

  def _lecture_pages(self, document_id: str) -> list[dict[str, Any]]:
    pages = _read_json(self.lecture_documents_root / document_id / 'pages.json', [])
    return [page for page in pages if isinstance(page, dict)] if isinstance(pages, list) else []

  def _hydrate_lecture_candidate(self, candidate: dict[str, Any]) -> dict[str, Any]:
    payload = candidate.get('payload') if isinstance(candidate.get('payload'), dict) else {}
    document_id = str(payload.get('document_id') or '')
    page_number = int(payload.get('page_number') or 0)
    page = next(
      (
        item for item in self._lecture_pages(document_id)
        if int(item.get('page_number') or 0) == page_number
      ),
      None,
    )
    if not page:
      return candidate
    state = _read_json(self.lecture_documents_root / document_id / 'state.json', {})
    hydrated_payload = payload | page
    hydrated_payload['document_name'] = payload.get('document_name') or state.get('document_name')
    hydrated_payload['document_type'] = payload.get('document_type') or state.get('document_type') or 'lecture'
    hydrated_payload['course_id'] = payload.get('course_id') or state.get('course_id')
    content = str(page.get('content') or candidate.get('content') or '').strip()
    return candidate | {'payload': hydrated_payload, 'content': content}

  def _verify_lecture_page(
    self,
    *,
    question: dict[str, Any],
    query: str,
    candidate: dict[str, Any],
    config: dict[str, Any],
    expansion_context: dict[str, Any],
  ) -> tuple[dict[str, Any], bool]:
    payload = candidate.get('payload') if isinstance(candidate.get('payload'), dict) else {}
    excluded_reason = self._excluded_lecture_page_reason(payload)
    if excluded_reason:
      decision = {
        'related': False,
        'confidence': 1.0,
        'page_role': 'summary',
        'reason': excluded_reason,
        'concrete_evidence': [],
      }
      return ({
        'document_id': payload.get('document_id'),
        'document_name': payload.get('document_name'),
        'page_number': payload.get('page_number'),
        'stage': expansion_context.get('kind'),
        'seed_page_number': expansion_context.get('seed_page_number'),
        'direction': expansion_context.get('direction'),
        'distance': expansion_context.get('distance'),
        'vector_score': float(candidate.get('vector_score') or 0.0),
        'rerank_score': float(candidate.get('rerank_score') or 0.0),
        'accepted': False,
        'decision': decision,
        'error': None,
      }, False)
    try:
      decision = self.verifier.verify(
        question,
        query,
        payload | {'content': candidate.get('content')},
        max_page_chars=config['ai_verification_max_page_chars'],
        expansion_context=expansion_context,
      )
      error = None
    except Exception as exc:  # Fail closed: unverified lecture pages must not become relations.
      decision = {
        'related': False,
        'confidence': 0.0,
        'page_role': 'other',
        'reason': 'AI verification failed; relation was not created.',
        'concrete_evidence': [],
      }
      error = str(getattr(exc, 'detail', None) or exc)
    accepted = (
      bool(decision.get('related'))
      and (
        float(decision.get('confidence') or 0.0) >= config['ai_verification_min_confidence']
        or bool(decision.get('concrete_evidence'))
      )
      and decision.get('page_role') not in {
        'cover',
        'table_of_contents',
        'chapter_title',
        'summary',
      }
    )
    audit = {
      'document_id': payload.get('document_id'),
      'document_name': payload.get('document_name'),
      'page_number': payload.get('page_number'),
      'stage': expansion_context.get('kind'),
      'seed_page_number': expansion_context.get('seed_page_number'),
      'direction': expansion_context.get('direction'),
      'distance': expansion_context.get('distance'),
      'vector_score': float(candidate.get('vector_score') or 0.0),
      'rerank_score': float(candidate.get('rerank_score') or 0.0),
      'accepted': accepted,
      'decision': decision,
      'error': error,
    }
    return audit, accepted

  @staticmethod
  def _excluded_lecture_page_reason(payload: dict[str, Any]) -> str | None:
    """Reject navigation/review pages before an expensive AI verification call."""
    title = re.sub(r'\s+', ' ', str(payload.get('title') or '')).strip().lower()
    if not title:
      return None
    excluded_prefixes = (
      '\u5c01\u9762',       # cover
      '\u76ee\u5f55',       # table of contents
      '\u56de\u987e',       # review
      '\u603b\u7ed3',       # summary
      '\u5c0f\u7ed3',       # section summary
      'cover',
      'contents',
      'table of contents',
      'review',
      'summary',
      'overview',
    )
    if title.startswith(excluded_prefixes):
      return 'The page title identifies it as a cover, contents, review, or summary page.'
    return None

  def _verify_lecture_candidates(
    self,
    *,
    question: dict[str, Any],
    query: str,
    candidates: list[dict[str, Any]],
    config: dict[str, Any],
  ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    accepted_by_page: dict[str, dict[str, Any]] = {}
    audits: list[dict[str, Any]] = []

    def verify(raw_candidate: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], bool]:
      candidate = self._hydrate_lecture_candidate(raw_candidate)
      payload = candidate.get('payload') if isinstance(candidate.get('payload'), dict) else {}
      audit, accepted = self._verify_lecture_page(
        question=question,
        query=query,
        candidate=candidate,
        config=config,
        expansion_context={'kind': 'seed', 'seed_page_number': payload.get('page_number')},
      )
      return candidate, payload, audit, accepted

    concurrency = min(config['ai_verification_concurrency'], max(1, len(candidates)))
    with ThreadPoolExecutor(max_workers=concurrency, thread_name_prefix='relation-verifier') as executor:
      verified_candidates = executor.map(verify, candidates)

    for candidate, payload, audit, accepted in verified_candidates:
      page_key = f"{payload.get('document_id')}:{payload.get('page_number')}"
      audits.append(audit)
      if not accepted:
        continue
      verified = candidate | {
        'ai_verification': audit['decision'],
        'relation_origin': {
          'kind': 'seed',
          'seed_page_number': payload.get('page_number'),
          'direction': 0,
          'distance': 0,
        },
        'relation_source': 'reranker+ai-verifier',
      }
      accepted_by_page[page_key] = verified

    accepted = list(accepted_by_page.values())
    accepted.sort(
      key=lambda item: (
        str(item['payload'].get('document_id') or ''),
        int(item['payload'].get('page_number') or 0),
      )
    )
    return accepted, audits

  def _retrieve_candidates(
    self,
    *,
    vector: list[float],
    course_id: str,
    collection: str,
    document_type: str,
    question_id: str,
    source_document_id: str,
    source_document_name: str,
    config: dict[str, Any],
  ) -> tuple[list[dict[str, Any]], str | None]:
    try:
      try:
        response = self.vector_store.search(vector, config['retrieval_top_n'], {'course_id': course_id, 'document_type': document_type}, collection_name=collection)
      except TypeError:  # Lightweight test stores may not expose collection_name.
        response = self.vector_store.search(vector, config['retrieval_top_n'], {'course_id': course_id, 'document_type': document_type})
    except Exception as exc:  # A missing collection is a valid empty target at this stage.
      return [], str(exc)
    valid_lecture_ids = (
      self._active_lecture_document_ids(course_id)
      if collection == QDRANT_COLLECTION and document_type == 'lecture'
      else None
    )
    candidates = []
    for result in response:
      payload = result.get('payload') if isinstance(result, dict) else None
      if not isinstance(payload, dict):
        continue
      if valid_lecture_ids is not None and str(payload.get('document_id') or '') not in valid_lecture_ids:
        continue
      if payload.get('question_id') == question_id:
        continue
      if str(payload.get('document_id') or '') == source_document_id:
        continue
      if (
        _document_name_key(source_document_name)
        and _document_name_key(payload.get('document_name')) == _document_name_key(source_document_name)
      ):
        continue
      content = str(payload.get('content') or '').strip()
      if not content:
        continue
      candidates.append({'payload': payload, 'content': content, 'vector_score': float(result.get('score') or 0.0)})
    return candidates, None

  @staticmethod
  def _active_lecture_document_ids(course_id: str) -> set[str]:
    """Use the course library as the authority for lecture ownership."""
    library = read_knowledge_library()
    return {
      str(item.get('id') or '')
      for item in library.get('files') or []
      if (
        isinstance(item, dict)
        and str(item.get('courseId') or '') == course_id
        and str(item.get('id') or '')
      )
    }

  @staticmethod
  def _deduplicate_targets(candidates: list[dict[str, Any]], target_name: str) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for candidate in candidates:
      payload = candidate['payload']
      key = (
        f"{payload.get('document_id')}:{payload.get('page_number')}"
        if target_name == 'lecture'
        else str(payload.get('question_id') or '')
      )
      if key and key not in unique:
        unique[key] = candidate
    return list(unique.values())

  @staticmethod
  def _to_relation(candidate: dict[str, Any], question_id: str, relation_type: str, source: str) -> dict[str, Any]:
    payload = candidate['payload']
    rerank_score = float(candidate['rerank_score'])
    verification = candidate.get('ai_verification')
    confidence = (
      float(verification.get('confidence') or 0.0)
      if isinstance(verification, dict)
      else rerank_score
    )
    return {
      'relation_id': f"{question_id}:{relation_type}:{payload.get('document_id')}:{payload.get('page_number')}:{payload.get('question_id', payload.get('chunk_id', ''))}",
      'relation_type': relation_type,
      'source': source,
      'confidence': max(0.0, min(1.0, confidence)),
      'vector_score': float(candidate['vector_score']),
      'rerank_score': rerank_score,
      'ai_verification': verification,
      'relation_origin': candidate.get('relation_origin'),
      'target': {
        'document_id': payload.get('document_id'),
        'document_name': payload.get('document_name'),
        'document_type': payload.get('document_type'),
        'page_number': payload.get('page_number'),
        'chunk_id': payload.get('chunk_id'),
        'question_id': payload.get('question_id'),
        'title': payload.get('title'),
        'content': payload.get('content'),
      },
    }
