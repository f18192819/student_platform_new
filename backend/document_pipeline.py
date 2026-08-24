from __future__ import annotations

import io
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from collections import defaultdict
from pathlib import Path
from threading import Event, Lock
from typing import Any, Protocol

import requests
from fastapi import HTTPException
from qdrant_client import QdrantClient, models

from .config import PROJECT_ROOT
from .runtime_config import load_api_config

PIPELINE_ROOT = PROJECT_ROOT / '.runtime' / 'document-pipeline'
DOCUMENTS_ROOT = PIPELINE_ROOT / 'documents'
QDRANT_PATH = Path(os.environ.get('QDRANT_PATH', str(PROJECT_ROOT / '.runtime' / 'qdrant')))

# Embedded Qdrant permits only one client per storage directory. Keep the
# client process-wide so lecture, question, and relation services cannot open
# the same course partition independently.
_QDRANT_CLIENT_LOCK = Lock()
_QDRANT_SHARED_CLIENTS: dict[str, tuple[QdrantClient, int]] = {}
QDRANT_COLLECTION = os.environ.get('QDRANT_COLLECTION', 'course_document_chunks').strip() or 'course_document_chunks'
MAX_CHUNK_CHARS = 1800
# One semantic chunk per request is the safest default for hosted embedding APIs.
# Set DOCUMENT_EMBEDDING_BATCH_SIZE higher only after verifying the provider limit.
EMBEDDING_BATCH_SIZE = max(1, int(os.environ.get('DOCUMENT_EMBEDDING_BATCH_SIZE', '1')))
LOCAL_MINERU_COMMAND = os.environ.get('LOCAL_MINERU_COMMAND', 'mineru').strip() or 'mineru'
LOCAL_MINERU_BACKEND = os.environ.get('LOCAL_MINERU_BACKEND', 'pipeline').strip() or 'pipeline'
LOCAL_MINERU_API_URL = os.environ.get('LOCAL_MINERU_API_URL', 'http://127.0.0.1:8001').strip()
LOCAL_MINERU_TIMEOUT_SECONDS = int(os.environ.get('LOCAL_MINERU_TIMEOUT_SECONDS', '3600'))
LOCAL_MINERU_API_STARTUP_SECONDS = int(os.environ.get('LOCAL_MINERU_API_STARTUP_SECONDS', '300'))
LOCAL_MINERU_MAX_ATTEMPTS = max(1, int(os.environ.get('LOCAL_MINERU_MAX_ATTEMPTS', '2')))
JSON_WRITE_RETRY_COUNT = 6
JSON_WRITE_RETRY_SECONDS = 0.1
_JSON_WRITE_LOCKS: dict[Path, Lock] = {}
_JSON_WRITE_LOCKS_GUARD = Lock()


class DocumentProcessingCancelled(Exception):
  """Raised internally when a user deletes an in-flight document."""


class DocumentParser(Protocol):
  def parse(self, source_pdf: Path, cancel_event: Event | None = None) -> dict[str, Any]: ...


class EmbeddingProvider(Protocol):
  def embed(self, texts: list[str]) -> list[list[float]]: ...


class VectorStore(Protocol):
  def upsert(self, points: list[dict[str, Any]]) -> None: ...
  def search(self, vector: list[float], limit: int, filters: dict[str, Any]) -> list[dict[str, Any]]: ...
  def delete_document(self, document_id: str) -> None: ...


def _safe_name(value: str) -> str:
  cleaned = re.sub(r'[^A-Za-z0-9._-]+', '-', value).strip('.-')
  return cleaned or uuid.uuid4().hex


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
  if not path.is_file():
    return fallback
  try:
    value = json.loads(path.read_text(encoding='utf-8'))
    return value if isinstance(value, dict) else fallback
  except (OSError, json.JSONDecodeError):
    return fallback


def _write_json(path: Path, value: Any) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  target = path.resolve()
  serialized = json.dumps(value, ensure_ascii=False, indent=2)
  with _json_write_lock(target):
    last_error: PermissionError | None = None
    for attempt in range(JSON_WRITE_RETRY_COUNT):
      # A fixed `state.tmp` lets concurrent retries overwrite each other on
      # Windows. A unique sibling is safe for atomic replacement.
      temp = target.with_name(f'.{target.name}.{uuid.uuid4().hex}.tmp')
      try:
        temp.write_text(serialized, encoding='utf-8')
        os.replace(temp, target)
        return
      except PermissionError as exc:
        last_error = exc
        if attempt + 1 < JSON_WRITE_RETRY_COUNT:
          time.sleep(JSON_WRITE_RETRY_SECONDS * (attempt + 1))
      finally:
        try:
          temp.unlink(missing_ok=True)
        except OSError:
          pass
    if last_error is not None:
      raise last_error


def _json_write_lock(path: Path) -> Lock:
  with _JSON_WRITE_LOCKS_GUARD:
    return _JSON_WRITE_LOCKS.setdefault(path, Lock())


def _read_index_progress(path: Path) -> set[str]:
  """Read the durable checkpoint for batches already written to Qdrant."""
  payload = _read_json(path, {})
  chunk_ids = payload.get('indexed_chunk_ids') if isinstance(payload, dict) else []
  return {str(chunk_id) for chunk_id in chunk_ids or [] if str(chunk_id).strip()}


def _write_index_progress(path: Path, chunk_ids: set[str]) -> None:
  _write_json(path, {
    'indexed_chunk_ids': sorted(chunk_ids),
    'updated_at': time.time(),
  })


class LocalMinerUService:
  """Owns the local MinerU API process only when this backend starts it."""

  def __init__(self) -> None:
    self.process: subprocess.Popen[Any] | None = None

  def start(self, environment: dict[str, str] | None = None) -> None:
    if not LOCAL_MINERU_API_URL:
      return
    health_url = f"{LOCAL_MINERU_API_URL.rstrip('/')}/health"
    try:
      requests.get(health_url, timeout=2).raise_for_status()
      return
    except requests.RequestException:
      pass

    if self.process is not None and self.process.poll() is not None:
      self.process = None
    elif self.process is not None:
      # An owned process that no longer answers health checks is not reusable.
      self.stop()

    runtime_environment = environment or os.environ.copy()
    runtime_environment['MINERU_DEVICE_MODE'] = runtime_environment.get('MINERU_DEVICE_MODE', 'cuda') or 'cuda'
    command = [
      sys.executable,
      '-m', 'mineru.cli.fast_api',
      '--host', '127.0.0.1',
      '--port', LOCAL_MINERU_API_URL.rsplit(':', 1)[-1],
    ]
    stdout_path = PROJECT_ROOT / '.runtime' / 'mineru-service.stdout.log'
    stderr_path = PROJECT_ROOT / '.runtime' / 'mineru-service.stderr.log'
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    with stdout_path.open('ab') as stdout_log, stderr_path.open('ab') as stderr_log:
      popen_options: dict[str, Any] = {
        'cwd': str(PROJECT_ROOT),
        'env': runtime_environment,
        'stdout': stdout_log,
        'stderr': stderr_log,
      }
      if os.name == 'nt':
        popen_options['creationflags'] = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
      self.process = subprocess.Popen(command, **popen_options)

    deadline = time.time() + LOCAL_MINERU_API_STARTUP_SECONDS
    while time.time() < deadline:
      try:
        requests.get(health_url, timeout=2).raise_for_status()
        return
      except requests.RequestException:
        time.sleep(1)
    raise HTTPException(status_code=504, detail='Local MinerU API did not become ready in time.')

  def restart(self, environment: dict[str, str] | None = None) -> None:
    self.stop()
    self.start(environment)

  def stop(self) -> None:
    if self.process is None:
      return
    if self.process.poll() is None:
      self.process.terminate()
      try:
        self.process.wait(timeout=10)
      except subprocess.TimeoutExpired:
        self.process.kill()
        self.process.wait(timeout=5)
    self.process = None


local_mineru_service = LocalMinerUService()


class LocalMinerUParser:
  """Runs the locally installed MinerU CLI and archives its native artifacts."""

  def __init__(self, service: LocalMinerUService | None = None) -> None:
    self.service = service or local_mineru_service

  def _ensure_api_ready(self, environment: dict[str, str]) -> None:
    self.service.start(environment)

  @staticmethod
  def _is_transient_failure(detail: str) -> bool:
    normalized = detail.casefold()
    return any(marker in normalized for marker in (
      'server disconnected',
      'connection reset',
      'connection refused',
      'remoteprotocolerror',
      'winerror 10054',
      'timed out',
      'timeout',
      'temporarily unavailable',
      'service unavailable',
    ))

  @staticmethod
  def _stop_process(process: subprocess.Popen[Any]) -> None:
    """Stop the MinerU CLI and its children so a cancelled job releases GPU work."""
    if process.poll() is not None:
      return
    if os.name == 'nt':
      subprocess.run(
        ['taskkill', '/PID', str(process.pid), '/T', '/F'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
      )
      return
    process.terminate()
    try:
      process.wait(timeout=5)
    except subprocess.TimeoutExpired:
      process.kill()

  def parse(
    self,
    source_pdf: Path,
    cancel_event: Event | None = None,
    _attempt: int = 1,
  ) -> dict[str, Any]:
    if cancel_event and cancel_event.is_set():
      raise DocumentProcessingCancelled()
    output_dir = source_pdf.parent / 'mineru-local-output'
    if output_dir.exists():
      shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    # MinerU's Windows HTTP client cannot reliably submit non-ASCII filenames.
    local_source = source_pdf.parent / 'mineru-source.pdf'
    shutil.copyfile(source_pdf, local_source)
    environment = os.environ.copy()
    environment['MINERU_DEVICE_MODE'] = environment.get('MINERU_DEVICE_MODE', 'cuda') or 'cuda'
    self._ensure_api_ready(environment)
    if cancel_event and cancel_event.is_set():
      local_source.unlink(missing_ok=True)
      raise DocumentProcessingCancelled()
    command = [
      LOCAL_MINERU_COMMAND,
      '-p', str(local_source),
      '-o', str(output_dir),
      '-b', LOCAL_MINERU_BACKEND,
      '-m', 'auto',
      '-l', 'ch',
    ]
    if LOCAL_MINERU_API_URL:
      command.extend(['--api-url', LOCAL_MINERU_API_URL])
    try:
      try:
        process = subprocess.Popen(
          command,
          stdout=subprocess.PIPE,
          stderr=subprocess.PIPE,
          text=True,
          encoding='utf-8',
          errors='replace',
          env=environment,
          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0,
        )
      except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail='Local MinerU CLI was not found. Install MinerU or set LOCAL_MINERU_COMMAND.') from exc
      deadline = time.time() + LOCAL_MINERU_TIMEOUT_SECONDS
      while process.poll() is None:
        if cancel_event and cancel_event.is_set():
          self._stop_process(process)
          raise DocumentProcessingCancelled()
        if time.time() >= deadline:
          self._stop_process(process)
          raise HTTPException(status_code=504, detail=f'Local MinerU timed out after {LOCAL_MINERU_TIMEOUT_SECONDS} seconds.')
        time.sleep(0.1)
      stdout, stderr = process.communicate()
      if cancel_event and cancel_event.is_set():
        raise DocumentProcessingCancelled()
    finally:
      local_source.unlink(missing_ok=True)
    if process.returncode != 0:
      detail = (stderr or stdout or 'Local MinerU failed.').strip()
      if (
        _attempt < LOCAL_MINERU_MAX_ATTEMPTS
        and self._is_transient_failure(detail)
        and not (cancel_event and cancel_event.is_set())
      ):
        restart = getattr(self.service, 'restart', None)
        if callable(restart):
          restart(environment)
        else:
          self._ensure_api_ready(environment)
        return self.parse(source_pdf, cancel_event=cancel_event, _attempt=_attempt + 1)
      attempt_suffix = f' after {_attempt} attempts' if _attempt > 1 else ''
      raise HTTPException(
        status_code=502,
        detail=f'Local MinerU failed{attempt_suffix}: {detail[-2000:]}',
      )

    artifact_paths = [path for path in output_dir.rglob('*') if path.is_file()]
    if not any(path.suffix.lower() == '.md' for path in artifact_paths):
      raise HTTPException(status_code=502, detail='Local MinerU did not produce Markdown output.')
    archive_buffer = io.BytesIO()
    with zipfile.ZipFile(archive_buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
      for path in artifact_paths:
        archive.write(path, path.relative_to(output_dir).as_posix())
    return {
      'batch_id': f'local-{uuid.uuid4().hex}',
      'archive': archive_buffer.getvalue(),
      'state': 'done',
    }


def _collect_text(value: Any) -> str:
  if isinstance(value, str):
    return value.strip()
  if isinstance(value, list):
    return '\n'.join(part for item in value if (part := _collect_text(item)))
  if isinstance(value, dict):
    fields = (
      'latex', 'text', 'content', 'title', 'caption', 'footnote',
      'image_caption', 'image_footnote', 'table_caption', 'table_footnote',
      'table_body', 'code_caption', 'code_body', 'code_footnote', 'lines', 'spans',
    )
    return '\n'.join(part for key in fields if (part := _collect_text(value.get(key))))
  return ''


def _block_kind(item: dict[str, Any]) -> str:
  if isinstance(item.get('text_level'), (int, float)) and int(item['text_level']) > 0:
    return 'title'
  value = f"{item.get('type', '')} {item.get('sub_type', '')}".lower()
  if any(token in value for token in ('equation', 'formula', 'latex')):
    return 'formula'
  if 'table' in value:
    return 'table'
  if any(token in value for token in ('title', 'heading')):
    return 'title'
  if any(token in value for token in ('image', 'figure', 'chart')):
    return 'image'
  return 'text'


def _block_bbox(item: dict[str, Any]) -> list[float] | None:
  raw = item.get('bbox') or item.get('box') or item.get('poly')
  try:
    if isinstance(raw, list) and len(raw) >= 8:
      xs = [float(raw[index]) for index in range(0, 8, 2)]
      ys = [float(raw[index]) for index in range(1, 8, 2)]
      bbox = [min(xs), min(ys), max(xs), max(ys)]
    elif isinstance(raw, list) and len(raw) >= 4:
      left, top, right, bottom = (float(value) for value in raw[:4])
      bbox = [min(left, right), min(top, bottom), max(left, right), max(top, bottom)]
    else:
      return None
  except (TypeError, ValueError):
    return None
  return bbox if bbox[2] > bbox[0] and bbox[3] > bbox[1] else None


def _block_image_path(value: Any) -> str:
  """Find MinerU's image path without depending on one output schema version."""
  if isinstance(value, dict):
    for key in ('image_path', 'img_path'):
      candidate = str(value.get(key) or '').strip()
      if candidate:
        return candidate
    for nested in value.values():
      if candidate := _block_image_path(nested):
        return candidate
  elif isinstance(value, list):
    for nested in value:
      if candidate := _block_image_path(nested):
        return candidate
  return ''


def _image_asset_path(raw_path: str, artifact_parent: str) -> str:
  normalized = raw_path.replace('\\', '/').lstrip('/')
  parts = [part for part in normalized.split('/') if part not in {'', '.'}]
  if not parts or '..' in parts:
    return ''
  if len(parts) == 1:
    parts.insert(0, 'images')
  prefix = [part for part in artifact_parent.replace('\\', '/').split('/') if part not in {'', '.'}]
  if '..' in prefix:
    return ''
  return '/'.join([*prefix, *parts])


def _middle_layout_blocks(payload: Any, artifact_parent: str = '') -> list[dict[str, Any]]:
  """Extract page-native PDF coordinates from MinerU's middle.json."""
  if not isinstance(payload, dict):
    return []

  blocks: list[dict[str, Any]] = []
  for page_index, page in enumerate(payload.get('pdf_info') or []):
    if not isinstance(page, dict):
      continue
    page_number = int(page.get('page_idx', page_index)) + 1
    page_blocks = page.get('para_blocks') or page.get('preproc_blocks') or []
    for index, item in enumerate(page_blocks):
      if not isinstance(item, dict):
        continue
      bbox = _block_bbox(item)
      if bbox is None:
        continue
      kind = _block_kind(item)
      label = str(item.get('label') or item.get('type') or kind).strip() or kind
      text = _collect_text(item)
      if not text:
        text = {
          'formula': '[公式区域：未识别到可复制公式文本]',
          'image': '[图片区域：请结合页面图片内容引用]',
          'table': '[表格区域：未识别到可复制表格文本]',
        }.get(kind, label)
      blocks.append({
        'id': f'page-{page_number}-block-{index + 1}',
        'pageNumber': page_number,
        'kind': kind,
        'text': text,
        'label': label,
        'bbox': bbox,
        'coordinateSpace': 'pdf-page',
        'source': 'mineru-local',
      })
      image_path = _block_image_path(item) if kind == 'image' else ''
      if image_path:
        blocks[-1]['assetPath'] = _image_asset_path(image_path, artifact_parent)
  return blocks


def _archive_result(archive: bytes, target: Path) -> tuple[str, list[dict[str, Any]], int]:
  raw_path = target / 'mineru' / 'raw-result.zip'
  raw_path.parent.mkdir(parents=True, exist_ok=True)
  raw_path.write_bytes(archive)
  markdown = ''
  blocks: list[dict[str, Any]] = []
  page_count = 0
  middle_payload: dict[str, Any] | None = None
  content_payload: list[Any] | None = None
  middle_artifact_parent = ''
  content_artifact_parent = ''
  with zipfile.ZipFile(io.BytesIO(archive)) as package:
    for info in package.infolist():
      name = Path(info.filename)
      if name.is_absolute() or '..' in name.parts:
        continue
      output = target / 'mineru' / 'artifacts' / name
      output.parent.mkdir(parents=True, exist_ok=True)
      if not info.is_dir():
        output.write_bytes(package.read(info))
      if name.name.endswith('.md') and (name.name == 'full.md' or not markdown):
        markdown = package.read(info).decode('utf-8', errors='replace')
      if name.name == 'middle.json' or name.name.endswith('_middle.json'):
        try:
          parsed_middle = json.loads(package.read(info))
          if isinstance(parsed_middle, dict):
            middle_payload = parsed_middle
            middle_artifact_parent = name.parent.as_posix()
            page_count = len(parsed_middle.get('pdf_info') or [])
        except Exception:  # noqa: BLE001
          pass
      if name.name == 'content_list.json' or name.name.endswith('_content_list.json'):
        try:
          parsed_content = json.loads(package.read(info))
          if isinstance(parsed_content, list):
            content_payload = parsed_content
            content_artifact_parent = name.parent.as_posix()
        except Exception:  # noqa: BLE001
          pass
  blocks = _middle_layout_blocks(middle_payload, middle_artifact_parent)
  if not blocks and content_payload:
    # Compatibility fallback for unusual MinerU archives without middle.json.
    for index, item in enumerate(content_payload):
      if not isinstance(item, dict):
        continue
      raw_page = item.get('page_idx')
      page_number = int(raw_page) + 1 if isinstance(raw_page, (int, float)) else int(item.get('page_number') or item.get('page_no') or 0)
      bbox = _block_bbox(item)
      if page_number < 1 or bbox is None:
        continue
      kind = _block_kind(item)
      label = str(item.get('label') or item.get('sub_type') or item.get('type') or kind).strip() or kind
      text = _collect_text(item) or {
        'formula': '[公式区域：未识别到可复制公式文本]',
        'image': '[图片区域：请结合页面图片内容引用]',
        'table': '[表格区域：未识别到可复制表格文本]',
      }.get(kind, label)
      block = {'id': f'page-{page_number}-block-{index + 1}', 'pageNumber': page_number, 'kind': kind, 'text': text, 'label': label, 'bbox': bbox, 'source': 'mineru-local'}
      image_path = _block_image_path(item) if kind == 'image' else ''
      if image_path:
        block['assetPath'] = _image_asset_path(image_path, content_artifact_parent)
      blocks.append(block)
  if not markdown:
    raise HTTPException(status_code=502, detail='MinerU result package did not include Markdown.')
  # Downstream APIs use this stable path regardless of MinerU's output filename.
  canonical_markdown_path = target / 'mineru' / 'artifacts' / 'full.md'
  canonical_markdown_path.write_text(markdown, encoding='utf-8')
  return markdown, blocks, page_count


def _pages_from_mineru(document: dict[str, Any], markdown: str, blocks: list[dict[str, Any]], page_count: int) -> list[dict[str, Any]]:
  grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
  for block in blocks:
    grouped[int(block['pageNumber'])].append(block)
  page_total = max([page_count, *grouped.keys(), 1])
  pages: list[dict[str, Any]] = []
  chapter = ''
  section = ''
  for page_number in range(1, page_total + 1):
    page_blocks = grouped.get(page_number, [])
    title = next((str(block.get('text') or '') for block in page_blocks if block.get('kind') == 'title'), '')
    if title:
      chapter = title
      section = title
    content = '\n\n'.join(str(block.get('text') or '').strip() for block in page_blocks if str(block.get('text') or '').strip())
    if not content and page_number == 1:
      content = markdown
    pages.append({'page_id': f"{document['document_id']}:page:{page_number}", 'course_id': document['course_id'], 'document_id': document['document_id'], 'document_type': document['document_type'], 'source_type': document['source_type'], 'page_number': page_number, 'chapter': chapter, 'section': section, 'title': title or section, 'content': content, 'metadata': {'mineru_block_ids': [block['id'] for block in page_blocks]}})
  return pages


def _chunk_page(page: dict[str, Any], blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
  candidates = [block for block in blocks if int(block.get('pageNumber') or 0) == page['page_number'] and str(block.get('text') or '').strip()]
  if not candidates:
    candidates = [{'kind': 'text', 'text': page['content']}]
  chunks: list[dict[str, Any]] = []
  parts: list[str] = []
  title = page['title']
  def flush() -> None:
    if not parts:
      return
    content = '\n\n'.join(parts).strip()
    if content:
      chunks.append({'chunk_id': f"{page['page_id']}:chunk:{len(chunks) + 1}", 'course_id': page['course_id'], 'document_id': page['document_id'], 'page_id': page['page_id'], 'page_number': page['page_number'], 'chapter': page['chapter'], 'section': page['section'], 'title': title, 'document_type': page['document_type'], 'content': content})
    parts.clear()
  for block in candidates:
    text = str(block.get('text') or '').strip()
    if block.get('kind') == 'title' and text:
      flush(); title = text; continue
    if parts and len('\n\n'.join(parts)) + len(text) > MAX_CHUNK_CHARS:
      flush()
    if text:
      parts.append(text)
  flush()
  return chunks


class ApiEmbeddingProvider:
  def embed(self, texts: list[str]) -> list[list[float]]:
    if not texts:
      return []
    config = load_api_config() or {}
    base_url = str(config.get('embeddingBaseUrl') or config.get('baseUrl') or '').rstrip('/')
    api_key = str(config.get('embeddingApiKey') or config.get('apiKey') or '')
    model = str(config.get('embeddingModel') or 'GLM-Embedding-3')
    if not base_url or not api_key:
      raise HTTPException(status_code=422, detail='Embedding API configuration is required.')
    root = re.sub(r'/(chat/completions|embeddings|rerank)$', '', base_url)
    vectors: list[list[float]] = []
    for start in range(0, len(texts), EMBEDDING_BATCH_SIZE):
      batch = texts[start:start + EMBEDDING_BATCH_SIZE]
      response = requests.post(
        f'{root}/embeddings',
        headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
        json={'model': model, 'input': batch},
        timeout=120,
      )
      response.raise_for_status()
      data = response.json().get('data') or []
      batch_vectors = [item.get('embedding') for item in sorted(data, key=lambda item: int(item.get('index') or 0)) if isinstance(item, dict)]
      if len(batch_vectors) != len(batch) or any(not isinstance(vector, list) for vector in batch_vectors):
        raise HTTPException(status_code=502, detail='Embedding API returned incomplete vectors.')
      vectors.extend(batch_vectors)
    return vectors


class QdrantVectorStore:
  """Embedded Qdrant storage partitioned physically by course; no server is required."""

  def __init__(self, path: Path = QDRANT_PATH):
    path.mkdir(parents=True, exist_ok=True)
    self.path = path
    self.courses_path = path / 'courses'
    self.courses_path.mkdir(parents=True, exist_ok=True)
    self._clients: dict[str, QdrantClient] = {}
    self._lock = Lock()

  def _acquire_client(self, course_path: Path) -> QdrantClient:
    shared_key = str(course_path.resolve()).casefold()
    with _QDRANT_CLIENT_LOCK:
      shared = _QDRANT_SHARED_CLIENTS.get(shared_key)
      if shared is None:
        client = QdrantClient(path=str(course_path))
        _QDRANT_SHARED_CLIENTS[shared_key] = (client, 1)
        return client
      client, users = shared
      _QDRANT_SHARED_CLIENTS[shared_key] = (client, users + 1)
      return client

  def _release_client(self, client: QdrantClient, course_path: Path) -> None:
    shared_key = str(course_path.resolve()).casefold()
    with _QDRANT_CLIENT_LOCK:
      shared = _QDRANT_SHARED_CLIENTS.get(shared_key)
      if shared is None or shared[0] is not client:
        return
      _, users = shared
      if users <= 1:
        _QDRANT_SHARED_CLIENTS.pop(shared_key, None)
        client.close()
      else:
        _QDRANT_SHARED_CLIENTS[shared_key] = (client, users - 1)

  @staticmethod
  def _course_key(course_id: str) -> str:
    normalized = str(course_id).strip()
    if not normalized:
      raise ValueError('course_id is required for course-partitioned vector storage.')
    return f'{_safe_name(normalized)}-{hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]}'

  def _client(self, course_id: str) -> QdrantClient:
    key = self._course_key(course_id)
    with self._lock:
      client = self._clients.get(key)
      if client is None:
        course_path = self.courses_path / key
        course_path.mkdir(parents=True, exist_ok=True)
        metadata_path = course_path / 'course.json'
        if not metadata_path.is_file():
          _write_json(metadata_path, {'course_id': str(course_id).strip(), 'course_partition': key})
        client = self._acquire_client(course_path)
        self._clients[key] = client
      return client

  def _existing_course_ids(self) -> list[str]:
    if not self.courses_path.is_dir():
      return []
    return [directory.name for directory in self.courses_path.iterdir() if directory.is_dir()]

  def _existing_clients(self) -> list[QdrantClient]:
    clients: list[QdrantClient] = []
    for key in self._existing_course_ids():
      with self._lock:
        client = self._clients.get(key)
        if client is None:
          course_path = self.courses_path / key
          client = self._acquire_client(course_path)
          self._clients[key] = client
        clients.append(client)
    return clients

  def upsert(self, points: list[dict[str, Any]], collection_name: str = QDRANT_COLLECTION) -> None:
    if not points:
      return
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for point in points:
      payload = point.get('payload') if isinstance(point.get('payload'), dict) else {}
      course_id = str(payload.get('course_id') or '').strip()
      if not course_id:
        raise ValueError('Every vector point must include payload.course_id.')
      grouped[course_id].append(point)
    for course_id, course_points in grouped.items():
      client = self._client(course_id)
      size = len(course_points[0]['vector'])
      if not client.collection_exists(collection_name):
        client.create_collection(
          collection_name=collection_name,
          vectors_config=models.VectorParams(size=size, distance=models.Distance.COSINE),
        )
      client.upsert(
        collection_name=collection_name,
        wait=True,
        points=[
          models.PointStruct(
            id=str(uuid.uuid5(uuid.NAMESPACE_URL, str(point['id']))),
            vector=point['vector'],
            payload=point['payload'],
          )
          for point in course_points
        ],
      )

  def search(self, vector: list[float], limit: int, filters: dict[str, Any], collection_name: str = QDRANT_COLLECTION) -> list[dict[str, Any]]:
    course_id = str(filters.get('course_id') or '').strip()
    clients = [self._client(course_id)] if course_id else self._existing_clients()
    must = [
      models.FieldCondition(key=key, match=models.MatchValue(value=value))
      for key, value in filters.items()
      if value
    ]
    results: list[dict[str, Any]] = []
    for client in clients:
      if not client.collection_exists(collection_name):
        continue
      response = client.query_points(
        collection_name=collection_name,
        query=vector,
        query_filter=models.Filter(must=must) if must else None,
        limit=limit,
        with_payload=True,
      )
      results.extend({'payload': dict(point.payload or {}), 'score': float(point.score)} for point in response.points)
    return sorted(results, key=lambda item: float(item['score']), reverse=True)[:limit]

  def delete_document(self, document_id: str, collection_name: str = QDRANT_COLLECTION) -> None:
    def delete_from_client(client: QdrantClient) -> None:
      if not client.collection_exists(collection_name):
        return
      client.delete(
        collection_name=collection_name,
        points_selector=models.FilterSelector(
          filter=models.Filter(
            must=[
              models.FieldCondition(
                key='document_id',
                match=models.MatchValue(value=document_id),
              )
            ]
          )
        ),
        wait=True,
      )

    for client in self._existing_clients():
      delete_from_client(client)

    # Migration copies legacy points into course partitions but intentionally
    # keeps the old collection. Delete there too so a removed document cannot
    # survive in pre-partition Qdrant storage.
    legacy_collection_path = self.path / 'collection' / collection_name
    if legacy_collection_path.is_dir():
      legacy_client = QdrantClient(path=str(self.path))
      try:
        delete_from_client(legacy_client)
      finally:
        legacy_client.close()

  def delete_course(self, course_id: str) -> None:
    """Remove an entire course partition, including legacy vectors for that course."""
    normalized_course_id = str(course_id or '').strip()
    if not normalized_course_id:
      return

    key = self._course_key(normalized_course_id)
    course_path = self.courses_path / key
    with self._lock:
      client = self._clients.pop(key, None)
    if client is not None:
      self._release_client(client, course_path)

    # A second store instance must not keep the embedded storage open while it
    # is being removed. Failing loudly preserves deletion consistency.
    with _QDRANT_CLIENT_LOCK:
      if str(course_path.resolve()).casefold() in _QDRANT_SHARED_CLIENTS:
        raise RuntimeError(f'Qdrant course partition is still in use: {course_path}')

    if course_path.is_dir():
      shutil.rmtree(course_path)

    # The migration intentionally retains the old root store. Remove points
    # there too so a deleted course cannot be returned by a legacy query.
    legacy_collection_root = self.path / 'collection'
    if not legacy_collection_root.is_dir():
      return
    legacy_client = QdrantClient(path=str(self.path))
    try:
      for collection in legacy_client.get_collections().collections:
        legacy_client.delete(
          collection_name=collection.name,
          points_selector=models.FilterSelector(
            filter=models.Filter(
              must=[
                models.FieldCondition(
                  key='course_id',
                  match=models.MatchValue(value=normalized_course_id),
                )
              ]
            )
          ),
          wait=True,
        )
    finally:
      legacy_client.close()

  def migrate_legacy_collections(self, collection_names: list[str]) -> dict[str, Any]:
    """Copy old root-level vectors into course partitions without re-embedding."""
    marker_path = self.path / 'course-partition-migration-v1.json'
    marker = _read_json(marker_path, {})
    if marker.get('completed'):
      return marker
    legacy_client = QdrantClient(path=str(self.path))
    copied = 0
    try:
      for collection_name in collection_names:
        if not legacy_client.collection_exists(collection_name):
          continue
        offset = None
        while True:
          records, offset = legacy_client.scroll(
            collection_name=collection_name,
            limit=256,
            offset=offset,
            with_payload=True,
            with_vectors=True,
          )
          points = []
          for record in records:
            payload = dict(record.payload or {})
            vector = record.vector
            if not payload.get('course_id') or not isinstance(vector, list):
              continue
            point_id = payload.get('chunk_id') or payload.get('question_id') or str(record.id)
            points.append({'id': point_id, 'vector': vector, 'payload': payload})
          if points:
            self.upsert(points, collection_name=collection_name)
            copied += len(points)
          if offset is None:
            break
      marker = {'completed': True, 'copied_points': copied, 'migrated_at': time.time()}
      _write_json(marker_path, marker)
      return marker
    finally:
      legacy_client.close()

  def storage_summary(self) -> dict[str, Any]:
    courses = []
    for key, client in zip(self._existing_course_ids(), self._existing_clients(), strict=True):
      collections = [collection.name for collection in client.get_collections().collections]
      course_path = self.courses_path / key
      metadata = _read_json(course_path / 'course.json', {})
      courses.append({
        'course_id': metadata.get('course_id') if isinstance(metadata, dict) else None,
        'course_partition': key,
        'path': str(course_path),
        'collections': collections,
      })
    return {'root': str(self.path), 'courses_root': str(self.courses_path), 'courses': courses}

  def close(self) -> None:
    with self._lock:
      clients = list(self._clients.items())
      self._clients.clear()
    for key, client in clients:
      self._release_client(client, self.courses_path / key)


class DocumentPipeline:
  def __init__(self, parser: DocumentParser | None = None, embedding: EmbeddingProvider | None = None, vector_store: VectorStore | None = None):
    self.parser = parser or LocalMinerUParser()
    self.embedding = embedding or ApiEmbeddingProvider()
    self.vector_store = vector_store or QdrantVectorStore()
    self._run_lock = Lock()
    self._cancel_events: dict[str, Event] = {}
    self._active_runs: dict[str, Event] = {}

  def _dir(self, document_id: str) -> Path:
    return DOCUMENTS_ROOT / _safe_name(document_id)

  def _reset_cancellation(self, document_id: str) -> None:
    with self._run_lock:
      self._cancel_events[document_id] = Event()

  def _cancellation_event(self, document_id: str) -> Event:
    with self._run_lock:
      return self._cancel_events.setdefault(document_id, Event())

  def _begin_run(self, document_id: str) -> Event:
    completed = Event()
    with self._run_lock:
      self._active_runs[document_id] = completed
    return completed

  def _finish_run(self, document_id: str, completed: Event) -> None:
    completed.set()
    with self._run_lock:
      if self._active_runs.get(document_id) is completed:
        self._active_runs.pop(document_id, None)

  def cancel_and_wait(self, document_id: str, timeout_seconds: float = 15.0) -> None:
    """Signal an active job to stop and wait before its artifacts are removed."""
    cancel_event = self._cancellation_event(document_id)
    cancel_event.set()
    with self._run_lock:
      completed = self._active_runs.get(document_id)
    if completed is not None and not completed.wait(timeout_seconds):
      raise TimeoutError(f'Document processing did not stop within {timeout_seconds} seconds.')

  @staticmethod
  def _progress_path(directory: Path) -> Path:
    return directory / 'index-progress.json'

  def submit(self, source: bytes, file_name: str, course_id: str, document_type: str = 'lecture', source_type: str = 'pdf', document_id: str | None = None) -> dict[str, Any]:
    state = self.enqueue(source, file_name, course_id, document_type, source_type, document_id)
    return self.run(str(state['document_id']))

  def enqueue(self, source: bytes, file_name: str, course_id: str, document_type: str = 'lecture', source_type: str = 'pdf', document_id: str | None = None) -> dict[str, Any]:
    """Persist a job for background execution without blocking the upload request."""
    document_id = document_id or uuid.uuid4().hex
    self._reset_cancellation(document_id)
    directory = self._dir(document_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'source.pdf').write_bytes(source)
    _write_index_progress(self._progress_path(directory), set())
    state = {'document_id': document_id, 'document_name': file_name, 'course_id': course_id, 'document_type': document_type, 'source_type': source_type, 'status': 'queued', 'mineru_status': 'pending', 'embedding_status': 'pending', 'vector_status': 'pending', 'updated_at': time.time()}
    _write_json(directory / 'state.json', state)
    return state

  def submit_parsed(self, source: bytes, archive: bytes, file_name: str, course_id: str, document_type: str = 'lecture', source_type: str = 'pdf', document_id: str | None = None, mineru_batch_id: str = '') -> dict[str, Any]:
    """Persist an existing MinerU result, then run only the indexing stages."""
    document_id = document_id or uuid.uuid4().hex
    self._reset_cancellation(document_id)
    directory = self._dir(document_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'source.pdf').write_bytes(source)
    markdown, blocks, page_count = _archive_result(archive, directory)
    document = {
      'document_id': document_id,
      'document_name': file_name,
      'course_id': course_id,
      'document_type': document_type,
      'source_type': source_type,
    }
    pages = _pages_from_mineru(document, markdown, blocks, page_count)
    chunks = [chunk for page in pages for chunk in _chunk_page(page, blocks)]
    _write_json(directory / 'document.json', document | {
      'markdown_path': 'mineru/artifacts/full.md',
      'mineru_batch_id': mineru_batch_id,
    })
    _write_json(directory / 'pages.json', pages)
    _write_json(directory / 'chunks.json', chunks)
    _write_json(directory / 'layout-blocks.json', blocks)
    _write_index_progress(self._progress_path(directory), set())
    state = document | {
      'status': 'embedding',
      'mineru_status': 'completed',
      'embedding_status': 'pending',
      'vector_status': 'pending',
      'page_count': len(pages),
      'chunk_count': len(chunks),
      'updated_at': time.time(),
    }
    _write_json(directory / 'state.json', state)
    return self.run(document_id)

  def reindex(self, document_id: str) -> dict[str, Any]:
    """Rebuild pages, chunks, embeddings, and vectors from the saved MinerU archive."""
    directory = self._dir(document_id)
    state = _read_json(directory / 'state.json', {})
    if not state:
      raise HTTPException(status_code=404, detail='Document pipeline job not found.')
    archive_path = directory / 'mineru' / 'raw-result.zip'
    if not archive_path.is_file():
      raise HTTPException(status_code=422, detail='Saved MinerU archive is required for reindexing.')

    markdown, blocks, page_count = _archive_result(archive_path.read_bytes(), directory)
    document = {key: state[key] for key in ('document_id', 'document_name', 'course_id', 'document_type', 'source_type')}
    pages = _pages_from_mineru(document, markdown, blocks, page_count)
    chunks = [chunk for page in pages for chunk in _chunk_page(page, blocks)]
    _write_json(directory / 'pages.json', pages)
    _write_json(directory / 'chunks.json', chunks)
    _write_json(directory / 'layout-blocks.json', blocks)
    delete_vectors = getattr(self.vector_store, 'delete_document', None)
    if callable(delete_vectors):
      delete_vectors(document_id)
    _write_index_progress(self._progress_path(directory), set())
    state.update({
      'status': 'embedding',
      'mineru_status': 'completed',
      'embedding_status': 'pending',
      'vector_status': 'pending',
      'page_count': len(pages),
      'chunk_count': len(chunks),
      'updated_at': time.time(),
      'error': '',
    })
    _write_json(directory / 'state.json', state)
    return self.run(document_id)

  def move_to_course(self, document_id: str, course_id: str) -> dict[str, Any]:
    """Rebuild persisted page and vector metadata after a courseware reassignment."""
    target_course_id = str(course_id or '').strip()
    if not target_course_id:
      raise HTTPException(status_code=422, detail='course_id is required.')
    self.cancel_and_wait(document_id)
    directory = self._dir(document_id)
    state = _read_json(directory / 'state.json', {})
    if not state:
      raise HTTPException(status_code=404, detail='Document pipeline job not found.')
    if str(state.get('course_id') or '') == target_course_id:
      return self.result(document_id)
    if not (directory / 'mineru' / 'raw-result.zip').is_file():
      raise HTTPException(status_code=422, detail='Saved MinerU archive is required to move a document.')

    state['course_id'] = target_course_id
    state['updated_at'] = time.time()
    _write_json(directory / 'state.json', state)
    document_path = directory / 'document.json'
    document = _read_json(document_path, {})
    if document:
      document['course_id'] = target_course_id
      _write_json(document_path, document)
    return self.reindex(document_id)

  def run(self, document_id: str) -> dict[str, Any]:
    cancel_event = self._cancellation_event(document_id)
    if cancel_event.is_set():
      return {'document_id': document_id, 'status': 'cancelled'}
    directory = self._dir(document_id)
    state = _read_json(directory / 'state.json', {})
    if not state:
      raise HTTPException(status_code=404, detail='Document pipeline job not found.')
    completed = self._begin_run(document_id)
    try:
      if cancel_event.is_set():
        raise DocumentProcessingCancelled()
      if state.get('mineru_status') != 'completed':
        # Persist the long-running parser stage before starting MinerU so the
        # library can show useful progress while the local process is working.
        state.update({
          'status': 'mineru',
          'mineru_status': 'running',
          'embedding_status': 'pending',
          'vector_status': 'pending',
          'updated_at': time.time(),
          'error': '',
        })
        _write_json(directory / 'state.json', state)
        parsed = self.parser.parse(directory / 'source.pdf', cancel_event=cancel_event)
        if cancel_event.is_set():
          raise DocumentProcessingCancelled()
        markdown, blocks, page_count = _archive_result(parsed['archive'], directory)
        document = {key: state[key] for key in ('document_id', 'document_name', 'course_id', 'document_type', 'source_type')}
        pages = _pages_from_mineru(document, markdown, blocks, page_count)
        chunks = [chunk for page in pages for chunk in _chunk_page(page, blocks)]
        _write_json(directory / 'document.json', document | {'markdown_path': 'mineru/artifacts/full.md', 'mineru_batch_id': parsed.get('batch_id')})
        _write_json(directory / 'pages.json', pages)
        _write_json(directory / 'chunks.json', chunks)
        _write_json(directory / 'layout-blocks.json', blocks)
        state.update({'mineru_status': 'completed', 'page_count': len(pages), 'chunk_count': len(chunks), 'status': 'embedding'})
        current_stage = 'state'
        if cancel_event.is_set():
          raise DocumentProcessingCancelled()
        _write_json(directory / 'state.json', state)
      chunks = _read_json(directory / 'chunks.json', {}).get('items') if False else json.loads((directory / 'chunks.json').read_text(encoding='utf-8'))
      if not isinstance(chunks, list) or not chunks:
        raise HTTPException(status_code=422, detail='MinerU produced no indexable chunks.')
      indexed_chunk_ids = _read_index_progress(self._progress_path(directory))
      pending_chunks = [chunk for chunk in chunks if str(chunk.get('chunk_id') or '') not in indexed_chunk_ids]
      state.update({
        'status': 'embedding',
        'embedding_status': 'pending',
        'vector_status': 'pending',
        'embedding_completed_chunks': len(chunks) - len(pending_chunks),
        'vector_completed_chunks': len(chunks) - len(pending_chunks),
        'updated_at': time.time(),
      })
      current_stage = 'state'
      if cancel_event.is_set():
        raise DocumentProcessingCancelled()
      _write_json(directory / 'state.json', state)
      for start in range(0, len(pending_chunks), EMBEDDING_BATCH_SIZE):
        if cancel_event.is_set():
          raise DocumentProcessingCancelled()
        batch = pending_chunks[start:start + EMBEDDING_BATCH_SIZE]
        current_stage = 'embedding'
        state.update({
          'status': 'embedding',
          'embedding_status': 'running',
          'updated_at': time.time(),
        })
        _write_json(directory / 'state.json', state)
        vectors = self.embedding.embed([str(chunk['content']) for chunk in batch])
        if cancel_event.is_set():
          raise DocumentProcessingCancelled()
        points = [
          {'id': chunk['chunk_id'], 'vector': vector, 'payload': chunk | {'document_name': state['document_name']}}
          for chunk, vector in zip(batch, vectors, strict=True)
        ]
        current_stage = 'vector'
        state.update({
          'status': 'vector',
          'vector_status': 'running',
          'updated_at': time.time(),
        })
        _write_json(directory / 'state.json', state)
        self.vector_store.upsert(points)
        if cancel_event.is_set():
          raise DocumentProcessingCancelled()
        indexed_chunk_ids.update(str(chunk['chunk_id']) for chunk in batch)
        current_stage = 'state'
        _write_index_progress(self._progress_path(directory), indexed_chunk_ids)
        state.update({
          'status': 'embedding' if start + EMBEDDING_BATCH_SIZE < len(pending_chunks) else 'vector',
          'embedding_completed_chunks': len(indexed_chunk_ids),
          'vector_completed_chunks': len(indexed_chunk_ids),
          'updated_at': time.time(),
          'error': '',
        })
        _write_json(directory / 'state.json', state)
      if cancel_event.is_set():
        raise DocumentProcessingCancelled()
      state.update({
        'embedding_status': 'completed',
        'vector_status': 'completed',
        'status': 'completed',
        'embedding_completed_chunks': len(chunks),
        'vector_completed_chunks': len(chunks),
        'updated_at': time.time(),
        'error': '',
      })
      current_stage = 'state'
    except DocumentProcessingCancelled:
      return state | {'document_id': document_id, 'status': 'cancelled'}
    except Exception as exc:  # noqa: BLE001
      stage = 'mineru' if state.get('mineru_status') != 'completed' else locals().get('current_stage', 'embedding')
      state.update({'status': f'{stage}_failed', 'error': str(getattr(exc, 'detail', exc)), 'updated_at': time.time()})
    finally:
      self._finish_run(document_id, completed)
    if cancel_event.is_set():
      return state | {'document_id': document_id, 'status': 'cancelled'}
    _write_json(directory / 'state.json', state)
    return state

  def prepare_retry(self, document_id: str) -> dict[str, Any]:
    """Expose a non-failed state before the queued retry starts."""
    directory = self._dir(document_id)
    state = _read_json(directory / 'state.json', {})
    if not state:
      raise HTTPException(status_code=404, detail='Document pipeline job not found.')
    if state.get('mineru_status') != 'completed':
      state['status'] = 'queued'
    elif state.get('embedding_status') != 'completed':
      state['status'] = 'embedding'
    else:
      state['status'] = 'vector'
    state.update({'error': '', 'updated_at': time.time()})
    _write_json(directory / 'state.json', state)
    return state

  def result(self, document_id: str) -> dict[str, Any]:
    directory = self._dir(document_id)
    state = _read_json(directory / 'state.json', {})
    if not state:
      raise HTTPException(status_code=404, detail='Document pipeline job not found.')
    markdown_path = directory / 'mineru' / 'artifacts' / 'full.md'
    layout_blocks_path = directory / 'layout-blocks.json'
    layout_blocks = json.loads(layout_blocks_path.read_text(encoding='utf-8')) if layout_blocks_path.is_file() else []
    # Upgrade old content_list coordinates from the saved raw MinerU result.
    # This only refreshes reader geometry; it does not re-run MinerU or embeddings.
    if layout_blocks and not any(block.get('coordinateSpace') == 'pdf-page' for block in layout_blocks if isinstance(block, dict)):
      archive_path = directory / 'mineru' / 'raw-result.zip'
      if archive_path.is_file():
        _, layout_blocks, _ = _archive_result(archive_path.read_bytes(), directory)
        _write_json(layout_blocks_path, layout_blocks)
    return {
      **state,
      'markdown': markdown_path.read_text(encoding='utf-8') if markdown_path.is_file() else '',
      'layout_blocks': layout_blocks,
    }

  def pages(self, document_id: str) -> list[dict[str, Any]]:
    """Return persisted DocumentPage records without reparsing or querying Qdrant."""
    directory = self._dir(document_id)
    state = _read_json(directory / 'state.json', {})
    if not state:
      raise HTTPException(status_code=404, detail='Document pipeline job not found.')
    pages_path = directory / 'pages.json'
    pages = json.loads(pages_path.read_text(encoding='utf-8')) if pages_path.is_file() else []
    if not isinstance(pages, list):
      raise HTTPException(status_code=500, detail='Document pages are invalid.')
    return [page for page in pages if isinstance(page, dict)]

  def delete(self, document_id: str) -> None:
    """Remove all vector and filesystem artifacts for one source document."""
    self.cancel_and_wait(document_id)
    delete_vectors = getattr(self.vector_store, 'delete_document', None)
    if not callable(delete_vectors):
      raise RuntimeError('The configured vector store does not support document deletion.')
    delete_vectors(document_id)

    directory = self._dir(document_id)
    if directory.is_dir():
      shutil.rmtree(directory)
    with self._run_lock:
      self._cancel_events.pop(document_id, None)
      self._active_runs.pop(document_id, None)

  def delete_course(self, course_id: str) -> None:
    """Remove every persisted lecture job for a course, including orphaned jobs."""
    normalized_course_id = str(course_id or '').strip()
    if not normalized_course_id:
      return
    document_ids = []
    if DOCUMENTS_ROOT.is_dir():
      for directory in DOCUMENTS_ROOT.iterdir():
        if not directory.is_dir():
          continue
        state = _read_json(directory / 'state.json', {})
        if str(state.get('course_id') or '') == normalized_course_id:
          document_ids.append(str(state.get('document_id') or directory.name))
    for document_id in document_ids:
      self.delete(document_id)

    delete_course_vectors = getattr(self.vector_store, 'delete_course', None)
    if callable(delete_course_vectors):
      delete_course_vectors(normalized_course_id)

  def retrieve(self, query: str, course_id: str = '', document_type: str = '', top_n: int = 8) -> list[dict[str, Any]]:
    vector = self.embedding.embed([query])[0]
    results = self.vector_store.search(vector, top_n, {'course_id': course_id, 'document_type': document_type})
    return [result.get('payload', {}) | {'score': result.get('score', 0.0)} for result in results]

  def close(self) -> None:
    close = getattr(self.vector_store, 'close', None)
    if callable(close):
      close()

  def resume_pending(self) -> None:
    """Continue jobs interrupted before MinerU or indexing completed."""
    if not DOCUMENTS_ROOT.is_dir():
      return
    for directory in DOCUMENTS_ROOT.iterdir():
      if not directory.is_dir():
        continue
      state = _read_json(directory / 'state.json', {})
      if state.get('status') not in {'queued', 'mineru', 'embedding', 'vector', 'vector_failed', 'state_failed'}:
        continue
      document_id = str(state.get('document_id') or directory.name)
      self.run(document_id)
