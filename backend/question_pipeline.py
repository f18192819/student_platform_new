from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any, Protocol

import requests
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import PROJECT_ROOT
from .document_pipeline import ApiEmbeddingProvider, DocumentParser, LocalMinerUParser, QdrantVectorStore, _archive_result, _middle_layout_blocks, _write_json
from .runtime_config import load_api_config

QUESTION_PIPELINE_ROOT = PROJECT_ROOT / '.runtime' / 'question-pipeline'
QUESTION_DOCUMENTS_ROOT = QUESTION_PIPELINE_ROOT / 'documents'
QUESTION_COLLECTION = 'course_questions'
QUESTION_EXTRACTION_VERSION = 3
QUESTION_FILES_DIRECTORY = 'questions'
QUESTION_EMBEDDINGS_FILE = 'embeddings.json'
QUESTION_CHECKPOINT_BATCH_SIZE = max(1, int(os.environ.get('QUESTION_CHECKPOINT_BATCH_SIZE', '1')))
QUESTION_RESUME_MAX_AGE_SECONDS = max(300, int(os.environ.get('QUESTION_RESUME_MAX_AGE_SECONDS', '21600')))
QUESTION_EMBEDDING_CONTENT_CHARS = 3200
QUESTION_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif'}
QUESTION_UPLOAD_EXTENSIONS = {'.pdf', '.jpg', '.jpeg', '.png', '.webp'}


def _question_source_file_name(file_name: str) -> str:
  suffix = Path(str(file_name or '')).suffix.lower()
  return f'source{suffix if suffix in QUESTION_UPLOAD_EXTENSIONS else ".pdf"}'


def _question_document_directory(document_id: str) -> Path:
  safe_id = re.sub(r'[^A-Za-z0-9._-]+', '-', document_id).strip('.-')
  return QUESTION_DOCUMENTS_ROOT / (safe_id or 'invalid-document')


def _layout_blocks_with_image_assets(document_id: str) -> list[dict[str, Any]]:
  """Read layout blocks and upgrade pre-image-support MinerU results in place."""
  directory = _question_document_directory(document_id)
  layout_path = directory / 'layout-blocks.json'
  try:
    blocks = json.loads(layout_path.read_text(encoding='utf-8'))
  except (OSError, json.JSONDecodeError):
    return []
  if not isinstance(blocks, list):
    return []
  image_blocks = [item for item in blocks if isinstance(item, dict) and item.get('kind') == 'image']
  if not image_blocks or all(str(item.get('assetPath') or '').strip() for item in image_blocks):
    return [item for item in blocks if isinstance(item, dict)]

  artifacts_root = directory / 'mineru' / 'artifacts'
  enriched_by_id: dict[str, dict[str, Any]] = {}
  middle_paths = sorted(artifacts_root.rglob('*middle.json')) if artifacts_root.is_dir() else []
  for middle_path in middle_paths:
    try:
      payload = json.loads(middle_path.read_text(encoding='utf-8'))
      parent = middle_path.parent.relative_to(artifacts_root).as_posix()
      enriched_by_id.update({
        str(item.get('id') or ''): item
        for item in _middle_layout_blocks(payload, parent)
        if isinstance(item, dict) and item.get('kind') == 'image'
      })
    except (OSError, ValueError, json.JSONDecodeError):
      continue

  changed = False
  for block in image_blocks:
    enriched = enriched_by_id.get(str(block.get('id') or '')) or {}
    asset_path = str(enriched.get('assetPath') or '').strip()
    if asset_path and not block.get('assetPath'):
      block['assetPath'] = asset_path
      changed = True
  if changed:
    _write_json(layout_path, blocks)
  return [item for item in blocks if isinstance(item, dict)]


def question_image_attachments(
  document_id: str,
  question: dict[str, Any],
  prompt: str,
) -> list[dict[str, Any]]:
  """Return only original MinerU images that belong to the question prompt."""
  blocks = _layout_blocks_with_image_assets(document_id)
  block_by_id = {str(item.get('id') or ''): item for item in blocks}
  source_block_ids = list(dict.fromkeys(
    str(value or '').strip() for value in question.get('source_block_ids') or [] if str(value or '').strip()
  ))
  if not source_block_ids:
    return []

  # MinerU can order a visual after answer text even when it is displayed beside
  # the question, so an explicit figure reference also retains opening-page art.
  segment_by_id = {
    str(item.get('segment_id') or ''): item
    for item in AIQuestionExtractor._source_segments('', blocks)
  }
  selected_segments = [
    segment_by_id[str(segment_id)]
    for segment_id in question.get('source_segment_ids') or []
    if str(segment_id) in segment_by_id
  ]
  prompt_length = len(str(prompt or '').strip())
  prompt_block_ids: set[str] = set()
  prompt_pages: set[int] = set()
  consumed = 0
  for segment in selected_segments:
    if consumed < prompt_length:
      prompt_block_ids.add(str(segment.get('block_id') or ''))
      prompt_pages.add(max(1, int(segment.get('page_number') or 1)))
    consumed += len(str(segment.get('text') or '').strip()) + 1

  opening_page = max(1, int(question.get('page_number') or 1))
  prompt_pages.add(opening_page)
  mentions_figure = bool(re.search(
    r'如(?:下)?图|见图|图中|示意图|figure|diagram|shown\s+(?:below|above)',
    prompt,
    re.IGNORECASE,
  ))
  attachments = []
  for block_id in source_block_ids:
    block = block_by_id.get(block_id) or {}
    if block.get('kind') != 'image':
      continue
    page_number = max(1, int(block.get('pageNumber') or opening_page))
    if block_id not in prompt_block_ids and not (mentions_figure and page_number in prompt_pages):
      continue
    if not str(block.get('assetPath') or '').strip():
      continue
    attachments.append({
      'id': block_id,
      'page_number': page_number,
      'alt': f'Question figure from source page {page_number}',
      'url': f'/api/adaptive-tests/question-assets/{document_id}/{block_id}',
    })
  return attachments


def resolve_question_image_asset(document_id: str, image_id: str) -> Path:
  directory = _question_document_directory(document_id)
  block = next(
    (
      item for item in _layout_blocks_with_image_assets(document_id)
      if str(item.get('id') or '') == image_id and item.get('kind') == 'image'
    ),
    None,
  )
  if not block:
    raise HTTPException(status_code=404, detail='Question image not found.')
  asset_path = str(block.get('assetPath') or '').strip()
  artifacts_root = (directory / 'mineru' / 'artifacts').resolve()
  candidate = (artifacts_root / asset_path).resolve()
  if (
    artifacts_root not in candidate.parents
    or candidate.suffix.lower() not in QUESTION_IMAGE_EXTENSIONS
    or not candidate.is_file()
  ):
    raise HTTPException(status_code=404, detail='Question image file not found.')
  return candidate


def build_question_retrieval_text(question: dict[str, Any]) -> str:
  """Build the bounded semantic text shared by indexing and relation retrieval."""
  analysis = question.get('analysis') or {}
  content = str(question.get('content') or '')
  content_excerpt = content[:QUESTION_EMBEDDING_CONTENT_CHARS]
  return '\n'.join([
    f"题目标题：{question.get('title', '')}",
    f"题目原文：{content_excerpt}",
    f"AI 摘要：{analysis.get('summary', '')}",
    f"题型：{analysis.get('question_type', '')}",
    f"知识点：{'、'.join(analysis.get('knowledge_points') or [])}",
    f"章节：{analysis.get('chapter', '')}",
    f"公式：{'；'.join(analysis.get('formulas') or [])}",
    f"技能：{'、'.join(analysis.get('skills') or [])}",
  ]).strip()


class Difficulty(BaseModel):
  model_config = ConfigDict(extra='forbid')
  level: int = Field(ge=1, le=5)
  reason: str = Field(max_length=500)


class QuestionAnalysis(BaseModel):
  """Strict, machine-readable output required from the configured text model."""
  model_config = ConfigDict(extra='forbid')
  question_type: str = Field(max_length=80)
  difficulty: Difficulty
  knowledge_points: list[str] = Field(default_factory=list, max_length=12)
  formulas: list[str] = Field(default_factory=list, max_length=12)
  chapter: str = Field(default='', max_length=160)
  prerequisites: list[str] = Field(default_factory=list, max_length=12)
  skills: list[str] = Field(default_factory=list, max_length=12)
  summary: str = Field(max_length=500)


class QuestionExtractor:
  """LEGACY_DELETE: page-local regex splitter kept only for old tests and rollback."""

  _QUESTION_START = re.compile(
    r'(?m)^(?=(?:#{1,6}\s*)?(?:第\s*[0-9一二三四五六七八九十百]+\s*题|[0-9]{1,3}\s*[、.．]|[（(]\s*[0-9]{1,3}\s*[)）]|[一二三四五六七八九十]\s*[、.．]))'
  )

  def extract(self, markdown: str, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    page_texts = self._page_texts(markdown, blocks)
    questions: list[dict[str, Any]] = []
    for page_number, text in page_texts:
      questions.extend(self._split_page(text, page_number))
    if not questions and markdown.strip():
      questions = self._split_page(markdown, 1)
    return [
      {
        'question_id': uuid.uuid4().hex,
        'index': index,
        'page_number': item['page_number'],
        'title': item['title'],
        'anchor_text': item['anchor_text'],
        'content': item['content'],
      }
      for index, item in enumerate(questions, start=1)
    ]

  def _page_texts(self, markdown: str, blocks: list[dict[str, Any]]) -> list[tuple[int, str]]:
    by_page: dict[int, list[str]] = defaultdict(list)
    for block in blocks:
      page_number = int(block.get('pageNumber') or 0)
      text = str(block.get('text') or '').strip()
      if page_number > 0 and text:
        by_page[page_number].append(text)
    if by_page:
      return [(page, '\n\n'.join(parts)) for page, parts in sorted(by_page.items())]
    return [(1, markdown)] if markdown.strip() else []

  def _split_page(self, text: str, page_number: int) -> list[dict[str, Any]]:
    normalized = text.strip()
    starts = [match.start() for match in self._QUESTION_START.finditer(normalized)]
    if len(starts) < 2:
      return [self._draft(normalized, page_number)] if normalized else []
    starts.append(len(normalized))
    return [
      self._draft(normalized[starts[index]:starts[index + 1]].strip(), page_number)
      for index in range(len(starts) - 1)
      if normalized[starts[index]:starts[index + 1]].strip()
    ]

  @staticmethod
  def _draft(content: str, page_number: int) -> dict[str, Any]:
    first_line = next((line.strip() for line in content.splitlines() if line.strip()), '')
    return {
      'page_number': page_number,
      'title': first_line[:120] or f'第 {page_number} 页题目',
      'anchor_text': first_line[:180],
      'content': content,
    }


class ExtractedQuestionGroup(BaseModel):
  """One question represented only by references to immutable source segments."""
  model_config = ConfigDict(extra='forbid')
  title: str = Field(max_length=200)
  segment_ids: list[str] = Field(min_length=1)
  continues_from_previous: bool
  continues_to_next: bool


class QuestionSegmentation(BaseModel):
  model_config = ConfigDict(extra='forbid')
  questions: list[ExtractedQuestionGroup]
  ignored_segment_ids: list[str]


class ConsolidatedQuestionGroup(BaseModel):
  """A final question assembled from provisional question fragments."""
  model_config = ConfigDict(extra='forbid')
  title: str = Field(max_length=200)
  group_ids: list[str] = Field(min_length=1)


class QuestionConsolidation(BaseModel):
  model_config = ConfigDict(extra='forbid')
  questions: list[ConsolidatedQuestionGroup] = Field(min_length=1)


class AIQuestionExtractor:
  """Use the text model to group MinerU source segments into complete questions."""

  def __init__(self, max_batch_chars: int = 12000, max_batch_segments: int = 100) -> None:
    self.max_batch_chars = max(1000, max_batch_chars)
    self.max_batch_segments = max(10, max_batch_segments)
    self.last_model = ''

  def extract(
    self,
    markdown: str,
    blocks: list[dict[str, Any]],
    document_id: str = '',
  ) -> list[dict[str, Any]]:
    segments = self._source_segments(markdown, blocks)
    if not segments:
      return []

    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      raise HTTPException(
        status_code=422,
        detail='Text model configuration is required for AI question segmentation.',
      )
    self.last_model = model
    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    batches = self._batches(segments)
    grouped: list[dict[str, Any]] = []
    for batch_index, batch in enumerate(batches):
      next_groups = self._segment_batch(
        root=root,
        api_key=api_key,
        model=model,
        segments=batch,
        batch_index=batch_index,
        batch_count=len(batches),
      )
      if (
        grouped
        and next_groups
        and (
          bool(grouped[-1].get('continues_to_next'))
          or bool(next_groups[0].get('continues_from_previous'))
        )
      ):
        previous = grouped[-1]
        continuation = next_groups.pop(0)
        previous['segment_ids'].extend(continuation['segment_ids'])
        previous['continues_to_next'] = continuation['continues_to_next']
        if not str(previous.get('title') or '').strip():
          previous['title'] = continuation['title']
      grouped.extend(next_groups)

    segment_by_id = {str(segment['segment_id']): segment for segment in segments}
    grouped = self._consolidate_groups(
      root=root,
      api_key=api_key,
      model=model,
      groups=grouped,
      segment_by_id=segment_by_id,
    )
    questions: list[dict[str, Any]] = []
    for index, group in enumerate(grouped, start=1):
      source_segments = [
        segment_by_id[segment_id]
        for segment_id in group['segment_ids']
        if segment_id in segment_by_id
      ]
      if not source_segments:
        continue
      page_numbers = list(dict.fromkeys(
        int(segment['page_number'])
        for segment in source_segments
        if int(segment['page_number']) > 0
      ))
      block_ids = list(dict.fromkeys(
        str(segment['block_id'])
        for segment in source_segments
        if str(segment.get('block_id') or '')
      ))
      content = '\n'.join(str(segment['text']) for segment in source_segments).strip()
      anchor_segment = next(
        (
          segment
          for segment in source_segments
          if segment.get('kind') in {'text', 'title'} and str(segment.get('text') or '').strip()
        ),
        source_segments[0],
      )
      stable_source = ','.join(str(segment['segment_id']) for segment in source_segments)
      question_id = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f'{document_id or "question-document"}:{stable_source}',
      ).hex
      questions.append({
        'question_id': question_id,
        'index': index,
        'page_number': page_numbers[0] if page_numbers else 1,
        'end_page_number': page_numbers[-1] if page_numbers else 1,
        'page_numbers': page_numbers or [1],
        'title': str(group.get('title') or '').strip()[:200] or f'Question {index}',
        'anchor_text': str(anchor_segment.get('text') or '').strip()[:180],
        'anchor_block_id': str(anchor_segment.get('block_id') or ''),
        'content': content,
        'source_segment_ids': [str(segment['segment_id']) for segment in source_segments],
        'source_block_ids': block_ids,
        'extraction': {
          'method': 'ai-mineru-segment-grouping',
          'model': model,
          'version': QUESTION_EXTRACTION_VERSION,
        },
      })
    return questions

  @staticmethod
  def _source_segments(markdown: str, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    source_blocks = blocks or [{
      'id': 'markdown-page-1',
      'pageNumber': 1,
      'kind': 'text',
      'text': markdown,
    }]
    for block_index, block in enumerate(source_blocks, start=1):
      text = str(block.get('text') or '').strip()
      if not text:
        continue
      block_id = str(block.get('id') or f'block-{block_index}')
      page_number = max(1, int(block.get('pageNumber') or 1))
      kind = str(block.get('kind') or 'text')
      parts = [part.strip() for part in text.splitlines() if part.strip()] or [text]
      for part in parts:
        for start in range(0, len(part), 2000):
          value = part[start:start + 2000].strip()
          if not value:
            continue
          segments.append({
            'segment_id': f'segment-{len(segments) + 1:06d}',
            'block_id': block_id,
            'page_number': page_number,
            'kind': kind,
            'text': value,
          })
    return segments

  def _batches(self, segments: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    current_chars = 0
    for segment in segments:
      segment_chars = len(str(segment.get('text') or '')) + 120
      if current and (
        len(current) >= self.max_batch_segments
        or current_chars + segment_chars > self.max_batch_chars
      ):
        batches.append(current)
        current = []
        current_chars = 0
      current.append(segment)
      current_chars += segment_chars
    if current:
      batches.append(current)
    return batches

  def _segment_batch(
    self,
    *,
    root: str,
    api_key: str,
    model: str,
    segments: list[dict[str, Any]],
    batch_index: int,
    batch_count: int,
  ) -> list[dict[str, Any]]:
    schema = QuestionSegmentation.model_json_schema()
    request_context = {
      'window_index': batch_index + 1,
      'window_count': batch_count,
      'has_previous_window': batch_index > 0,
      'has_next_window': batch_index + 1 < batch_count,
      'segments': segments,
    }
    messages = [
      {
        'role': 'system',
        'content': (
          'You reconstruct complete exam or homework questions from ordered MinerU source segments. '
          'Return only JSON matching the schema. Assign every segment ID exactly once: either to one question '
          'or to ignored_segment_ids for covers, page headers, footers, and unrelated metadata. '
          'A question must include its statement, subquestions, choices, formulas, tables, image placeholders, '
          'and any answer or explanation that belongs to it. Never split a question merely because the page or '
          'MinerU block changes, and never combine separate numbered questions. Preserve source order. '
          'For answer-key or worked-solution PDFs, treat each numbered solution as one question record even when '
          'the original prompt is absent. Multiple official answers or alternative solutions labelled Answer, '
          'Solution 1, Solution 2, Solution 3, or with a student name all belong to the same preceding problem; '
          'they are not separate questions. Copy a short existing question number or heading into title; do not '
          'invent a summary. Represent membership with segment IDs only and never rewrite, solve, or correct text. '
          'Set continues_from_previous or continues_to_next only when a question is cut by this window boundary.'
        ),
      },
      {
        'role': 'user',
        'content': json.dumps({
          'json_schema': schema,
          'source_window': request_context,
        }, ensure_ascii=False),
      },
    ]
    content = self._chat_json(root, api_key, model, schema, messages)
    try:
      return self._validate_segmentation(content, segments)
    except (ValidationError, ValueError) as first_error:
      repair_messages = [
        {
          'role': 'system',
          'content': (
            'Repair the question segmentation JSON. Use only the supplied segment IDs, assign each ID exactly '
            'once, preserve order, and return JSON only. Do not rewrite any source text.'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps({
            'json_schema': schema,
            'validation_error': str(first_error),
            'invalid_response': content,
            'source_window': request_context,
          }, ensure_ascii=False),
        },
      ]
      repaired = self._chat_json(root, api_key, model, schema, repair_messages)
      try:
        return self._validate_segmentation(repaired, segments)
      except (ValidationError, ValueError) as repair_error:
        raise HTTPException(
          status_code=502,
          detail=f'Text model returned invalid question segmentation after repair: {repair_error}',
        ) from repair_error

  @staticmethod
  def _chat_json(
    root: str,
    api_key: str,
    model: str,
    schema: dict[str, Any],
    messages: list[dict[str, str]],
  ) -> str:
    payload: dict[str, Any] = {
      'model': model,
      'temperature': 0,
      'messages': messages,
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'question_segmentation', 'strict': True, 'schema': schema},
      },
    }
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
      if response.status_code == 400:
        payload.pop('response_format', None)
        response = requests.post(
          f'{root}/chat/completions',
          headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
          json=payload,
          timeout=120,
        )
    response.raise_for_status()
    return str(
      (((response.json().get('choices') or [{}])[0].get('message') or {}).get('content') or '')
    ).strip()

  @staticmethod
  def _normalize_model_list(value: Any) -> Any:
    """Unwrap list containers emitted by some OpenAI-compatible providers."""
    if isinstance(value, list):
      return value
    if isinstance(value, dict):
      for key in ('item', 'items', 'value', 'values'):
        nested = value.get(key)
        if isinstance(nested, list):
          return nested
    return value

  @classmethod
  def _validate_segmentation(
    cls,
    content: str,
    segments: list[dict[str, Any]],
  ) -> list[dict[str, Any]]:
    payload = QuestionAnalyzer._extract_json_object(content)
    for wrapper in ('segmentation', 'result', 'data'):
      wrapped = payload.get(wrapper)
      if isinstance(wrapped, dict) and 'questions' not in payload:
        payload = wrapped
        break
    payload = dict(payload)
    payload['ignored_segment_ids'] = cls._normalize_model_list(
      payload.get('ignored_segment_ids')
    )
    payload['questions'] = cls._normalize_model_list(payload.get('questions'))
    if isinstance(payload['questions'], list):
      payload['questions'] = [
        {
          **question,
          'segment_ids': cls._normalize_model_list(question.get('segment_ids')),
        }
        if isinstance(question, dict)
        else question
        for question in payload['questions']
      ]
    segmentation = QuestionSegmentation.model_validate(payload)
    ordered_ids = [str(segment['segment_id']) for segment in segments]
    positions = {segment_id: index for index, segment_id in enumerate(ordered_ids)}
    assigned = [
      segment_id
      for question in segmentation.questions
      for segment_id in question.segment_ids
    ] + segmentation.ignored_segment_ids
    unknown = sorted(set(assigned) - set(ordered_ids))
    counts = {segment_id: assigned.count(segment_id) for segment_id in set(assigned)}
    duplicates = sorted(segment_id for segment_id, count in counts.items() if count > 1)
    missing = [segment_id for segment_id in ordered_ids if segment_id not in assigned]
    if unknown or duplicates or missing:
      raise ValueError(
        f'Invalid segment assignment; unknown={unknown}, duplicates={duplicates}, missing={missing}'
      )

    groups = [
      question.model_dump() | {
        'segment_ids': sorted(question.segment_ids, key=positions.__getitem__),
      }
      for question in segmentation.questions
    ]
    groups.sort(key=lambda group: positions[group['segment_ids'][0]])
    return groups

  def _consolidate_groups(
    self,
    *,
    root: str,
    api_key: str,
    model: str,
    groups: list[dict[str, Any]],
    segment_by_id: dict[str, dict[str, Any]],
  ) -> list[dict[str, Any]]:
    if len(groups) <= 1:
      return groups
    provisional = []
    for index, group in enumerate(groups, start=1):
      source_segments = [
        segment_by_id[segment_id]
        for segment_id in group.get('segment_ids') or []
        if segment_id in segment_by_id
      ]
      content = '\n'.join(str(segment.get('text') or '') for segment in source_segments)
      pages = list(dict.fromkeys(
        int(segment.get('page_number') or 0)
        for segment in source_segments
        if int(segment.get('page_number') or 0) > 0
      ))
      provisional.append({
        'group_id': f'group-{index:04d}',
        'title': str(group.get('title') or ''),
        'page_numbers': pages,
        'content_head': content[:1000],
        'content_tail': content[-400:] if len(content) > 1000 else '',
      })

    schema = QuestionConsolidation.model_json_schema()
    messages = [
      {
        'role': 'system',
        'content': (
          'You consolidate provisional fragments from one complete homework or exam PDF into final questions. '
          'Return only JSON matching the schema and assign every group_id exactly once. '
          'A final question begins at an explicit main problem statement or main problem number. '
          'Fragments beginning with Answer, Solution, Solution 1/2/3, a student name, derivation, continuation, '
          'or a page break are never independent questions; merge them into the nearest preceding main problem. '
          'Multiple alternative solutions to one numbered problem must remain in that one question. '
          'Do not merge two different explicit main problem numbers. Preserve document order. '
          'Copy the main problem number and heading for title; do not invent or summarize content.'
        ),
      },
      {
        'role': 'user',
        'content': json.dumps({
          'json_schema': schema,
          'provisional_groups': provisional,
        }, ensure_ascii=False),
      },
    ]
    content = self._chat_json(root, api_key, model, schema, messages)
    try:
      return self._validate_consolidation(content, groups)
    except (ValidationError, ValueError) as first_error:
      repair_messages = [
        {
          'role': 'system',
          'content': (
            'Repair the final question consolidation JSON. Assign every group_id exactly once and preserve order. '
            'All answer and alternative-solution fragments must be merged into their preceding main problem. '
            'Only an explicit new main problem statement may start another final question.'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps({
            'json_schema': schema,
            'validation_error': str(first_error),
            'invalid_response': content,
            'provisional_groups': provisional,
          }, ensure_ascii=False),
        },
      ]
      repaired = self._chat_json(root, api_key, model, schema, repair_messages)
      try:
        return self._validate_consolidation(repaired, groups)
      except (ValidationError, ValueError) as repair_error:
        raise HTTPException(
          status_code=502,
          detail=f'Text model returned invalid full-document question consolidation: {repair_error}',
        ) from repair_error

  @classmethod
  def _validate_consolidation(
    cls,
    content: str,
    groups: list[dict[str, Any]],
  ) -> list[dict[str, Any]]:
    payload = QuestionAnalyzer._extract_json_object(content)
    for wrapper in ('consolidation', 'result', 'data'):
      wrapped = payload.get(wrapper)
      if isinstance(wrapped, dict) and 'questions' not in payload:
        payload = wrapped
        break
    payload = dict(payload)
    payload['questions'] = cls._normalize_model_list(payload.get('questions'))
    if isinstance(payload['questions'], list):
      payload['questions'] = [
        {
          **question,
          'group_ids': cls._normalize_model_list(question.get('group_ids')),
        }
        if isinstance(question, dict)
        else question
        for question in payload['questions']
      ]
    consolidation = QuestionConsolidation.model_validate(payload)
    ordered_ids = [f'group-{index:04d}' for index in range(1, len(groups) + 1)]
    positions = {group_id: index for index, group_id in enumerate(ordered_ids)}
    assigned = [
      group_id
      for question in consolidation.questions
      for group_id in question.group_ids
    ]
    unknown = sorted(set(assigned) - set(ordered_ids))
    counts = {group_id: assigned.count(group_id) for group_id in set(assigned)}
    duplicates = sorted(group_id for group_id, count in counts.items() if count > 1)
    missing = [group_id for group_id in ordered_ids if group_id not in assigned]
    if unknown or duplicates or missing:
      raise ValueError(
        f'Invalid provisional group assignment; unknown={unknown}, '
        f'duplicates={duplicates}, missing={missing}'
      )

    final_groups: list[dict[str, Any]] = []
    previous_end = -1
    for question in consolidation.questions:
      group_ids = sorted(question.group_ids, key=positions.__getitem__)
      group_positions = [positions[group_id] for group_id in group_ids]
      if group_positions != list(range(group_positions[0], group_positions[-1] + 1)):
        raise ValueError(f'Final question groups must be contiguous: {group_ids}')
      if group_positions[0] <= previous_end:
        raise ValueError('Final questions are not in document order.')
      previous_end = group_positions[-1]
      source_groups = [groups[position] for position in group_positions]
      final_groups.append({
        'title': question.title,
        'segment_ids': [
          segment_id
          for source_group in source_groups
          for segment_id in source_group.get('segment_ids') or []
        ],
        'continues_from_previous': False,
        'continues_to_next': False,
      })
    return final_groups


class QuestionAnalyzer:
  _TOP_LEVEL_FIELDS = set(QuestionAnalysis.model_fields)
  _DIFFICULTY_FIELDS = set(Difficulty.model_fields)

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
  def _normalize_analysis_payload(cls, payload: dict[str, Any]) -> dict[str, Any]:
    """Repair common OpenAI-compatible provider schema drift before validation."""
    for wrapper in ('analysis', 'question_analysis', 'result', 'data'):
      wrapped = payload.get(wrapper)
      if isinstance(wrapped, dict) and not cls._TOP_LEVEL_FIELDS.intersection(payload):
        payload = wrapped
        break

    normalized = dict(payload)
    difficulty = normalized.get('difficulty')
    if isinstance(difficulty, dict):
      difficulty = dict(difficulty)
      # MiniMax occasionally nests all fields below difficulty even though the
      # supplied schema defines them as siblings.
      for field in cls._TOP_LEVEL_FIELDS - {'difficulty'}:
        if field not in normalized and field in difficulty:
          normalized[field] = difficulty.pop(field)
      normalized['difficulty'] = {
        key: value for key, value in difficulty.items() if key in cls._DIFFICULTY_FIELDS
      }

    # Provider-added labels such as `item` are not part of the persisted schema.
    return {key: value for key, value in normalized.items() if key in cls._TOP_LEVEL_FIELDS}

  @classmethod
  def _validate_content(cls, content: str) -> QuestionAnalysis:
    payload = cls._extract_json_object(content)
    return QuestionAnalysis.model_validate(cls._normalize_analysis_payload(payload))

  @staticmethod
  def _post_chat(root: str, api_key: str, payload: dict[str, Any]) -> requests.Response:
    return requests.post(
      f'{root}/chat/completions',
      headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
      json=payload,
      timeout=120,
    )

  @staticmethod
  def _response_content(response: requests.Response) -> str:
    return str((((response.json().get('choices') or [{}])[0].get('message') or {}).get('content') or '')).strip()

  def analyze(self, question: dict[str, Any]) -> QuestionAnalysis:
    config = load_api_config() or {}
    base_url = str(config.get('baseUrl') or '').strip()
    api_key = str(config.get('apiKey') or '').strip()
    model = str(config.get('model') or '').strip()
    if not base_url or not api_key or not model:
      raise HTTPException(status_code=422, detail='Text model configuration is required for question analysis.')

    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url.rstrip('/'))
    schema = QuestionAnalysis.model_json_schema()
    expected_shape = {
      'question_type': '计算题/选择题/证明题等',
      'difficulty': {'level': 1, 'reason': '难度判断理由'},
      'knowledge_points': [],
      'formulas': [],
      'chapter': '',
      'prerequisites': [],
      'skills': [],
      'summary': '',
    }
    payload = {
      'model': model,
      'temperature': 0.1,
      'messages': [
        {
          'role': 'system',
          'content': (
            'You are a rigorous educational assessment analyst. Analyze exactly one question. '
            'Return only JSON that conforms to the provided schema. Do not solve the question. '
            'Use concise Chinese terms when the source is Chinese. Difficulty level is 1 to 5. '
            'Only include knowledge points, formulas, prerequisites, and skills supported by the question text; '
            'use empty arrays when evidence is absent. The difficulty object MUST contain exactly level and reason. '
            'question_type, knowledge_points, formulas, chapter, prerequisites, skills, and summary MUST be siblings '
            'of difficulty, never children of difficulty. Do not add fields such as item, result, or explanation.'
          ),
        },
        {
          'role': 'user',
          'content': json.dumps({
            'json_schema': schema,
            'required_output_shape': expected_shape,
            'question': {
              'title': question['title'],
              'page_number': question['page_number'],
              'content': question['content'],
            },
          }, ensure_ascii=False),
        },
      ],
      'response_format': {
        'type': 'json_schema',
        'json_schema': {'name': 'question_analysis', 'strict': True, 'schema': schema},
      },
    }
    response = self._post_chat(root, api_key, payload)
    if response.status_code == 400:
      # MiniMax and some compatible gateways support json_object but reject
      # OpenAI's stricter json_schema response format.
      fallback_payload = {**payload, 'response_format': {'type': 'json_object'}}
      response = self._post_chat(root, api_key, fallback_payload)
      if response.status_code == 400:
        unstructured_payload = {
          key: value for key, value in fallback_payload.items() if key != 'response_format'
        }
        response = self._post_chat(root, api_key, unstructured_payload)
    response.raise_for_status()
    content = self._response_content(response)
    try:
      return self._validate_content(content)
    except (ValidationError, ValueError) as first_error:
      repair_payload = {
        'model': model,
        'temperature': 0,
        'messages': [
          {
            'role': 'system',
            'content': (
              'Repair a JSON response for question analysis. Return one JSON object only. '
              'Do not add facts and do not solve the question. difficulty contains only level and reason. '
              'All other fields are top-level siblings.'
            ),
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
      repair_response = self._post_chat(root, api_key, repair_payload)
      if repair_response.status_code == 400:
        unstructured_repair_payload = {
          key: value for key, value in repair_payload.items() if key != 'response_format'
        }
        repair_response = self._post_chat(root, api_key, unstructured_repair_payload)
      repair_response.raise_for_status()
      repaired_content = self._response_content(repair_response)
      try:
        return self._validate_content(repaired_content)
      except (ValidationError, ValueError) as repair_error:
        raise HTTPException(
          status_code=502,
          detail=f'Text model returned invalid question analysis after repair: {repair_error}',
        ) from repair_error


class QuestionPipeline:
  def __init__(
    self,
    parser: DocumentParser | None = None,
    extractor: AIQuestionExtractor | QuestionExtractor | None = None,
    analyzer: QuestionAnalyzer | None = None,
    embedding: ApiEmbeddingProvider | None = None,
    vector_store: QdrantVectorStore | None = None,
  ) -> None:
    self.parser = parser or LocalMinerUParser()
    self.extractor = extractor or AIQuestionExtractor()
    self.analyzer = analyzer or QuestionAnalyzer()
    self.embedding = embedding or ApiEmbeddingProvider()
    self.vector_store = vector_store or QdrantVectorStore()

  def _dir(self, document_id: str) -> Path:
    safe_id = re.sub(r'[^A-Za-z0-9._-]+', '-', document_id).strip('.-')
    return QUESTION_DOCUMENTS_ROOT / (safe_id or uuid.uuid4().hex)

  def submit(self, source: bytes, file_name: str, course_id: str, document_type: str, document_id: str | None = None) -> dict[str, Any]:
    if document_type not in {'homework', 'past-exam', 'exercise-set'}:
      raise HTTPException(status_code=422, detail='document_type must be homework, past-exam, or exercise-set.')
    document_id = document_id or uuid.uuid4().hex
    directory = self._dir(document_id)
    directory.mkdir(parents=True, exist_ok=True)
    source_file = _question_source_file_name(file_name)
    (directory / source_file).write_bytes(source)
    state = {
      'document_id': document_id, 'document_name': file_name, 'course_id': course_id,
      'document_type': document_type, 'status': 'queued', 'parser_status': 'pending',
      'source_file': source_file,
      'source_type': 'image' if Path(source_file).suffix != '.pdf' else 'pdf',
      'extraction_status': 'pending',
      'analysis_status': 'pending', 'embedding_status': 'pending', 'vector_status': 'pending',
      'question_count': 0, 'embedding_completed_questions': 0,
      'vector_completed_questions': 0, 'vector_completed_question_ids': [],
      'updated_at': time.time(), 'error': '',
    }
    self._write(directory / 'state.json', state)
    return self.run(document_id)

  def run(self, document_id: str) -> dict[str, Any]:
    directory = self._dir(document_id)
    state = self._read(directory / 'state.json')
    if not state:
      raise HTTPException(status_code=404, detail='Question pipeline job not found.')
    try:
      if state.get('parser_status') != 'completed':
        state.update({'parser_status': 'processing', 'status': 'parsing', 'error': '', 'updated_at': time.time()})
        self._write(directory / 'state.json', state)
        source_file = Path(str(state.get('source_file') or 'source.pdf')).name
        parsed = self.parser.parse(directory / source_file)
        markdown, blocks, page_count = _archive_result(parsed['archive'], directory)
        self._write(directory / 'document.json', {
          'document_id': document_id, 'document_name': state['document_name'], 'course_id': state['course_id'],
          'document_type': state['document_type'], 'source_type': state.get('source_type', 'pdf'),
          'page_count': page_count, 'mineru_batch_id': parsed.get('batch_id'),
        })
        self._write(directory / 'layout-blocks.json', blocks)
        state.update({
          'parser_status': 'completed',
          'extraction_status': 'pending',
          'status': 'extracting_questions',
          'page_count': page_count,
          'updated_at': time.time(),
          'error': '',
        })
        self._write(directory / 'state.json', state)

      if (
        state.get('extraction_status') != 'completed'
        or int(state.get('extraction_version') or 0) < QUESTION_EXTRACTION_VERSION
      ):
        markdown_path = directory / 'mineru' / 'artifacts' / 'full.md'
        markdown = markdown_path.read_text(encoding='utf-8') if markdown_path.is_file() else ''
        blocks_path = directory / 'layout-blocks.json'
        blocks = json.loads(blocks_path.read_text(encoding='utf-8')) if blocks_path.is_file() else []
        state.update({'status': 'extracting_questions', 'extraction_status': 'processing'})
        self._write(directory / 'state.json', state)
        questions = self.extractor.extract(markdown, blocks, document_id=document_id)
        if not questions:
          raise HTTPException(status_code=422, detail='AI QuestionExtractor found no questions.')
        self.vector_store.delete_document(document_id, collection_name=QUESTION_COLLECTION)
        embeddings_path = directory / QUESTION_EMBEDDINGS_FILE
        if embeddings_path.is_file():
          embeddings_path.unlink()
        self._save_questions(directory, questions)
        state.update({
          'extraction_status': 'completed',
          'extraction_version': QUESTION_EXTRACTION_VERSION,
          'extraction_model': str(getattr(self.extractor, 'last_model', '') or ''),
          'analysis_status': 'pending',
          'embedding_status': 'pending',
          'vector_status': 'pending',
          'status': 'analyzing',
          'question_count': len(questions),
          'embedding_completed_questions': 0,
          'vector_completed_questions': 0,
          'vector_completed_question_ids': [],
          'updated_at': time.time(),
          'error': '',
        })
        self._write(directory / 'state.json', state)

      questions = json.loads((directory / 'questions.json').read_text(encoding='utf-8'))
      if state.get('analysis_status') != 'completed':
        state.update({'analysis_status': 'processing', 'status': 'analyzing', 'error': '', 'updated_at': time.time()})
        self._write(directory / 'state.json', state)
        for question in questions:
          if 'analysis' not in question:
            question['analysis'] = self.analyzer.analyze(question).model_dump()
            self._write(directory / 'questions.json', questions)
            self._write_question_file(directory, question)
        state.update({
          'analysis_status': 'completed',
          'embedding_status': 'pending',
          'vector_status': 'pending',
          'status': 'embedding',
          'error': '',
          'updated_at': time.time(),
        })
        self._write(directory / 'state.json', state)

      embeddings_path = directory / QUESTION_EMBEDDINGS_FILE
      vectors_by_question = self._read_embeddings(embeddings_path)
      question_ids = [str(question['question_id']) for question in questions]
      missing_embeddings = [
        question for question in questions
        if str(question['question_id']) not in vectors_by_question
      ]
      if state.get('embedding_status') != 'completed' or missing_embeddings:
        state.update({
          'embedding_status': 'processing',
          'vector_status': 'pending',
          'status': 'embedding',
          'embedding_completed_questions': len(questions) - len(missing_embeddings),
          'error': '',
          'updated_at': time.time(),
        })
        self._write(directory / 'state.json', state)
        for start in range(0, len(missing_embeddings), QUESTION_CHECKPOINT_BATCH_SIZE):
          batch = missing_embeddings[start:start + QUESTION_CHECKPOINT_BATCH_SIZE]
          vectors = self.embedding.embed([self._embedding_text(question) for question in batch])
          if len(vectors) != len(batch):
            raise HTTPException(status_code=502, detail='Embedding API returned incomplete question vectors.')
          for question, vector in zip(batch, vectors, strict=True):
            vectors_by_question[str(question['question_id'])] = vector
          self._write(embeddings_path, vectors_by_question)
          state.update({
            'embedding_completed_questions': len(vectors_by_question),
            'updated_at': time.time(),
          })
          self._write(directory / 'state.json', state)
        state.update({
          'embedding_status': 'completed',
          'vector_status': 'pending',
          'status': 'vector',
          'embedding_completed_questions': len(question_ids),
          'updated_at': time.time(),
        })
        self._write(directory / 'state.json', state)

      if state.get('vector_status') != 'completed':
        completed_ids = {
          str(value) for value in state.get('vector_completed_question_ids') or [] if str(value)
        }
        pending_questions = [
          question for question in questions if str(question['question_id']) not in completed_ids
        ]
        state.update({
          'vector_status': 'processing',
          'status': 'vector',
          'vector_completed_questions': len(completed_ids),
          'error': '',
          'updated_at': time.time(),
        })
        self._write(directory / 'state.json', state)
        for start in range(0, len(pending_questions), QUESTION_CHECKPOINT_BATCH_SIZE):
          batch = pending_questions[start:start + QUESTION_CHECKPOINT_BATCH_SIZE]
          points = [self._vector_point(question, vectors_by_question[str(question['question_id'])], state) for question in batch]
          self.vector_store.upsert(points, collection_name=QUESTION_COLLECTION)
          completed_ids.update(str(question['question_id']) for question in batch)
          state.update({
            'vector_completed_question_ids': sorted(completed_ids),
            'vector_completed_questions': len(completed_ids),
            'updated_at': time.time(),
          })
          self._write(directory / 'state.json', state)
        state.update({'vector_status': 'completed', 'status': 'completed', 'updated_at': time.time(), 'error': ''})
    except Exception as exc:  # noqa: BLE001
      if state.get('parser_status') != 'completed':
        stage = 'parser'
      elif state.get('extraction_status') != 'completed':
        stage = 'extraction'
      elif state.get('analysis_status') != 'completed':
        stage = 'analysis'
      elif state.get('embedding_status') != 'completed':
        stage = 'embedding'
      else:
        stage = 'vector'
      state.update({
        'status': f'{stage}_failed',
        f'{stage}_status': 'failed',
        'error': str(getattr(exc, 'detail', exc)),
        'updated_at': time.time(),
      })
    self._write(directory / 'state.json', state)
    return state

  def result(self, document_id: str) -> dict[str, Any]:
    directory = self._dir(document_id)
    state = self._read(directory / 'state.json')
    if not state:
      raise HTTPException(status_code=404, detail='Question pipeline job not found.')
    return {
      **state,
      'questions': json.loads((directory / 'questions.json').read_text(encoding='utf-8')) if (directory / 'questions.json').is_file() else [],
      'question_files': [
        str(path.relative_to(directory)).replace('\\', '/')
        for path in sorted((directory / QUESTION_FILES_DIRECTORY).glob('*.json'))
      ] if (directory / QUESTION_FILES_DIRECTORY).is_dir() else [],
      'markdown': (directory / 'mineru' / 'artifacts' / 'full.md').read_text(encoding='utf-8') if (directory / 'mineru' / 'artifacts' / 'full.md').is_file() else '',
      'layout_blocks': json.loads((directory / 'layout-blocks.json').read_text(encoding='utf-8')) if (directory / 'layout-blocks.json').is_file() else [],
    }

  def status(self, document_id: str) -> dict[str, Any]:
    state = self._read(self._dir(document_id) / 'state.json')
    if not state:
      raise HTTPException(status_code=404, detail='Question pipeline job not found.')
    return state

  def prepare_reextract(self, document_id: str) -> dict[str, Any]:
    """Keep MinerU artifacts and rerun only AI segmentation and downstream stages."""
    directory = self._dir(document_id)
    state = self._read(directory / 'state.json')
    if not state:
      raise HTTPException(status_code=404, detail='Question pipeline job not found.')
    if state.get('parser_status') != 'completed':
      raise HTTPException(status_code=409, detail='MinerU parsing must complete before question re-extraction.')
    self.vector_store.delete_document(document_id, collection_name=QUESTION_COLLECTION)
    questions_path = directory / 'questions.json'
    if questions_path.is_file():
      questions_path.unlink()
    question_files = directory / QUESTION_FILES_DIRECTORY
    if question_files.is_dir():
      shutil.rmtree(question_files)
    embeddings_path = directory / QUESTION_EMBEDDINGS_FILE
    if embeddings_path.is_file():
      embeddings_path.unlink()
    state.update({
      'status': 'extracting_questions',
      'extraction_status': 'pending',
      'extraction_version': 0,
      'analysis_status': 'pending',
      'embedding_status': 'pending',
      'vector_status': 'pending',
      'question_count': 0,
      'embedding_completed_questions': 0,
      'vector_completed_questions': 0,
      'vector_completed_question_ids': [],
      'updated_at': time.time(),
      'error': '',
    })
    self._write(directory / 'state.json', state)
    return state

  def delete(self, document_id: str) -> None:
    self.vector_store.delete_document(document_id, collection_name=QUESTION_COLLECTION)
    directory = self._dir(document_id)
    if directory.is_dir():
      shutil.rmtree(directory)

  def delete_course(self, course_id: str) -> None:
    """Remove orphaned question jobs that belong to a deleted course."""
    normalized_course_id = str(course_id or '').strip()
    if not normalized_course_id or not QUESTION_DOCUMENTS_ROOT.is_dir():
      return
    document_ids = []
    for directory in QUESTION_DOCUMENTS_ROOT.iterdir():
      if not directory.is_dir():
        continue
      state = self._read(directory / 'state.json')
      if str(state.get('course_id') or '') == normalized_course_id:
        document_ids.append(str(state.get('document_id') or directory.name))
    for document_id in document_ids:
      self.delete(document_id)

  def pending_document_ids(self) -> list[str]:
    """Return recoverable jobs without touching completed or failed jobs."""
    if not QUESTION_DOCUMENTS_ROOT.is_dir():
      return []
    pending: list[str] = []
    for directory in QUESTION_DOCUMENTS_ROOT.iterdir():
      if not directory.is_dir():
        continue
      state = self._read(directory / 'state.json')
      if state.get('status') in {
        'queued',
        'parsing',
        'extracting_questions',
        'analyzing',
        'embedding',
        'vector',
      }:
        pending.append(str(state.get('document_id') or directory.name))
    return pending

  def resume_pending(self) -> int:
    resumed_count = 0
    for document_id in self.pending_document_ids():
      directory = self._dir(document_id)
      if not QUESTION_DOCUMENTS_ROOT.is_dir():
        return resumed_count
      state = self._read(directory / 'state.json')
      if not state:
        continue
      updated_at = float(state.get('updated_at') or 0)
      if updated_at and time.time() - updated_at > QUESTION_RESUME_MAX_AGE_SECONDS:
        stage = self._active_stage(state)
        state.update({
          'status': f'{stage}_failed',
          f'{stage}_status': 'failed',
          'error': 'The interrupted question task was stale and was not resumed automatically. Click retry to continue from this stage.',
          'updated_at': time.time(),
        })
        self._write(directory / 'state.json', state)
        continue
      self.run(document_id)
      resumed_count += 1
    return resumed_count

  @staticmethod
  def _active_stage(state: dict[str, Any]) -> str:
    if state.get('parser_status') != 'completed':
      return 'parser'
    if state.get('extraction_status') != 'completed':
      return 'extraction'
    if state.get('analysis_status') != 'completed':
      return 'analysis'
    if state.get('embedding_status') != 'completed':
      return 'embedding'
    return 'vector'

  def _save_questions(self, directory: Path, questions: list[dict[str, Any]]) -> None:
    question_files = directory / QUESTION_FILES_DIRECTORY
    if question_files.is_dir():
      shutil.rmtree(question_files)
    question_files.mkdir(parents=True, exist_ok=True)
    self._write(directory / 'questions.json', questions)
    for question in questions:
      self._write_question_file(directory, question)

  def _write_question_file(self, directory: Path, question: dict[str, Any]) -> None:
    question_id = str(question.get('question_id') or '').strip()
    if not question_id:
      raise ValueError('question_id is required before persisting a question.')
    index = max(1, int(question.get('index') or 1))
    path = directory / QUESTION_FILES_DIRECTORY / f'{index:04d}-{question_id}.json'
    self._write(path, question)

  @staticmethod
  def _read_embeddings(path: Path) -> dict[str, list[float]]:
    if not path.is_file():
      return {}
    try:
      payload = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
      return {}
    if not isinstance(payload, dict):
      return {}
    return {
      str(question_id): vector
      for question_id, vector in payload.items()
      if isinstance(vector, list) and vector
    }

  @staticmethod
  def _vector_point(question: dict[str, Any], vector: list[float], state: dict[str, Any]) -> dict[str, Any]:
    return {
      'id': question['question_id'],
      'vector': vector,
      'payload': {
        'question_id': question['question_id'], 'course_id': state['course_id'],
        'document_id': state['document_id'], 'document_name': state['document_name'],
        'document_type': state['document_type'], 'question_index': question['index'],
        'page_number': question['page_number'], 'title': question['title'], 'content': question['content'],
        'end_page_number': question.get('end_page_number', question['page_number']),
        'page_numbers': question.get('page_numbers') or [question['page_number']],
        'anchor_text': question.get('anchor_text'),
        'anchor_block_id': question.get('anchor_block_id'),
        'source_segment_ids': question.get('source_segment_ids') or [],
        'source_block_ids': question.get('source_block_ids') or [],
        'extraction': question.get('extraction') or {},
        'analysis': question['analysis'],
      },
    }

  @staticmethod
  def _legacy_embedding_text(question: dict[str, Any]) -> str:
    analysis = question.get('analysis') or {}
    return '\n'.join([
      question['content'],
      f"题型：{analysis.get('question_type', '')}",
      f"知识点：{'、'.join(analysis.get('knowledge_points') or [])}",
      f"章节：{analysis.get('chapter', '')}",
      f"技能：{'、'.join(analysis.get('skills') or [])}",
    ]).strip()

  @staticmethod
  def _embedding_text(question: dict[str, Any]) -> str:
    return build_question_retrieval_text(question)

  @staticmethod
  def _read(path: Path) -> dict[str, Any]:
    if not path.is_file():
      return {}
    try:
      payload = json.loads(path.read_text(encoding='utf-8'))
      return payload if isinstance(payload, dict) else {}
    except json.JSONDecodeError:
      return {}

  @staticmethod
  def _write(path: Path, value: Any) -> None:
    _write_json(path, value)
