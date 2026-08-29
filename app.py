from __future__ import annotations

from contextlib import asynccontextmanager
import json
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import time
import asyncio
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests
from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response

from backend.app_factory import (
  create_app_with_router,
  mount_student_learning_platform_demo_frontend,
)
from backend.config import (
  ASR_DEBUG_DIR,
  ASR_DEBUG_TRANSCRIPT_LIMIT,
  AUDIO_CHUNK_SAMPLE_RATE,
  AUDIO_CHUNK_SECONDS,
  CLOUD_ASR_CHUNK_SECONDS,
  AUDIO_REQUEST_TIMEOUT_SECONDS,
  CLASSROOM_EMBEDDING_BATCH_SIZE,
  CLASSROOM_EMBEDDING_MODEL,
  CLASSROOM_MAPPING_MODEL,
  CLASSROOM_PAGE_CANDIDATE_COUNT,
  CLASSROOM_PAGE_TOP_COUNT,
  CLASSROOM_PAGE_WINDOW_PADDING,
  CLASSROOM_RERANK_MODEL,
  LOCAL_ASR_CACHE_ROOT,
  LOCAL_ASR_DEVICE,
  LOCAL_ASR_MODEL,
  LOCAL_ASR_MODEL_DIR,
  LOCAL_ASR_PUNC_DIR,
  LOCAL_ASR_PYTHON,
  LOCAL_ASR_SCRIPT,
  LOCAL_ASR_VAD_DIR,
  PROJECT_ROOT,
)
from backend.runtime_config import load_api_config, save_api_config
from backend.provider_models import fetch_provider_models
from backend.audio_alignment import (
  AudioAlignmentService,
  LectureRecording,
  TranscriptSegment,
)
from backend.document_pipeline import DocumentPipeline, QDRANT_COLLECTION, local_mineru_service
from backend.question_pipeline import QUESTION_COLLECTION, QUESTION_UPLOAD_EXTENSIONS, QuestionPipeline
from backend.question_relations import QuestionRelationPipeline
from backend.chat_retrieval import ChatContextRetriever
from backend.adaptive_testing import (
  adaptive_testing_router,
  configure_adaptive_testing,
  delete_learning_course,
  delete_learning_document,
  queue_related_assessment_preparations,
  resume_assessment_preparations,
)
# KNOWLEDGE_GRAPH_PAUSED: keep the graph modules on disk for a later opt-in restart.
from backend.knowledge_storage import (
  delete_annotation_asset,
  delete_homework_asset,
  delete_knowledge_course,
  delete_knowledge_homework_document,
  delete_knowledge_lecture,
  delete_pdf_bytes,
  is_knowledge_file_deleted,
  mark_knowledge_file_deleted,
  read_annotation_asset,
  read_homework_asset,
  read_knowledge_library,
  read_pdf_bytes,
  sync_knowledge_homework_pipeline_result,
  update_knowledge_course_settings,
  write_annotation_asset,
  write_homework_binary_asset,
  write_homework_text_asset,
  write_knowledge_library,
  write_pdf_bytes,
)
from backend.tsinghua_sync import tsinghua_router
from backend.tsinghua_courseware_state import mark_deleted_synced_courseware
from backend.study_plan_storage import read_course_study_plan, write_course_study_plan

backend_router = APIRouter()
backend_router.include_router(tsinghua_router)
backend_router.include_router(adaptive_testing_router)
document_pipeline: DocumentPipeline | None = None
question_pipeline: QuestionPipeline | None = None
question_relation_pipeline: QuestionRelationPipeline | None = None
chat_context_retriever: ChatContextRetriever | None = None
pipeline_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='document-pipeline')
relation_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='question-relations')
question_resume_lock = threading.Lock()
question_resume_running = False
question_resume_task: asyncio.Task | None = None


def get_document_pipeline() -> DocumentPipeline:
  """Create the embedded Qdrant client only once during app startup."""
  if document_pipeline is None:
    raise RuntimeError('Document pipeline is not initialized.')
  return document_pipeline


def get_question_pipeline() -> QuestionPipeline:
  if question_pipeline is None:
    raise RuntimeError('Question pipeline is not initialized.')
  return question_pipeline


def get_question_relation_pipeline() -> QuestionRelationPipeline:
  if question_relation_pipeline is None:
    raise RuntimeError('Question relation pipeline is not initialized.')
  return question_relation_pipeline


def get_chat_context_retriever() -> ChatContextRetriever:
  if chat_context_retriever is None:
    raise RuntimeError('Chat context retriever is not initialized.')
  return chat_context_retriever


def run_document_pipeline_with_relations(document_id: str) -> dict[str, Any]:
  """Keep material indexing successful even if an optional relation refresh fails."""
  state = get_document_pipeline().run(document_id)
  if state.get('status') == 'completed' and state.get('document_type') == 'lecture':
    try:
      relation_result = get_question_relation_pipeline().link_course(
        str(state.get('course_id') or '')
      )
      question_ids = {
        str(question_id)
        for document in relation_result.get('documents') or []
        for question_id in document.get('question_ids') or []
        if str(question_id or '').strip()
      }
      queue_related_assessment_preparations(question_ids)
    except Exception as exc:  # noqa: BLE001
      state['relation_refresh_error'] = str(getattr(exc, 'detail', exc))
  return state


def refresh_question_document_relations(document_id: str) -> str:
  """Refresh optional relations without turning successful indexing into a 500."""
  try:
    result = get_question_relation_pipeline().link_document(document_id)
    queue_related_assessment_preparations(set(result.get('question_ids') or []))
  except Exception as exc:  # noqa: BLE001
    return str(getattr(exc, 'detail', exc))
  return ''


def refresh_course_question_relations(course_id: str) -> str:
  try:
    result = get_question_relation_pipeline().link_course(course_id)
    question_ids = {
      str(question_id)
      for document in result.get('documents') or []
      for question_id in document.get('question_ids') or []
      if str(question_id or '').strip()
    }
    queue_related_assessment_preparations(question_ids)
  except Exception as exc:  # noqa: BLE001
    return str(getattr(exc, 'detail', exc))
  return ''


def queue_question_relation_refresh(document_id: str) -> None:
  """Refresh optional relations without blocking indexing status or retry requests."""
  future = relation_executor.submit(refresh_question_document_relations, document_id)

  def report_failure(completed_future) -> None:
    try:
      error = str(completed_future.result() or '')
    except Exception as exc:  # noqa: BLE001
      error = str(exc)
    if error:
      print(f'Question relation refresh failed for {document_id}: {error}')

  future.add_done_callback(report_failure)


def queue_missing_question_relation_refreshes() -> None:
  for document_id in get_question_relation_pipeline().missing_document_ids():
    queue_question_relation_refresh(document_id)


def queue_assessment_preparation_resume() -> None:
  """Resume durable assessment work after relation recovery, without blocking startup."""
  future = relation_executor.submit(resume_assessment_preparations)

  def report_failure(completed_future) -> None:
    try:
      completed_future.result()
    except Exception as exc:  # noqa: BLE001
      print(f'Assessment preparation resume failed: {exc}')

  future.add_done_callback(report_failure)


def _delete_document_relations(document_id: str) -> None:
  """Remove relation records without opening either document vector pipeline."""
  relation_pipeline = get_question_relation_pipeline()
  relation_pipeline.delete_question_document(document_id)
  relation_pipeline.remove_target_document(document_id)


def delete_all_document_artifacts(document_id: str) -> None:
  """Compatibility cleanup for callers that do not know the document type."""
  document_id = str(document_id or '').strip()
  if not document_id:
    return

  cleanup_steps = (
    ('question relation records', lambda: _delete_document_relations(document_id)),
    ('lecture pipeline', lambda: get_document_pipeline().delete(document_id)),
    ('question pipeline', lambda: get_question_pipeline().delete(document_id)),
  )
  errors: list[str] = []
  for label, cleanup in cleanup_steps:
    try:
      cleanup()
    except Exception as exc:  # noqa: BLE001
      errors.append(f'{label}: {getattr(exc, "detail", exc)}')
  if errors:
    raise RuntimeError(
      f'Unable to completely delete document {document_id}: {"; ".join(errors)}'
    )


def delete_document_pipeline_with_relations(document_id: str) -> None:
  document_id = str(document_id or '').strip()
  if not document_id:
    return
  _delete_document_relations(document_id)
  get_document_pipeline().delete(document_id)


def delete_question_pipeline_with_relations(document_id: str) -> None:
  document_id = str(document_id or '').strip()
  if not document_id:
    return
  _delete_document_relations(document_id)
  get_question_pipeline().delete(document_id)


def delete_course_pipeline_artifacts(course_id: str) -> None:
  """Sweep orphaned jobs, then remove the course's physical Qdrant partition."""
  normalized_course_id = str(course_id or '').strip()
  if not normalized_course_id:
    return
  get_question_pipeline().delete_course(normalized_course_id)
  get_document_pipeline().delete_course(normalized_course_id)


async def run_pipeline_task(function, *args, **kwargs):
  loop = asyncio.get_running_loop()
  return await loop.run_in_executor(pipeline_executor, partial(function, *args, **kwargs))


def resume_question_pipeline_once() -> int:
  """Prevent refresh-triggered recovery checks from running concurrently."""
  global question_resume_running
  with question_resume_lock:
    if question_resume_running:
      return 0
    question_resume_running = True
  try:
    return get_question_pipeline().resume_pending()
  finally:
    with question_resume_lock:
      question_resume_running = False


def schedule_question_pipeline_resume() -> asyncio.Task:
  """Queue one non-blocking recovery pass shared by startup and page refreshes."""
  global question_resume_task
  if question_resume_task is None or question_resume_task.done():
    question_resume_task = asyncio.create_task(
      run_pipeline_task(resume_question_pipeline_once),
    )
  return question_resume_task


@asynccontextmanager
async def application_lifespan(_app):
  global document_pipeline, question_pipeline, question_relation_pipeline, chat_context_retriever
  resume_tasks = []
  try:
    document_pipeline = DocumentPipeline()
    question_pipeline = QuestionPipeline(
      parser=document_pipeline.parser,
      embedding=document_pipeline.embedding,
      vector_store=document_pipeline.vector_store,
    )
    question_relation_pipeline = QuestionRelationPipeline(
      embedding=document_pipeline.embedding,
      vector_store=document_pipeline.vector_store,
    )
    configure_adaptive_testing(question_relation_pipeline)
    chat_context_retriever = ChatContextRetriever(
      embedding=document_pipeline.embedding,
      vector_store=document_pipeline.vector_store,
      reranker=question_relation_pipeline.reranker,
    )
    try:
      document_pipeline.vector_store.migrate_legacy_collections([QDRANT_COLLECTION, QUESTION_COLLECTION])
    except Exception as exc:  # noqa: BLE001
      # New uploads remain available even if an old, externally locked store cannot be migrated yet.
      print(f'Legacy Qdrant partition migration deferred: {exc}')
    local_mineru_service.start()
    resume_tasks = [
      asyncio.create_task(run_pipeline_task(document_pipeline.resume_pending)),
      schedule_question_pipeline_resume(),
    ]
    queue_missing_question_relation_refreshes()
    queue_assessment_preparation_resume()
    yield
  finally:
    if resume_tasks:
      await asyncio.gather(*resume_tasks, return_exceptions=True)
    if document_pipeline is not None:
      document_pipeline.close()
      document_pipeline = None
    question_pipeline = None
    question_relation_pipeline = None
    chat_context_retriever = None
    configure_adaptive_testing(None)
    local_mineru_service.stop()


@backend_router.get("/api/config")
async def get_api_config() -> dict[str, Any]:
  config = load_api_config()
  return {"configured": config is not None, "config": config}


@backend_router.put("/api/config")
async def update_api_config(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  # KNOWLEDGE_GRAPH_PAUSED: config persistence remains backward-compatible, but no graph service is started.
  return {"configured": True, "config": save_api_config(payload)}


@backend_router.post('/api/provider-models')
async def list_provider_models(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  return await asyncio.to_thread(
    fetch_provider_models,
    base_url=str(payload.get('base_url') or '').strip(),
    api_key=str(payload.get('api_key') or '').strip(),
  )


@backend_router.post('/api/documents/process')
async def process_document_pipeline(
  file: UploadFile = File(...),
  course_id: str = Form(...),
  document_type: str = Form('lecture'),
  source_type: str = Form('pdf'),
  document_id: str | None = Form(None),
) -> dict[str, Any]:
  if (
    not (file.filename or '').lower().endswith('.pdf')
    and str(file.content_type or '').lower() != 'application/pdf'
  ):
    raise HTTPException(status_code=422, detail='Document pipeline only accepts PDF files.')
  if document_type != 'lecture':
    raise HTTPException(status_code=422, detail='Document pipeline only accepts lecture documents.')
  if document_id and is_knowledge_file_deleted(document_id):
    raise HTTPException(status_code=410, detail='该文档已被删除，已取消处理。')
  # Persisting an upload does not touch Qdrant or MinerU. Keep it outside the
  # single-worker pipeline queue so another document can be previewed at once.
  state = await asyncio.to_thread(
    get_document_pipeline().enqueue,
    source=await file.read(),
    file_name=file.filename or 'document.pdf',
    course_id=course_id,
    document_type=document_type,
    source_type=source_type,
    document_id=document_id,
  )
  asyncio.create_task(run_pipeline_task(run_document_pipeline_with_relations, str(state['document_id'])))
  return get_document_pipeline().result(str(state['document_id']))


@backend_router.get('/api/documents/{document_id}/status')
async def get_document_pipeline_status(document_id: str) -> dict[str, Any]:
  return get_document_pipeline().result(document_id)


@backend_router.post('/api/documents/{document_id}/retry')
async def retry_document_pipeline(document_id: str) -> dict[str, Any]:
  await asyncio.to_thread(get_document_pipeline().prepare_retry, document_id)
  asyncio.create_task(run_pipeline_task(run_document_pipeline_with_relations, document_id))
  return get_document_pipeline().result(document_id)


@backend_router.post('/api/documents/{document_id}/reindex')
async def reindex_document_pipeline(document_id: str) -> dict[str, Any]:
  await run_pipeline_task(get_document_pipeline().reindex, document_id)
  state = get_document_pipeline().result(document_id)
  if state.get('status') == 'completed' and state.get('document_type') == 'lecture':
    await run_pipeline_task(get_question_relation_pipeline().link_course, str(state.get('course_id') or ''))
  return state


@backend_router.post('/api/documents/{document_id}/move-course')
async def move_document_pipeline_to_course(
  document_id: str,
  payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
  """Keep local pages and Qdrant payloads in sync when imported courseware is reclassified."""
  course_id = str(payload.get('course_id') or '').strip()
  state = await run_pipeline_task(get_document_pipeline().move_to_course, document_id, course_id)
  if state.get('status') == 'completed' and state.get('document_type') == 'lecture':
    await run_pipeline_task(get_question_relation_pipeline().link_course, course_id)
  return get_document_pipeline().result(document_id)


@backend_router.post('/api/documents/retrieve')
async def retrieve_document_chunks(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  query = str(payload.get('query') or '').strip()
  if not query:
    raise HTTPException(status_code=422, detail='query is required.')
  top_n = max(1, min(int(payload.get('top_n') or 8), 50))
  return {
    'results': get_document_pipeline().retrieve(
      query=query,
      course_id=str(payload.get('course_id') or '').strip(),
      document_type=str(payload.get('document_type') or '').strip(),
      top_n=top_n,
    )
  }


@backend_router.post('/api/chat/retrieve-context')
async def retrieve_chat_context(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  """Return only the reranked fragments needed for one chat turn."""
  return await asyncio.to_thread(
    get_chat_context_retriever().retrieve,
    query=str(payload.get('query') or '').strip(),
    course_id=str(payload.get('course_id') or '').strip(),
    document_id=str(payload.get('document_id') or '').strip(),
    document_type=str(payload.get('document_type') or '').strip(),
    top_n=max(1, min(int(payload.get('top_n') or 20), 50)),
    top_k=max(1, min(int(payload.get('top_k') or 6), 12)),
    recent_messages=(
      payload.get('recent_messages')
      if isinstance(payload.get('recent_messages'), list)
      else []
    ),
  )


@backend_router.get('/api/vector-store/storage')
async def get_vector_store_storage() -> dict[str, Any]:
  return get_document_pipeline().vector_store.storage_summary()


@backend_router.post('/api/questions/process')
async def process_question_document(
  file: UploadFile = File(...),
  course_id: str = Form(...),
  document_type: str = Form(...),
  document_id: str | None = Form(None),
) -> dict[str, Any]:
  file_name = str(file.filename or '').strip()
  suffix = Path(file_name).suffix.lower()
  if suffix not in QUESTION_UPLOAD_EXTENSIONS:
    raise HTTPException(
      status_code=422,
      detail='题目文件格式不支持。当前支持 PDF、PNG、JPG、JPEG 和 WebP。',
    )
  if document_type not in {'homework', 'past-exam'}:
    raise HTTPException(status_code=422, detail='Question pipeline only accepts homework or past-exam documents.')
  state = await run_pipeline_task(
    get_question_pipeline().submit,
    source=await file.read(),
    file_name=file.filename or 'questions.pdf',
    course_id=course_id,
    document_type=document_type,
    document_id=document_id,
  )
  result = get_question_pipeline().result(str(state['document_id']))
  await run_pipeline_task(
    sync_knowledge_homework_pipeline_result,
    str(state['document_id']),
    result,
  )
  if state.get('status') == 'completed':
    queue_question_relation_refresh(str(state['document_id']))
  return result


@backend_router.post('/api/questions/resume-pending')
async def resume_pending_question_documents() -> dict[str, Any]:
  """Recheck interrupted question jobs when the web app is opened or refreshed."""
  pipeline = get_question_pipeline()
  pending_count = len(await asyncio.to_thread(pipeline.pending_document_ids))
  if pending_count:
    schedule_question_pipeline_resume()
  return {
    'checked': True,
    'pending_count': pending_count,
    'message': '未处理题目已加入恢复检查。' if pending_count else '没有需要恢复的题目。',
  }


@backend_router.post('/api/questions/{document_id}/retry')
async def retry_question_document(document_id: str) -> dict[str, Any]:
  state = await run_pipeline_task(get_question_pipeline().run, document_id)
  result = get_question_pipeline().result(document_id)
  await run_pipeline_task(sync_knowledge_homework_pipeline_result, document_id, result)
  if state.get('status') == 'completed':
    queue_question_relation_refresh(document_id)
  return result


@backend_router.post('/api/questions/{document_id}/reextract')
async def reextract_question_document(document_id: str) -> dict[str, Any]:
  """Rerun AI question grouping without paying the MinerU parsing cost again."""
  await run_pipeline_task(get_question_relation_pipeline().delete_question_document, document_id)
  await run_pipeline_task(get_question_relation_pipeline().remove_target_document, document_id)
  await run_pipeline_task(get_question_pipeline().prepare_reextract, document_id)
  state = await run_pipeline_task(get_question_pipeline().run, document_id)
  relation_refresh_error = ''
  if state.get('status') == 'completed':
    relation_refresh_error = await run_pipeline_task(
      refresh_course_question_relations,
      str(state.get('course_id') or ''),
    )
  result = get_question_pipeline().result(document_id)
  if relation_refresh_error:
    result['relation_refresh_error'] = relation_refresh_error
  await run_pipeline_task(sync_knowledge_homework_pipeline_result, document_id, result)
  return result


@backend_router.get('/api/question-relations/config')
async def get_question_relation_config() -> dict[str, Any]:
  return get_question_relation_pipeline().config()


@backend_router.put('/api/question-relations/config')
async def update_question_relation_config(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  return get_question_relation_pipeline().update_config(payload)


@backend_router.post('/api/question-relations/documents/{document_id}/run')
async def run_question_document_relations(document_id: str) -> dict[str, Any]:
  result = await run_pipeline_task(get_question_relation_pipeline().link_document, document_id)
  queue_related_assessment_preparations(set(result.get('question_ids') or []))
  return result


@backend_router.post('/api/question-relations/documents/{document_id}/questions/{question_id}/run')
async def run_single_question_relations(document_id: str, question_id: str) -> dict[str, Any]:
  result = await run_pipeline_task(
    get_question_relation_pipeline().link_document_question,
    document_id,
    question_id,
  )
  queue_related_assessment_preparations({question_id})
  return result


@backend_router.post('/api/question-relations/courses/{course_id}/run')
async def run_course_question_relations(course_id: str) -> dict[str, Any]:
  result = await run_pipeline_task(get_question_relation_pipeline().link_course, course_id)
  question_ids = {
    str(question_id)
    for document in result.get('documents') or []
    for question_id in document.get('question_ids') or []
    if str(question_id or '').strip()
  }
  queue_related_assessment_preparations(question_ids)
  return result


@backend_router.get('/api/question-relations/questions/{question_id}')
async def get_question_relations(question_id: str) -> dict[str, Any]:
  return get_question_relation_pipeline().result(question_id)


@backend_router.post('/api/question-relations/rebuild-page-indexes')
async def rebuild_question_relation_page_indexes() -> dict[str, Any]:
  return await run_pipeline_task(get_question_relation_pipeline().rebuild_lecture_page_indexes)


@backend_router.get('/api/question-relations/courses/{course_id}/lectures/{document_id}/pages/{page_number}')
async def get_lecture_page_question_relations(
  course_id: str,
  document_id: str,
  page_number: int,
) -> dict[str, Any]:
  return get_question_relation_pipeline().lecture_page_relations(course_id, document_id, page_number)


@backend_router.delete('/api/questions/{document_id}')
async def delete_question_document(document_id: str) -> dict[str, Any]:
  await run_pipeline_task(delete_question_pipeline_with_relations, document_id)
  return {'deleted': True, 'document_id': document_id}


@backend_router.delete('/api/knowledge/courses/{course_id}/homework-documents/{document_id}')
async def delete_knowledge_homework_document_api(
  course_id: str,
  document_id: str,
) -> dict[str, Any]:
  result = await run_pipeline_task(
    delete_knowledge_homework_document,
    course_id,
    document_id,
    delete_question_pipeline_with_relations,
  )
  if result.get('deleted'):
    await asyncio.to_thread(delete_learning_document, course_id, document_id)
  return result


@backend_router.get('/api/questions/{document_id}/status')
async def get_question_document_status(document_id: str) -> dict[str, Any]:
  state = await asyncio.to_thread(get_question_pipeline().status, document_id)
  status = str(state.get('status') or '')
  if status == 'completed' or status.endswith('_failed'):
    result = await asyncio.to_thread(get_question_pipeline().result, document_id)
    await asyncio.to_thread(sync_knowledge_homework_pipeline_result, document_id, result)
    return result
  return state


@backend_router.get("/api/knowledge/library")
async def get_knowledge_library() -> dict[str, Any]:
  return read_knowledge_library()


@backend_router.put("/api/knowledge/library")
async def update_knowledge_library(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  return write_knowledge_library(payload)


@backend_router.delete('/api/knowledge/files/{file_id}')
async def delete_knowledge_file(file_id: str) -> dict[str, Any]:
  # Deletion must not wait behind the single document processing queue. Signal
  # the active MinerU/embedding job first, then remove all course-library data.
  library = read_knowledge_library()
  deleted_file = next(
    (
      item
      for item in library.get('files') or []
      if isinstance(item, dict) and str(item.get('id') or '') == file_id
    ),
    None,
  )
  # Mark before waiting for a running MinerU job. A delayed browser status poll
  # can otherwise PUT its stale full-library snapshot and resurrect this card.
  await asyncio.to_thread(mark_knowledge_file_deleted, file_id, deleted_file)
  await asyncio.to_thread(get_document_pipeline().cancel_and_wait, file_id)
  result = await asyncio.to_thread(
    delete_knowledge_lecture,
    file_id,
    delete_document_pipeline_with_relations,
    delete_question_pipeline_with_relations,
  )
  if result.get('deleted'):
    await asyncio.to_thread(
      delete_learning_document,
      str((deleted_file or {}).get('courseId') or ''),
      file_id,
    )
    await asyncio.to_thread(mark_deleted_synced_courseware, deleted_file)
  return result


@backend_router.delete('/api/knowledge/courses/{course_id}')
async def delete_knowledge_course_api(course_id: str) -> dict[str, Any]:
  # A deletion must be able to cancel a long-running MinerU job instead of
  # waiting behind the single document-processing executor.
  library = read_knowledge_library()
  course_files = [
    item
    for item in library.get('files') or []
    if isinstance(item, dict) and str(item.get('courseId') or '') == course_id
  ]
  # Apply the tombstones before any potentially long-running cancellation and
  # cascade cleanup, so an old full-library browser save cannot restore files.
  for file_record in course_files:
    await asyncio.to_thread(
      mark_knowledge_file_deleted,
      str(file_record.get('id') or ''),
      file_record,
    )
  result = await asyncio.to_thread(
    delete_knowledge_course,
    course_id,
    delete_document_pipeline_with_relations,
    delete_question_pipeline_with_relations,
    delete_course_pipeline_artifacts,
  )
  if result.get('deleted'):
    await asyncio.to_thread(delete_learning_course, course_id)
    for file_record in course_files:
      await asyncio.to_thread(mark_deleted_synced_courseware, file_record)
  return result


@backend_router.patch('/api/knowledge/courses/{course_id}')
async def update_knowledge_course_api(
  course_id: str,
  payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
  return await asyncio.to_thread(update_knowledge_course_settings, course_id, payload)


@backend_router.get('/api/study-plans/courses/{course_id}')
async def get_course_study_plan_api(course_id: str) -> dict[str, Any]:
  return await asyncio.to_thread(read_course_study_plan, course_id)


@backend_router.put('/api/study-plans/courses/{course_id}')
async def update_course_study_plan_api(
  course_id: str,
  payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
  return await asyncio.to_thread(write_course_study_plan, course_id, payload)


@backend_router.get("/api/knowledge/pdf/{file_id}")
async def get_knowledge_pdf(file_id: str) -> Response:
  return Response(
    content=read_pdf_bytes(file_id),
    media_type="application/pdf",
  )


@backend_router.put("/api/knowledge/pdf/{file_id}")
async def update_knowledge_pdf(file_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
  file.file.seek(0)
  write_pdf_bytes(file_id, file.file.read())
  return {"ok": True, "fileId": file_id}


@backend_router.delete("/api/knowledge/pdf/{file_id}")
async def remove_knowledge_pdf(file_id: str) -> dict[str, Any]:
  delete_pdf_bytes(file_id)
  return {"ok": True, "fileId": file_id}


@backend_router.get("/api/knowledge/annotation-asset/{asset_id}")
async def get_knowledge_annotation_asset(asset_id: str) -> dict[str, Any]:
  return {
    "assetId": asset_id,
    "dataUrl": read_annotation_asset(asset_id),
  }


@backend_router.put("/api/knowledge/annotation-asset/{asset_id}")
async def update_knowledge_annotation_asset(
  asset_id: str,
  payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
  data_url = str(payload.get("dataUrl") or "")
  write_annotation_asset(asset_id, data_url)
  return {"ok": True, "assetId": asset_id}


@backend_router.delete("/api/knowledge/annotation-asset/{asset_id}")
async def remove_knowledge_annotation_asset(asset_id: str) -> dict[str, Any]:
  delete_annotation_asset(asset_id)
  return {"ok": True, "assetId": asset_id}


@backend_router.get("/api/knowledge/homework-asset/{asset_id}", response_model=None)
async def get_knowledge_homework_asset(asset_id: str) -> Response | dict[str, Any]:
  payload = read_homework_asset(asset_id)
  if payload["kind"] == "text":
    return {
      "assetId": asset_id,
      "kind": "text",
      "text": payload["text"],
    }

  return Response(
    content=payload["bytes"],
    media_type=str(payload["contentType"] or "application/octet-stream"),
    headers={"X-Student-Asset-Kind": "binary"},
  )


@backend_router.put("/api/knowledge/homework-asset/{asset_id}")
async def update_knowledge_homework_asset(asset_id: str, request: Request) -> dict[str, Any]:
  content_type = (request.headers.get("content-type") or "").lower()
  if content_type.startswith("application/json"):
    payload = await request.json()
    if not isinstance(payload, dict):
      raise HTTPException(status_code=422, detail="Invalid homework asset payload.")
    write_homework_text_asset(asset_id, str(payload.get("text") or ""))
    return {"ok": True, "assetId": asset_id, "kind": "text"}

  payload = await request.body()
  write_homework_binary_asset(
    asset_id,
    payload,
    request.headers.get("x-student-content-type") or request.headers.get("content-type") or "application/octet-stream",
  )
  return {"ok": True, "assetId": asset_id, "kind": "binary"}


@backend_router.delete("/api/knowledge/homework-asset/{asset_id}")
async def remove_knowledge_homework_asset(asset_id: str) -> dict[str, Any]:
  delete_homework_asset(asset_id)
  return {"ok": True, "assetId": asset_id}


def _parse_response_json(response: requests.Response) -> dict[str, Any]:
  try:
    payload = response.json()
  except Exception as exc:  # noqa: BLE001
    raise HTTPException(
      status_code=502,
      detail=f"MinerU returned a non-JSON response: {exc}",
    ) from exc

  if not isinstance(payload, dict):
    raise HTTPException(status_code=502, detail="MinerU returned an invalid payload.")

  return payload


def _normalize_chat_base_url(base_url: str) -> str:
  trimmed = base_url.strip().rstrip("/")
  if trimmed.endswith("/chat/completions"):
    return trimmed
  if trimmed.endswith("/v1"):
    return f"{trimmed}/chat/completions"
  return f"{trimmed}/chat/completions"


def _normalize_api_root(base_url: str) -> str:
  trimmed = base_url.strip().rstrip("/")
  for suffix in ("/chat/completions", "/embeddings", "/rerank"):
    if trimmed.endswith(suffix):
      return trimmed[: -len(suffix)]
  return trimmed


def _normalize_embeddings_base_url(base_url: str) -> str:
  return f"{_normalize_api_root(base_url)}/embeddings"


def _normalize_rerank_base_url(base_url: str) -> str:
  return f"{_normalize_api_root(base_url)}/rerank"


def _normalize_asr_base_url(base_url: str) -> str:
  trimmed = base_url.strip().rstrip("/")
  if trimmed.endswith("/audio/transcriptions"):
    return trimmed
  return f"{trimmed}/audio/transcriptions"


def _is_local_asr_config(config: dict[str, Any]) -> bool:
  base_url = str(config.get("asrBaseUrl") or "").strip().lower()
  return not base_url or base_url.startswith("local://")


def _resolve_runtime_provider_config(
  provider: str,
  fallback_base_url: str,
  fallback_api_key: str,
  fallback_model: str,
) -> tuple[str, str, str]:
  config = load_api_config() or {}
  provider_prefix = 'embedding' if provider == 'embedding' else 'rerank'
  base_url = str(config.get(f'{provider_prefix}BaseUrl') or fallback_base_url).strip()
  api_key = str(config.get(f'{provider_prefix}ApiKey') or fallback_api_key).strip()
  model = str(config.get(f'{provider_prefix}Model') or fallback_model).strip()
  return base_url, api_key, model


def _sanitize_debug_name(raw_name: str) -> str:
  value = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", raw_name.strip(), flags=re.UNICODE).strip("-.")
  return value or f"audio-debug-{int(time.time())}"


def _guess_upload_suffix(upload_file: UploadFile) -> str:
  original_suffix = Path(upload_file.filename or "").suffix.strip()
  if original_suffix:
    return original_suffix

  guessed = mimetypes.guess_extension(upload_file.content_type or "")
  return guessed or ".bin"


def _write_upload_file_to_temp(upload_file: UploadFile) -> tuple[Path, Path]:
  temp_dir = Path(tempfile.mkdtemp(prefix="student-platform-audio-src-"))
  file_path = temp_dir / f"source{_guess_upload_suffix(upload_file)}"
  upload_file.file.seek(0)
  with file_path.open("wb") as target:
    shutil.copyfileobj(upload_file.file, target)
  return temp_dir, file_path


def _probe_audio_duration_seconds(file_path: Path) -> float | None:
  try:
    result = subprocess.run(
      [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(file_path),
      ],
      check=True,
      capture_output=True,
      text=True,
    )
  except (FileNotFoundError, subprocess.SubprocessError):
    return None

  raw_value = result.stdout.strip()
  if not raw_value:
    return None

  try:
    duration = float(raw_value)
  except ValueError:
    return None

  return duration if duration > 0 else None


def _segment_audio_for_asr(
  file_path: Path,
  *,
  chunk_seconds: float = AUDIO_CHUNK_SECONDS,
) -> tuple[Path, list[Path], float | None]:
  if chunk_seconds <= 0:
    raise ValueError('ASR chunk duration must be positive.')
  duration_seconds = _probe_audio_duration_seconds(file_path)
  temp_dir = Path(tempfile.mkdtemp(prefix="student-platform-audio-chunks-"))
  chunk_pattern = temp_dir / "chunk-%04d.wav"

  try:
    result = subprocess.run(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        str(file_path),
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        str(AUDIO_CHUNK_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "segment",
        "-segment_time",
        str(chunk_seconds),
        "-reset_timestamps",
        "1",
        str(chunk_pattern),
      ],
      check=True,
      capture_output=True,
      text=True,
    )
  except FileNotFoundError as exc:
    shutil.rmtree(temp_dir, ignore_errors=True)
    raise HTTPException(
      status_code=500,
      detail="FFmpeg is required for long-audio ASR chunking but was not found on the server.",
    ) from exc
  except subprocess.CalledProcessError as exc:
    shutil.rmtree(temp_dir, ignore_errors=True)
    detail = (exc.stderr or exc.stdout or "Unknown ffmpeg error").strip()
    raise HTTPException(status_code=502, detail=f"FFmpeg audio segmentation failed: {detail}") from exc

  chunk_paths = sorted(temp_dir.glob("chunk-*.wav"))
  if not chunk_paths:
    shutil.rmtree(temp_dir, ignore_errors=True)
    detail = (result.stderr or result.stdout or "No audio chunks were produced.").strip()
    raise HTTPException(status_code=502, detail=f"FFmpeg audio segmentation failed: {detail}")

  return temp_dir, chunk_paths, duration_seconds


def _extract_asr_text(payload: Any) -> str:
  if isinstance(payload, dict):
    direct = payload.get("text")
    if isinstance(direct, str) and direct.strip():
      return direct.strip()

    alternatives = [
      payload.get("transcript"),
      payload.get("result"),
      payload.get("content"),
    ]
    for candidate in alternatives:
      if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()

    nested = payload.get("data")
    if nested is not None:
      return _extract_asr_text(nested)

    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
      return output_text.strip()

    output_path = payload.get("output_path")
    if isinstance(output_path, str) and output_path.strip():
      try:
        output_file = Path(output_path).expanduser()
        if output_file.is_file():
          return output_file.read_text(encoding="utf-8").strip()
      except Exception:
        pass

    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
      first = choices[0]
      if isinstance(first, dict):
        message = first.get("message")
        if isinstance(message, dict):
          content = message.get("content")
          if isinstance(content, str) and content.strip():
            return content.strip()

  if isinstance(payload, list):
    for item in payload:
      extracted = _extract_asr_text(item)
      if extracted:
        return extracted

  return ""


def _format_timestamp(seconds: float | None) -> str:
  total_seconds = max(0, int(round(seconds or 0)))
  hours, remainder = divmod(total_seconds, 3600)
  minutes, seconds_part = divmod(remainder, 60)
  return f"{hours:02d}:{minutes:02d}:{seconds_part:02d}"


def _build_asr_markdown(
  *,
  source_name: str,
  duration_seconds: float | None,
  model: str,
  chunks: list[dict[str, Any]],
) -> str:
  lines = [
    "# ASR 转写",
    "",
    f"- 源文件：{source_name}",
    f"- 总时长：{_format_timestamp(duration_seconds)}",
    f"- 模型：{model}",
    f"- 分段数：{len(chunks)}",
    "",
  ]
  for chunk in chunks:
    text = str(chunk.get("text") or "").strip()
    start = _format_timestamp(float(chunk.get("start_seconds") or 0))
    end = _format_timestamp(float(chunk.get("end_seconds") or 0))
    lines.extend([f"## {start} - {end}", "", text or "> 此音频段未识别出文本。", ""])
  return "\n".join(lines).strip() + "\n"


def _write_asr_debug_outputs(
  *,
  transcript: str,
  chunks: list[dict[str, Any]],
  source_name: str,
  duration_seconds: float | None,
  model: str,
) -> str:
  ASR_DEBUG_DIR.mkdir(parents=True, exist_ok=True)
  (ASR_DEBUG_DIR / "asr_transcript.md").write_text(f"{transcript.strip()}\n", encoding="utf-8")
  (ASR_DEBUG_DIR / "asr_chunks.json").write_text(
    json.dumps({"chunks": chunks}, ensure_ascii=False, indent=2),
    encoding="utf-8",
  )
  transcript_dir = ASR_DEBUG_DIR / "transcripts"
  transcript_dir.mkdir(parents=True, exist_ok=True)
  transcript_path = transcript_dir / (
    f"{_sanitize_debug_name(Path(source_name).stem)}-{int(time.time())}.md"
  )
  transcript_path.write_text(
    _build_asr_markdown(
      source_name=source_name,
      duration_seconds=duration_seconds,
      model=model,
      chunks=chunks,
    ),
    encoding="utf-8",
  )
  stale_transcripts = sorted(
    transcript_dir.glob('*.md'),
    key=lambda path: path.stat().st_mtime,
    reverse=True,
  )[ASR_DEBUG_TRANSCRIPT_LIMIT:]
  for stale_path in stale_transcripts:
    stale_path.unlink(missing_ok=True)
  return str(transcript_path.relative_to(PROJECT_ROOT))


def _seconds_from_asr_value(value: Any, *, chunk_duration: float) -> float | None:
  try:
    seconds = float(value)
  except (TypeError, ValueError):
    return None
  if seconds < 0:
    return None
  # FunASR uses milliseconds while OpenAI-compatible ASR APIs use seconds.
  if seconds > chunk_duration + 5:
    seconds /= 1000
  return seconds


def _extract_cloud_asr_segments(
  payload: Any,
  *,
  chunk_start: float,
  chunk_end: float,
) -> list[dict[str, Any]]:
  if not isinstance(payload, dict):
    return []

  raw_segments = payload.get("segments")
  if not isinstance(raw_segments, list):
    nested = payload.get("data")
    raw_segments = nested.get("segments") if isinstance(nested, dict) else None
  if not isinstance(raw_segments, list):
    return []

  chunk_duration = max(0.0, chunk_end - chunk_start)
  normalized: list[dict[str, Any]] = []
  for segment in raw_segments:
    if not isinstance(segment, dict):
      continue
    text = _extract_asr_text(segment)
    if not text:
      continue
    local_start = _seconds_from_asr_value(segment.get("start"), chunk_duration=chunk_duration)
    local_end = _seconds_from_asr_value(segment.get("end"), chunk_duration=chunk_duration)
    if local_start is None or local_end is None:
      continue
    normalized.append(
      {
        "text": text,
        "start_seconds": round(max(chunk_start, chunk_start + local_start), 3),
        "end_seconds": round(min(chunk_end, chunk_start + max(local_start, local_end)), 3),
      }
    )
  return normalized


def _transcribe_audio_chunks_with_cloud_asr(
  *,
  chunk_paths: list[Path],
  duration_seconds: float | None,
  source_name: str,
  config: dict[str, Any],
  chunk_seconds: float = AUDIO_CHUNK_SECONDS,
) -> dict[str, Any]:
  base_url = str(config.get("asrBaseUrl") or "").strip()
  api_key = str(config.get("asrApiKey") or "").strip()
  model = str(config.get("asrModel") or "").strip()
  prompt = str(config.get("asrPrompt") or "").strip()
  if not base_url or not api_key or not model:
    raise HTTPException(status_code=422, detail="Cloud ASR requires Base URL, API key, and model.")

  endpoint = _normalize_asr_base_url(base_url)
  headers = {"Authorization": f"Bearer {api_key}"}
  chunks: list[dict[str, Any]] = []
  transcript_parts: list[str] = []

  # Send one short WAV at a time. This avoids provider size/time limits and preserves offsets.
  for index, chunk_path in enumerate(chunk_paths, start=1):
    chunk_start = round((index - 1) * chunk_seconds, 3)
    chunk_end = round(min(index * chunk_seconds, duration_seconds or index * chunk_seconds), 3)
    request_data: list[tuple[str, str]] = [
      ("model", model),
      ("response_format", "verbose_json"),
      ("timestamp_granularities[]", "segment"),
    ]
    if prompt:
      request_data.append(("prompt", prompt))

    try:
      with chunk_path.open("rb") as audio_file:
        response = requests.post(
          endpoint,
          headers=headers,
          data=request_data,
          files={"file": (chunk_path.name, audio_file, "audio/wav")},
          timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
      raise HTTPException(
        status_code=502,
        detail=f"Cloud ASR request failed for chunk {index}/{len(chunk_paths)}: {exc}",
      ) from exc

    if not response.ok:
      detail = response.text.strip()[:1000] or f"HTTP {response.status_code}"
      raise HTTPException(
        status_code=502,
        detail=f"Cloud ASR failed for chunk {index}/{len(chunk_paths)}: {detail}",
      )
    try:
      payload = response.json()
    except ValueError as exc:
      raise HTTPException(
        status_code=502,
        detail=f"Cloud ASR returned non-JSON output for chunk {index}/{len(chunk_paths)}.",
      ) from exc

    text = _extract_asr_text(payload)
    segments = _extract_cloud_asr_segments(payload, chunk_start=chunk_start, chunk_end=chunk_end)
    chunk_entry: dict[str, Any] = {
      "index": index,
      "file_name": chunk_path.name,
      "start_seconds": chunk_start,
      "end_seconds": chunk_end,
      "text": text,
      "empty": not bool(text),
    }
    if segments:
      chunk_entry["segments"] = segments
    chunks.append(chunk_entry)
    if text:
      transcript_parts.append(text)

  transcript = "\n".join(transcript_parts).strip()
  if not transcript:
    raise HTTPException(status_code=502, detail="Cloud ASR did not return any usable transcript text.")

  markdown_path = _write_asr_debug_outputs(
    transcript=transcript,
    chunks=chunks,
    source_name=source_name,
    duration_seconds=duration_seconds,
    model=model,
  )
  return {
    "text": transcript,
    "chunks": chunks,
    "chunk_count": len(chunks),
    "duration_seconds": duration_seconds,
    "engine": "cloud-asr",
    "model": model,
    "markdown_path": markdown_path,
  }


def _load_latest_debug_mapping_payload() -> dict[str, Any]:
  transcript_path = ASR_DEBUG_DIR / "asr_transcript.md"
  mapping_path = ASR_DEBUG_DIR / "asr_mapping_raw.json"
  lecture_path = PROJECT_ROOT / "tmp_lecture_markdown.md"

  if not transcript_path.is_file() or not mapping_path.is_file() or not lecture_path.is_file():
    raise HTTPException(status_code=404, detail="No debug classroom mapping files were found.")

  try:
    transcript = transcript_path.read_text(encoding="utf-8").strip()
    lecture_markdown = lecture_path.read_text(encoding="utf-8").strip()
    session_payload = json.loads(mapping_path.read_text(encoding="utf-8"))
  except Exception as exc:  # noqa: BLE001
    raise HTTPException(status_code=500, detail=f"Failed to read debug classroom mapping files: {exc}") from exc

  if not isinstance(session_payload, dict):
    raise HTTPException(status_code=500, detail="Debug classroom mapping payload is invalid.")

  normalized_segments = _normalize_classroom_segments_payload(session_payload, lecture_markdown)
  mapping_updated_at = time.strftime(
    "%Y-%m-%dT%H:%M:%S",
    time.localtime(mapping_path.stat().st_mtime),
  )

  return {
    "transcript": transcript,
    "lectureMarkdown": lecture_markdown,
    "session": {
      "id": f"debug-session-{int(mapping_path.stat().st_mtime)}",
      "transcript": transcript,
      "polishedOverview": "",
      "segments": normalized_segments,
      "createdAt": mapping_updated_at,
      "updatedAt": mapping_updated_at,
    },
    "updatedAt": mapping_updated_at,
  }


def _decode_subprocess_output(raw_value: bytes | str | None) -> str:
  if raw_value is None:
    return ""
  if isinstance(raw_value, bytes):
    return raw_value.decode("utf-8", errors="replace")
  return str(raw_value)


def _split_transcript_for_mapping(transcript: str, chunk_size: int = 6000) -> list[str]:
  normalized = transcript.replace("\r\n", "\n").strip()
  if not normalized:
    return []

  chunks: list[str] = []
  cursor = 0

  while cursor < len(normalized):
    end = min(cursor + chunk_size, len(normalized))
    if end < len(normalized):
      search_window = normalized[end : min(end + 800, len(normalized))]
      boundary_match = re.search(r"[\n。！？?!；;]", search_window)
      if boundary_match:
        end += boundary_match.start() + 1

    chunk = normalized[cursor:end].strip()
    if chunk:
      chunks.append(chunk)
    cursor = end

  return chunks


def _split_lecture_content_into_chunks(
  *,
  page_number: int,
  content: str,
  max_chars: int = 1100,
) -> list[dict[str, Any]]:
  normalized = re.sub(r"\s+", " ", content).strip()
  if not normalized:
    return []

  fragments = [fragment.strip() for fragment in re.findall(r"[^。！？?!；;]+[。！？?!；;]?", normalized) if fragment.strip()]
  if not fragments:
    fragments = [normalized]

  chunks: list[dict[str, Any]] = []
  buffer = ""
  chunk_index = 1

  def push_buffer() -> None:
    nonlocal buffer, chunk_index
    value = buffer.strip()
    if not value:
      return
    chunks.append(
      {
        "id": f"{page_number}-{chunk_index}",
        "page_number": page_number,
        "chunk_index": chunk_index,
        "content": value,
      }
    )
    chunk_index += 1
    buffer = ""

  for fragment in fragments:
    if len(fragment) > max_chars:
      push_buffer()
      for cursor in range(0, len(fragment), max_chars):
        value = fragment[cursor : cursor + max_chars].strip()
        if not value:
          continue
        chunks.append(
          {
            "id": f"{page_number}-{chunk_index}",
            "page_number": page_number,
            "chunk_index": chunk_index,
            "content": value,
          }
        )
        chunk_index += 1
      continue

    next_value = f"{buffer} {fragment}".strip() if buffer else fragment
    if len(next_value) > max_chars and buffer:
      push_buffer()
      buffer = fragment
      continue

    buffer = next_value

  push_buffer()
  return chunks


def _build_lecture_retrieval_chunks(lecture_markdown: str) -> list[dict[str, Any]]:
  lecture_pages: list[dict[str, Any]] = []
  matches = list(re.finditer(r"^##\s*[^\n\r]*?(\d+)[^\n\r]*$", lecture_markdown, re.MULTILINE))
  for index, match in enumerate(matches):
    page_number = int(match.group(1))
    start = match.start()
    end = matches[index + 1].start() if index + 1 < len(matches) else len(lecture_markdown)
    content = re.sub(r"^##\s*[^\n\r]*$", "", lecture_markdown[start:end], count=1, flags=re.MULTILINE)
    content = re.sub(r"\s+", " ", content).strip()
    lecture_pages.append({"page_number": page_number, "content": content})

  if not lecture_pages:
    return _split_lecture_content_into_chunks(page_number=1, content=lecture_markdown)

  chunks: list[dict[str, Any]] = []
  for page in lecture_pages:
    chunks.extend(
      _split_lecture_content_into_chunks(
        page_number=page["page_number"],
        content=page["content"],
      )
    )
  return chunks


def _fetch_embedding_batch(
  *,
  base_url: str,
  api_key: str,
  inputs: list[str],
  model: str = CLASSROOM_EMBEDDING_MODEL,
) -> list[list[float]]:
  base_url, api_key, model = _resolve_runtime_provider_config(
    'embedding',
    base_url,
    api_key,
    model,
  )
  response = requests.post(
    _normalize_embeddings_base_url(base_url),
    headers={
      "Authorization": f"Bearer {api_key.strip()}",
      "Content-Type": "application/json",
    },
    data=json.dumps(
      {
        "model": model,
        "input": inputs,
      }
    ),
    timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
  )

  payload = _parse_response_json(response)
  if not response.ok:
    detail = str(payload.get("detail") or payload)
    error = payload.get("error")
    if isinstance(error, dict):
      detail = str(error.get("message") or detail)
    raise HTTPException(status_code=502, detail=f"Embedding request failed: {detail}")

  data = payload.get("data")
  if not isinstance(data, list):
    raise HTTPException(status_code=502, detail="Embedding model returned an invalid payload.")

  ordered = sorted(
    (item for item in data if isinstance(item, dict)),
    key=lambda item: int(item.get("index") or 0),
  )
  embeddings: list[list[float]] = []
  for item in ordered:
    raw_embedding = item.get("embedding")
    if not isinstance(raw_embedding, list):
      raise HTTPException(status_code=502, detail="Embedding model returned an invalid vector.")
    embeddings.append([float(value) for value in raw_embedding])

  if len(embeddings) != len(inputs) or not all(embeddings):
    raise HTTPException(status_code=502, detail="Embedding model returned incomplete vectors.")

  return embeddings


def _fetch_embeddings(
  *,
  base_url: str,
  api_key: str,
  inputs: list[str],
  model: str = CLASSROOM_EMBEDDING_MODEL,
) -> list[list[float]]:
  def fetch_embeddings_adaptive(batch: list[str]) -> list[list[float]]:
    try:
      return _fetch_embedding_batch(
        base_url=base_url,
        api_key=api_key,
        inputs=batch,
        model=model,
      )
    except HTTPException:
      if len(batch) <= 1:
        raise
      midpoint = (len(batch) + 1) // 2
      return fetch_embeddings_adaptive(batch[:midpoint]) + fetch_embeddings_adaptive(batch[midpoint:])

  embeddings: list[list[float]] = []
  for index in range(0, len(inputs), CLASSROOM_EMBEDDING_BATCH_SIZE):
    batch = inputs[index : index + CLASSROOM_EMBEDDING_BATCH_SIZE]
    embeddings.extend(fetch_embeddings_adaptive(batch))
  return embeddings


def _cosine_similarity(left: list[float], right: list[float]) -> float:
  if not left or not right or len(left) != len(right):
    return -1.0

  dot = 0.0
  left_norm = 0.0
  right_norm = 0.0
  for left_value, right_value in zip(left, right, strict=False):
    dot += left_value * right_value
    left_norm += left_value * left_value
    right_norm += right_value * right_value

  if left_norm <= 0 or right_norm <= 0:
    return -1.0

  return dot / ((left_norm ** 0.5) * (right_norm ** 0.5))


def _diversify_retrieved_lecture_chunks(chunks: list[dict[str, Any]]) -> list[dict[str, Any]]:
  result: list[dict[str, Any]] = []
  skipped: list[dict[str, Any]] = []
  page_counts: dict[int, int] = {}

  for chunk in chunks:
    page_number = int(chunk.get("page_number") or 0)
    current_count = page_counts.get(page_number, 0)
    if current_count >= CLASSROOM_RETRIEVAL_MAX_PER_PAGE:
      skipped.append(chunk)
      continue
    result.append(chunk)
    page_counts[page_number] = current_count + 1

  for chunk in skipped:
    if len(result) >= CLASSROOM_RETRIEVAL_TOP_COUNT:
      break
    result.append(chunk)

  return result[:CLASSROOM_RETRIEVAL_TOP_COUNT]


def _rerank_retrieved_lecture_chunks(
  *,
  base_url: str,
  api_key: str,
  query: str,
  candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
  if not candidates:
    return []

  try:
    base_url, api_key, model = _resolve_runtime_provider_config(
      'rerank',
      base_url,
      api_key,
      CLASSROOM_RERANK_MODEL,
    )
    response = requests.post(
      _normalize_rerank_base_url(base_url),
      headers={
        "Authorization": f"Bearer {api_key.strip()}",
        "Content-Type": "application/json",
      },
      data=json.dumps(
        {
          "model": model,
          "query": query,
          "documents": [str(candidate.get("content") or "") for candidate in candidates],
          "top_n": min(CLASSROOM_RETRIEVAL_TOP_COUNT, len(candidates)),
        }
      ),
      timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
    )
    payload = _parse_response_json(response)
    if not response.ok:
      raise HTTPException(status_code=502, detail="Rerank endpoint rejected the request.")

    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
      raw_results = payload.get("data")
    if not isinstance(raw_results, list):
      return _diversify_retrieved_lecture_chunks(candidates)

    reranked: list[dict[str, Any]] = []
    for item in raw_results:
      if not isinstance(item, dict):
        continue
      index = int(item.get("index") or -1)
      if index < 0 or index >= len(candidates):
        continue
      reranked_item = dict(candidates[index])
      reranked_item["score"] = float(item.get("relevance_score") or item.get("score") or reranked_item.get("score") or 0.0)
      reranked.append(reranked_item)

    return _diversify_retrieved_lecture_chunks(reranked or candidates)
  except Exception:
    return _diversify_retrieved_lecture_chunks(candidates)


def _retrieve_relevant_lecture_chunks(
  *,
  transcript_chunk: str,
  lecture_chunks: list[dict[str, Any]],
  lecture_embeddings: list[list[float]],
  base_url: str,
  api_key: str,
) -> list[dict[str, Any]]:
  if not lecture_chunks or not lecture_embeddings:
    return []

  retrieval_query = _build_transcript_retrieval_query(transcript_chunk)
  query_embeddings = _fetch_embeddings(
    base_url=base_url,
    api_key=api_key,
    inputs=[retrieval_query],
    model=CLASSROOM_EMBEDDING_MODEL,
  )
  query_embedding = query_embeddings[0]

  ranked = sorted(
    [
      {
        **chunk,
        "score": _cosine_similarity(query_embedding, lecture_embeddings[index] if index < len(lecture_embeddings) else []),
      }
      for index, chunk in enumerate(lecture_chunks)
    ],
    key=lambda item: float(item.get("score") or -1.0),
    reverse=True,
  )[:CLASSROOM_RETRIEVAL_CANDIDATE_COUNT]

  return _rerank_retrieved_lecture_chunks(
    base_url=base_url,
    api_key=api_key,
    query=retrieval_query,
    candidates=ranked,
  )


def _build_retrieved_lecture_context(chunks: list[dict[str, Any]]) -> str:
  return "\n\n".join(
    [
      (
        f"[Page {int(chunk.get('page_number') or 0)} | "
        f"Chunk {int(chunk.get('chunk_index') or 0)} | "
        f"Score {float(chunk.get('score') or 0.0):.4f}]\n"
        f"{str(chunk.get('content') or '').strip()}"
      )
      for chunk in chunks
      if str(chunk.get("content") or "").strip()
    ]
  )


def _build_transcript_retrieval_query(transcript_chunk: str, max_chars: int = 1000) -> str:
  normalized = re.sub(r"\s+", " ", transcript_chunk).strip()
  if len(normalized) <= max_chars:
    return normalized

  slice_size = max_chars // 3
  middle_start = max(0, len(normalized) // 2 - slice_size // 2)
  middle = normalized[middle_start : middle_start + slice_size].strip()
  head = normalized[:slice_size].strip()
  tail = normalized[-slice_size:].strip()
  return "\n".join(part for part in (head, middle, tail) if part)


def _normalize_search_text(text: str) -> str:
  return re.sub(r"[^\w\u4e00-\u9fff]+", "", text.lower(), flags=re.UNICODE)


def _build_lecture_page_anchors(lecture_markdown: str) -> list[dict[str, Any]]:
  lecture_pages: list[dict[str, Any]] = []
  matches = list(re.finditer(r"^##\s*[^\n\r]*?(\d+)[^\n\r]*$", lecture_markdown, re.MULTILINE))
  for index, match in enumerate(matches):
    page_number = int(match.group(1))
    start = match.start()
    end = matches[index + 1].start() if index + 1 < len(matches) else len(lecture_markdown)
    content = re.sub(r"^##\s*[^\n\r]*$", "", lecture_markdown[start:end], count=1, flags=re.MULTILINE)
    content = re.sub(r"\s+", " ", content).strip()
    if content:
      lecture_pages.append({"page_number": page_number, "content": content})

  if lecture_pages:
    return lecture_pages

  normalized = re.sub(r"\s+", " ", lecture_markdown).strip()
  return [{"page_number": 1, "content": normalized}] if normalized else []


def _split_transcript_text_to_sentences(transcript: str) -> list[dict[str, Any]]:
  normalized = transcript.replace("\r\n", "\n").strip()
  if not normalized:
    return []

  fragments = [fragment.strip() for fragment in re.findall(r"[^。！？?!；;\n]+[。！？?!；;\n]*", normalized) if fragment.strip()]
  if not fragments:
    fragments = [normalized]

  return [
    {
      "id": f"text-sentence-{index + 1}",
      "text": fragment,
      "start_seconds": None,
      "end_seconds": None,
      "order": index,
    }
    for index, fragment in enumerate(fragments)
  ]


def _normalize_transcript_sentences(raw_sentences: Any, transcript: str) -> list[dict[str, Any]]:
  if not isinstance(raw_sentences, list) or not raw_sentences:
    return _split_transcript_text_to_sentences(transcript)

  normalized: list[dict[str, Any]] = []
  for index, item in enumerate(raw_sentences):
    if not isinstance(item, dict):
      continue
    text = str(item.get("text") or "").strip()
    if not text:
      continue
    start_seconds = item.get("start_seconds")
    if start_seconds is None:
      start_seconds = item.get("startSeconds")
    end_seconds = item.get("end_seconds")
    if end_seconds is None:
      end_seconds = item.get("endSeconds")
    normalized.append(
      {
        "id": str(item.get("id") or f"sentence-{index + 1}"),
        "text": text,
        "start_seconds": float(start_seconds) if isinstance(start_seconds, (int, float)) else None,
        "end_seconds": float(end_seconds) if isinstance(end_seconds, (int, float)) else None,
        "order": int(item.get("order") or index),
      }
    )

  normalized.sort(key=lambda sentence: int(sentence.get("order") or 0))
  return normalized if normalized else _split_transcript_text_to_sentences(transcript)


def _build_sentence_text_for_embedding(sentence: dict[str, Any]) -> str:
  start_seconds = sentence.get("start_seconds")
  end_seconds = sentence.get("end_seconds")
  time_label = (
    f"[{start_seconds if start_seconds is not None else '?'}-{end_seconds if end_seconds is not None else '?'}] "
    if start_seconds is not None or end_seconds is not None
    else ""
  )
  return f"{time_label}{str(sentence.get('text') or '').strip()}".strip()


def _build_transcript_mapping_windows(
  transcript_sentences: list[dict[str, Any]],
  window_chars: int = 500,
  stride_chars: int = 380,
) -> list[dict[str, Any]]:
  usable_sentences = [
    sentence for sentence in transcript_sentences if str(sentence.get("text") or "").strip()
  ]
  if not usable_sentences:
    return []

  cursor = 0
  sentence_ranges: list[dict[str, Any]] = []
  for sentence in usable_sentences:
    text = str(sentence.get("text") or "").strip()
    start = cursor
    end = start + len(text)
    cursor = end + 1
    sentence_ranges.append(
      {
        "sentence": sentence,
        "text": text,
        "start": start,
        "end": end,
      }
    )

  total_length = max(0, cursor - 1)
  windows: list[dict[str, Any]] = []
  seen_ranges: set[str] = set()
  window_index = 0
  start_char = 0

  while start_char < total_length:
    end_char = min(total_length, start_char + window_chars)
    included = [
      entry
      for entry in sentence_ranges
      if int(entry.get("end") or 0) > start_char and int(entry.get("start") or 0) < end_char
    ]
    if included:
      start_order = int(included[0]["sentence"].get("order") or 0)
      end_order = int(included[-1]["sentence"].get("order") or start_order)
      range_key = f"{start_order}-{end_order}"
      if range_key not in seen_ranges:
        seen_ranges.add(range_key)
        start_seconds = next(
          (
            float(entry["sentence"]["start_seconds"])
            for entry in included
            if isinstance(entry["sentence"].get("start_seconds"), (int, float))
          ),
          None,
        )
        end_seconds = next(
          (
            float(entry["sentence"]["end_seconds"])
            for entry in reversed(included)
            if isinstance(entry["sentence"].get("end_seconds"), (int, float))
          ),
          None,
        )
        windows.append(
          {
            "id": f"window-{window_index + 1}",
            "index": window_index,
            "text": "\n".join(entry["text"] for entry in included).strip(),
            "sentence_ids": [
              str(entry["sentence"].get("id") or "").strip()
              for entry in included
              if str(entry["sentence"].get("id") or "").strip()
            ],
            "start_seconds": start_seconds,
            "end_seconds": end_seconds,
            "start_order": start_order,
            "end_order": end_order,
          }
        )
    if end_char >= total_length:
      break
    start_char += stride_chars
    window_index += 1

  return windows


def _summarize_lecture_segment_text(text: str) -> str:
  return re.sub(r"\s+", " ", text).strip()[:96]


def _merge_lecture_segment_text(current: str, next_text: str) -> str:
  normalized_current = current.strip()
  normalized_next = next_text.strip()
  if not normalized_current:
    return normalized_next
  if not normalized_next:
    return normalized_current
  if normalized_next in normalized_current:
    return normalized_current
  if normalized_current in normalized_next:
    return normalized_next
  return f"{normalized_current}\n{normalized_next}".strip()


def _merge_sequential_classroom_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
  merged: list[dict[str, Any]] = []
  for segment in segments:
    previous = merged[-1] if merged else None
    previous_pages = previous.get("pageNumbers") if isinstance(previous, dict) else None
    current_pages = segment.get("pageNumbers")
    same_pages = isinstance(previous_pages, list) and isinstance(current_pages, list) and previous_pages == current_pages
    previous_ids = previous.get("sourceSentenceIds") if isinstance(previous, dict) else None
    current_ids = segment.get("sourceSentenceIds")
    has_overlap = (
      isinstance(previous_ids, list)
      and isinstance(current_ids, list)
      and bool(set(str(item) for item in previous_ids) & set(str(item) for item in current_ids))
    )
    if previous and same_pages and has_overlap:
      previous["polishedText"] = _merge_lecture_segment_text(
        str(previous.get("polishedText") or ""),
        str(segment.get("polishedText") or ""),
      )
      previous["summary"] = _summarize_lecture_segment_text(str(previous.get("polishedText") or ""))
      if not str(previous.get("anchorText") or "").strip():
        previous["anchorText"] = str(segment.get("anchorText") or "").strip()
      if isinstance(segment.get("endSeconds"), (int, float)):
        previous["endSeconds"] = float(segment.get("endSeconds"))
      previous["sourceSentenceIds"] = list(
        dict.fromkeys(
          [
            *[str(item).strip() for item in previous_ids if str(item).strip()],
            *[str(item).strip() for item in current_ids if str(item).strip()],
          ]
        )
      )
      continue
    merged.append(dict(segment))
  return merged


def _rerank_transcript_sentences(
  *,
  base_url: str,
  api_key: str,
  query: str,
  candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
  if not candidates:
    return []

  try:
    base_url, api_key, model = _resolve_runtime_provider_config(
      'rerank',
      base_url,
      api_key,
      CLASSROOM_RERANK_MODEL,
    )
    response = requests.post(
      _normalize_rerank_base_url(base_url),
      headers={
        "Authorization": f"Bearer {api_key.strip()}",
        "Content-Type": "application/json",
      },
      data=json.dumps(
        {
          "model": model,
          "query": query,
          "documents": [str(candidate.get("text") or "") for candidate in candidates],
          "top_n": min(CLASSROOM_PAGE_TOP_COUNT, len(candidates)),
        }
      ),
      timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
    )
    payload = _parse_response_json(response)
    if not response.ok:
      raise HTTPException(status_code=502, detail="Rerank endpoint rejected the request.")

    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
      raw_results = payload.get("data")
    if not isinstance(raw_results, list):
      return candidates[:CLASSROOM_PAGE_TOP_COUNT]

    reranked: list[dict[str, Any]] = []
    for item in raw_results:
      if not isinstance(item, dict):
        continue
      index = int(item.get("index") or -1)
      if index < 0 or index >= len(candidates):
        continue
      reranked_item = dict(candidates[index])
      reranked_item["score"] = float(item.get("relevance_score") or item.get("score") or reranked_item.get("score") or 0.0)
      reranked.append(reranked_item)

    return (reranked or candidates)[:CLASSROOM_PAGE_TOP_COUNT]
  except Exception:
    return candidates[:CLASSROOM_PAGE_TOP_COUNT]


def _estimate_lecture_page_anchors(
  *,
  lecture_pages: list[dict[str, Any]],
  transcript_sentences: list[dict[str, Any]],
  base_url: str,
  api_key: str,
) -> list[dict[str, Any]]:
  if not lecture_pages:
    return []
  if not transcript_sentences:
    return [
      {
        **page,
        "anchor_order": None,
        "start_order": 0,
        "end_order": 0,
      }
      for page in lecture_pages
    ]

  lecture_embeddings = _fetch_embeddings(
    base_url=base_url,
    api_key=api_key,
    inputs=[str(page.get("content") or "")[:4000] for page in lecture_pages],
    model=CLASSROOM_EMBEDDING_MODEL,
  )
  sentence_embeddings = _fetch_embeddings(
    base_url=base_url,
    api_key=api_key,
    inputs=[_build_sentence_text_for_embedding(sentence)[:2000] for sentence in transcript_sentences],
    model=CLASSROOM_EMBEDDING_MODEL,
  )

  anchors: list[dict[str, Any]] = []
  for page_index, page in enumerate(lecture_pages):
    page_embedding = lecture_embeddings[page_index] if page_index < len(lecture_embeddings) else []
    best_order: int | None = None
    best_score = -1.0
    for sentence_index, sentence in enumerate(transcript_sentences):
      score = _cosine_similarity(page_embedding, sentence_embeddings[sentence_index] if sentence_index < len(sentence_embeddings) else [])
      if score > best_score:
        best_score = score
        best_order = int(sentence.get("order") or 0)
    anchors.append(
      {
        **page,
        "anchor_order": best_order,
        "start_order": 0,
        "end_order": int(transcript_sentences[-1].get("order") or 0),
      }
    )

  monotonic_anchors: list[dict[str, Any]] = []
  for index, anchor in enumerate(anchors):
    anchor_order = anchor.get("anchor_order")
    if anchor_order is None:
      monotonic_anchors.append(anchor)
      continue
    previous = anchors[index - 1].get("anchor_order") if index > 0 else None
    next_value = anchors[index + 1].get("anchor_order") if index + 1 < len(anchors) else None
    value = int(anchor_order)
    if previous is not None and value < int(previous):
      value = int(previous)
    if next_value is not None and value > int(next_value):
      value = int(next_value)
    monotonic_anchors.append({**anchor, "anchor_order": value})

  resolved: list[dict[str, Any]] = []
  last_order = int(transcript_sentences[-1].get("order") or 0)
  for index, anchor in enumerate(monotonic_anchors):
    previous_anchor = monotonic_anchors[index - 1].get("anchor_order") if index > 0 else None
    next_anchor = monotonic_anchors[index + 1].get("anchor_order") if index + 1 < len(monotonic_anchors) else None
    start_order = max(0, int(previous_anchor) if previous_anchor is not None else 0)
    end_order = max(start_order, int(next_anchor) if next_anchor is not None else last_order)
    resolved.append({**anchor, "start_order": start_order, "end_order": end_order})

  return resolved


def _collect_window_sentences_for_page(
  page_anchor: dict[str, Any],
  transcript_sentences: list[dict[str, Any]],
) -> list[dict[str, Any]]:
  if not transcript_sentences:
    return []

  start_order = max(0, int(page_anchor.get("start_order") or 0) - CLASSROOM_PAGE_WINDOW_PADDING)
  end_order = min(
    int(transcript_sentences[-1].get("order") or 0),
    int(page_anchor.get("end_order") or 0) + CLASSROOM_PAGE_WINDOW_PADDING,
  )
  return [
    sentence
    for sentence in transcript_sentences
    if start_order <= int(sentence.get("order") or 0) <= end_order and str(sentence.get("text") or "").strip()
  ]


def _retrieve_top_transcript_sentences_for_page(
  *,
  page_anchor: dict[str, Any],
  window_sentences: list[dict[str, Any]],
  base_url: str,
  api_key: str,
) -> list[dict[str, Any]]:
  if not window_sentences:
    return []

  query_embedding = _fetch_embeddings(
    base_url=base_url,
    api_key=api_key,
    inputs=[str(page_anchor.get("content") or "")[:4000]],
    model=CLASSROOM_EMBEDDING_MODEL,
  )[0]
  sentence_embeddings = _fetch_embeddings(
    base_url=base_url,
    api_key=api_key,
    inputs=[_build_sentence_text_for_embedding(sentence)[:2000] for sentence in window_sentences],
    model=CLASSROOM_EMBEDDING_MODEL,
  )

  ranked = sorted(
    [
      {
        **sentence,
        "score": _cosine_similarity(query_embedding, sentence_embeddings[index] if index < len(sentence_embeddings) else []),
      }
      for index, sentence in enumerate(window_sentences)
    ],
    key=lambda item: float(item.get("score") or -1.0),
    reverse=True,
  )[:CLASSROOM_PAGE_CANDIDATE_COUNT]

  return _rerank_transcript_sentences(
    base_url=base_url,
    api_key=api_key,
    query=str(page_anchor.get("content") or "")[:4000],
    candidates=ranked,
  )


def _request_lecture_page_segments(
  *,
  page_anchor: dict[str, Any],
  candidate_sentences: list[dict[str, Any]],
  base_url: str,
  api_key: str,
  model: str,
) -> dict[str, Any]:
  if not candidate_sentences:
    return {"polishedOverview": "", "segments": []}

  sentence_context = "\n\n".join(
    [
      "\n".join(
        [
          f"Candidate {index + 1}",
          f"id: {sentence.get('id')}",
          f"time: {sentence.get('start_seconds') if sentence.get('start_seconds') is not None else '?'}-{sentence.get('end_seconds') if sentence.get('end_seconds') is not None else '?'}s",
          f"order: {sentence.get('order')}",
          f"text: {str(sentence.get('text') or '').strip()}",
        ]
      )
      for index, sentence in enumerate(sorted(candidate_sentences, key=lambda item: int(item.get("order") or 0)))
    ]
  )

  response = requests.post(
    _normalize_chat_base_url(base_url),
    headers={
      "Authorization": f"Bearer {api_key.strip()}",
      "Content-Type": "application/json",
    },
    data=json.dumps(
      {
        "model": model.strip() or CLASSROOM_MAPPING_MODEL,
        "temperature": 0.2,
        "messages": [
          {
            "role": "system",
            "content": " ".join(
              [
                "You are a course slicing expert.",
                "Use the current PPT page as the only query anchor.",
                "Judge which candidate transcript sentences truly belong to this PPT page.",
                "Only make minimal readability cleanup. Do not summarize away content.",
                "Return JSON only.",
              ]
            ),
          },
          {
            "role": "user",
            "content": "\n\n".join(
              [
                "Return a JSON object in this shape:",
                '{"polishedOverview":"","segments":[{"title":"","summary":"","polishedText":"","anchorText":"","pageNumbers":[1],"startSeconds":0,"endSeconds":1,"sourceSentenceIds":["id-1"]}]}',
                "Rules:",
                "1. Query is the current PPT page content only.",
                "2. Documents are the candidate transcript sentences only.",
                '3. Keep only sentences that truly belong to this PPT page; if none match, return {"polishedOverview":"","segments":[]}.',
                "4. polishedText must stay close to the original transcript wording and only be lightly cleaned.",
                "5. pageNumbers must contain the current PPT page number. Nearby overlap pages may be added only when clearly necessary.",
                "6. startSeconds and endSeconds must come from the matched candidate sentence times. If unavailable, return null.",
                "7. sourceSentenceIds must list matched candidate ids in chronological order.",
                f"Current PPT page: {int(page_anchor.get('page_number') or 0)}",
                f"PPT page content:\n{str(page_anchor.get('content') or '')[:6000]}",
                f"Candidate transcript sentences:\n{sentence_context}",
              ]
            ),
          },
        ],
      }
    ),
    timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
  )

  if not response.ok:
    detail = response.text.strip()
    try:
      payload = response.json()
      if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
          detail = str(error.get("message") or detail)
    except Exception:
      detail = response.text.strip() or f"HTTP {response.status_code}"
    raise HTTPException(status_code=502, detail=f"Lesson mapping request failed: {detail}")

  payload = _parse_response_json(response)
  choices = payload.get("choices")
  if not isinstance(choices, list) or not choices:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return choices.")

  message = choices[0].get("message") if isinstance(choices[0], dict) else None
  content = message.get("content") if isinstance(message, dict) else ""
  content_text = str(content or "").strip()
  if not content_text:
    raise HTTPException(status_code=502, detail="Lesson mapping model returned empty content.")

  normalized = re.sub(r"```(?:json)?", "", content_text, flags=re.IGNORECASE).strip()
  start = normalized.find("{")
  end = normalized.rfind("}")
  if start < 0 or end < start:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return a JSON object.")

  try:
    return json.loads(normalized[start : end + 1])
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=502, detail=f"Lesson mapping model returned invalid JSON: {exc}") from exc


def _request_sliding_window_page_mapping(
  *,
  transcript_window: dict[str, Any],
  candidates: list[dict[str, Any]],
  base_url: str,
  api_key: str,
  model: str,
) -> dict[str, Any]:
  if not candidates:
    return {
      "polishedText": "",
      "anchorText": "",
      "matchedPageNumbers": [],
      "sourceSentenceIds": [],
    }

  candidate_context = "\n\n".join(
    [
      "\n".join(
        [
          f"{'Buffer page' if candidate.get('role') == 'buffer' else 'Current page'}: {int(candidate.get('page_number') or 0)}",
          f"scoreHint: {float(candidate.get('score') or 0.0):.4f}",
          f"content:\n{str(candidate.get('content') or '')[:5000]}",
        ]
      )
      for candidate in candidates
    ]
  )

  response = requests.post(
    _normalize_chat_base_url(base_url),
    headers={
      "Authorization": f"Bearer {api_key.strip()}",
      "Content-Type": "application/json",
    },
    data=json.dumps(
      {
        "model": model.strip() or CLASSROOM_MAPPING_MODEL,
        "temperature": 0.2,
        "messages": [
          {
            "role": "system",
            "content": " ".join(
              [
                "You map a forward-moving classroom transcript window onto slides.",
                "The lecture generally moves forward.",
                "Candidates include at most one buffer slide from the previous confirmed page and one current slide.",
                "Keep the transcript wording nearly verbatim and only lightly clean it.",
                "Return JSON only.",
              ]
            ),
          },
          {
            "role": "user",
            "content": "\n\n".join(
              [
                "Return a JSON object in this shape:",
                '{"polishedText":"","anchorText":"","matchedPageNumbers":[1],"sourceSentenceIds":["id-1"]}',
                "Rules:",
                "1. matchedPageNumbers must be a subset of the provided candidate slide page numbers.",
                "2. If the transcript window still belongs to the previous slide, keep the buffer page in matchedPageNumbers.",
                "3. If the transcript window has clearly moved onto the current slide, include the current slide page number.",
                "4. During slide transition, matchedPageNumbers may contain both buffer and current page.",
                '5. If this transcript window matches neither candidate page, return matchedPageNumbers as an empty array.',
                "6. polishedText must stay close to the original transcript wording and should not summarize away content.",
                "7. anchorText should be a short phrase from the lecture page content or transcript window that helps locate the page.",
                "8. sourceSentenceIds must be chosen only from the provided sourceSentenceIds list and kept in order.",
                f"sourceSentenceIds: {', '.join(transcript_window.get('sentence_ids') or [])}",
                f"Transcript window:\n{str(transcript_window.get('text') or '')}",
                f"Candidate pages:\n{candidate_context}",
              ]
            ),
          },
        ],
      }
    ),
    timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
  )

  if not response.ok:
    detail = response.text.strip()
    try:
      payload = response.json()
      if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
          detail = str(error.get("message") or detail)
    except Exception:
      detail = response.text.strip() or f"HTTP {response.status_code}"
    raise HTTPException(status_code=502, detail=f"Lesson mapping request failed: {detail}")

  payload = _parse_response_json(response)
  choices = payload.get("choices")
  if not isinstance(choices, list) or not choices:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return choices.")

  message = choices[0].get("message") if isinstance(choices[0], dict) else None
  content = message.get("content") if isinstance(message, dict) else ""
  content_text = str(content or "").strip()
  if not content_text:
    raise HTTPException(status_code=502, detail="Lesson mapping model returned empty content.")

  normalized = re.sub(r"```(?:json)?", "", content_text, flags=re.IGNORECASE).strip()
  start = normalized.find("{")
  end = normalized.rfind("}")
  if start < 0 or end < start:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return a JSON object.")

  try:
    return json.loads(normalized[start : end + 1])
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=502, detail=f"Lesson mapping model returned invalid JSON: {exc}") from exc


def _derive_lecture_page_from_anchor(lecture_markdown: str, anchor_text: str) -> int | None:
  normalized_anchor = anchor_text.strip()
  if not normalized_anchor:
    return None

  anchor_index = lecture_markdown.find(normalized_anchor)
  if anchor_index < 0:
    return None

  preceding = lecture_markdown[:anchor_index]
  page_markers = list(re.finditer(r"^##\s*[^\n\r]*?(\d+)[^\n\r]*$", preceding, re.MULTILINE))
  if not page_markers:
    return None

  page_number = int(page_markers[-1].group(1))
  return page_number if page_number > 0 else None


def _derive_lecture_page_from_signals(lecture_markdown: str, signals: list[str]) -> int | None:
  pages = _build_lecture_retrieval_chunks(lecture_markdown)
  if not pages:
    return None

  normalized_signals = [_normalize_search_text(signal.strip()) for signal in signals if signal.strip()]
  normalized_signals = [signal for signal in normalized_signals if len(signal) >= 2]
  if not normalized_signals:
    return None

  best_page_number: int | None = None
  best_score = 0
  page_haystacks: dict[int, str] = {}

  for page in pages:
    page_number = int(page.get("page_number") or 0)
    if page_number <= 0:
      continue
    existing = page_haystacks.get(page_number, "")
    page_haystacks[page_number] = f"{existing} {str(page.get('content') or '')}".strip()

  for page_number, content in page_haystacks.items():
    haystack = _normalize_search_text(content)
    if not haystack:
      continue

    score = 0
    for signal in normalized_signals:
      if signal in haystack:
        score += max(len(signal), 1)

    if score > best_score:
      best_score = score
      best_page_number = page_number

  return best_page_number if best_score > 0 else None


def _normalize_classroom_segments_payload(
  payload: dict[str, Any],
  lecture_markdown: str,
) -> list[dict[str, Any]]:
  raw_segments = payload.get("segments")
  if not isinstance(raw_segments, list):
    return []

  normalized_segments: list[dict[str, Any]] = []
  for index, item in enumerate(raw_segments, start=1):
    if not isinstance(item, dict):
      continue
    title = str(item.get("title") or "Lecture Segment").strip() or "Lecture Segment"
    summary = str(item.get("summary") or "").strip()
    polished_text = str(item.get("polishedText") or item.get("content") or "").strip()
    anchor_text = str(item.get("anchorText") or "").strip()

    raw_pages = item.get("pageNumbers")
    model_pages = (
      [int(page_number) for page_number in raw_pages if isinstance(page_number, (int, float, str)) and str(page_number).strip()]
      if isinstance(raw_pages, list)
      else []
    )
    model_pages = [page_number for page_number in model_pages if page_number > 0]

    derived_page = _derive_lecture_page_from_anchor(lecture_markdown, anchor_text) or _derive_lecture_page_from_signals(
      lecture_markdown,
      [
        anchor_text,
        title,
        summary,
        polished_text[:220],
      ],
    )
    page_numbers = sorted({*model_pages, *([derived_page] if derived_page else [])})

    if not polished_text:
      continue

    normalized_segments.append(
      {
        "title": title or f"Lecture Segment {index}",
        "summary": summary,
        "polishedText": polished_text,
        "anchorText": anchor_text,
        "pageNumbers": page_numbers,
        "startSeconds": float(item.get("startSeconds")) if isinstance(item.get("startSeconds"), (int, float)) else None,
        "endSeconds": float(item.get("endSeconds")) if isinstance(item.get("endSeconds"), (int, float)) else None,
        "sourceSentenceIds": [
          str(sentence_id).strip()
          for sentence_id in (item.get("sourceSentenceIds") or [])
          if str(sentence_id).strip()
        ] if isinstance(item.get("sourceSentenceIds"), list) else [],
      }
    )

  return normalized_segments


def _request_classroom_mapping_chunk(
  *,
  transcript_chunk: str,
  retrieved_lecture_chunks: list[dict[str, Any]],
  base_url: str,
  api_key: str,
  model: str,
) -> dict[str, Any]:
  candidate_pages = sorted(
    {
      int(chunk.get("page_number") or 0)
      for chunk in retrieved_lecture_chunks
      if int(chunk.get("page_number") or 0) > 0
    }
  )
  lecture_context = _build_retrieved_lecture_context(retrieved_lecture_chunks)

  response = requests.post(
    _normalize_chat_base_url(base_url),
    headers={
      "Authorization": f"Bearer {api_key.strip()}",
      "Content-Type": "application/json",
    },
    data=json.dumps(
      {
        "model": model.strip() or CLASSROOM_MAPPING_MODEL,
        "temperature": 0.2,
        "messages": [
          {
            "role": "system",
            "content": " ".join(
              [
                "You are a lecture transcript cleanup and slide-page mapping assistant.",
                "You are given a transcript snippet and pre-retrieved lecture chunks that are likely relevant.",
                "Only make minimal edits for readability: add punctuation, fix obvious broken sentence boundaries, and correct obvious ASR mistakes only when very certain.",
                "Do not summarize, compress, generalize, rewrite heavily, or add new explanations.",
                "Preserve the original order and keep as much of the original wording as possible.",
                "Return JSON only.",
                "When formulas appear, format them with standard LaTeX delimiters such as $...$ or $$...$$.",
              ]
            ),
          },
          {
            "role": "user",
            "content": "\n\n".join(
              [
                "Return a JSON object in this shape:",
                '{"polishedOverview":"","segments":[{"title":"","summary":"","polishedText":"","anchorText":"","pageNumbers":[1]}]}',
                "Requirements:",
                "1. polishedOverview must be an empty string.",
                "2. segments must cover this transcript chunk in order, using consecutive near-verbatim lecture snippets.",
                "3. polishedText must stay close to the transcript wording and should only be lightly cleaned for readability.",
                "4. summary, if present, must be a very short copied or lightly cleaned phrase from the same snippet, not a conceptual summary.",
                "5. pageNumbers must include all lecture pages related to that snippet, and a snippet may map to multiple pages.",
                "6. anchorText should use a short lecture phrase or transcript keyword that helps locate the page.",
                f"Candidate lecture pages: {', '.join(str(page) for page in candidate_pages) if candidate_pages else 'none'}",
                f"Relevant lecture chunks:\n{lecture_context}",
                f"Transcript chunk:\n{transcript_chunk}",
              ]
            ),
          },
        ],
      }
    ),
    timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
  )

  if not response.ok:
    detail = response.text.strip()
    try:
      payload = response.json()
      if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
          detail = str(error.get("message") or detail)
    except Exception:
      detail = response.text.strip() or f"HTTP {response.status_code}"
    raise HTTPException(status_code=502, detail=f"Lesson mapping request failed: {detail}")

  payload = _parse_response_json(response)
  choices = payload.get("choices")
  if not isinstance(choices, list) or not choices:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return choices.")

  message = choices[0].get("message") if isinstance(choices[0], dict) else None
  content = message.get("content") if isinstance(message, dict) else ""
  content_text = str(content or "").strip()
  if not content_text:
    raise HTTPException(status_code=502, detail="Lesson mapping model returned empty content.")

  normalized = re.sub(r"```(?:json)?", "", content_text, flags=re.IGNORECASE).strip()
  start = normalized.find("{")
  end = normalized.rfind("}")
  if start < 0 or end < start:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return a JSON object.")

  try:
    return json.loads(normalized[start : end + 1])
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=502, detail=f"Lesson mapping model returned invalid JSON: {exc}") from exc


def transcribe_audio_file_with_chunking(file_path: Path) -> dict[str, Any]:
  asr_config = load_api_config() or {}
  is_local_asr = _is_local_asr_config(asr_config)
  chunk_seconds = AUDIO_CHUNK_SECONDS if is_local_asr else CLOUD_ASR_CHUNK_SECONDS
  chunk_dir, chunk_paths, duration_seconds = _segment_audio_for_asr(
    file_path,
    chunk_seconds=chunk_seconds,
  )

  try:
    if not is_local_asr:
      return _transcribe_audio_chunks_with_cloud_asr(
        chunk_paths=chunk_paths,
        duration_seconds=duration_seconds,
        source_name=file_path.name,
        config=asr_config,
        chunk_seconds=chunk_seconds,
      )

    if not LOCAL_ASR_PYTHON.is_file():
      raise HTTPException(
        status_code=500,
        detail=f"Local ASR Python was not found: {LOCAL_ASR_PYTHON}",
      )
    if not LOCAL_ASR_SCRIPT.is_file():
      raise HTTPException(
        status_code=500,
        detail=f"Local ASR helper script was not found: {LOCAL_ASR_SCRIPT}",
      )

    missing_model_dirs = [
      str(path)
      for path in (LOCAL_ASR_MODEL_DIR, LOCAL_ASR_VAD_DIR, LOCAL_ASR_PUNC_DIR)
      if not path.is_dir()
    ]
    if missing_model_dirs:
      raise HTTPException(
        status_code=500,
        detail=f"Local FunASR model directories are missing: {', '.join(missing_model_dirs)}",
      )

    helper_output_path = chunk_dir / "funasr-output.json"
    helper_command = [
      str(LOCAL_ASR_PYTHON),
      str(LOCAL_ASR_SCRIPT),
      "--output",
      str(helper_output_path),
      "--model-dir",
      str(LOCAL_ASR_MODEL_DIR),
      "--vad-dir",
      str(LOCAL_ASR_VAD_DIR),
      "--punc-dir",
      str(LOCAL_ASR_PUNC_DIR),
    ]
    if LOCAL_ASR_DEVICE:
      helper_command.extend(["--device", LOCAL_ASR_DEVICE])
    helper_command.extend(["--input", *[str(chunk_path) for chunk_path in chunk_paths]])

    helper_timeout_seconds = max(
      AUDIO_REQUEST_TIMEOUT_SECONDS * max(len(chunk_paths), 1) + 120,
      600,
    )

    helper_env = os.environ.copy()
    helper_env.setdefault("HF_HUB_OFFLINE", "1")
    helper_env.setdefault("TRANSFORMERS_OFFLINE", "1")

    try:
      helper_result = subprocess.run(
        helper_command,
        check=True,
        capture_output=True,
        text=False,
        timeout=helper_timeout_seconds,
        env=helper_env,
      )
    except subprocess.TimeoutExpired as exc:
      raise HTTPException(
        status_code=504,
        detail=(
          f"Local FunASR timed out after {int(helper_timeout_seconds)} seconds while "
          f"processing {len(chunk_paths)} audio chunk(s)."
        ),
      ) from exc
    except subprocess.CalledProcessError as exc:
      detail = (
        _decode_subprocess_output(exc.stderr).strip()
        or _decode_subprocess_output(exc.stdout).strip()
        or "Unknown local FunASR error"
      )
      raise HTTPException(status_code=502, detail=f"Local FunASR transcription failed: {detail}") from exc

    if not helper_output_path.is_file():
      detail = (
        _decode_subprocess_output(helper_result.stderr).strip()
        or _decode_subprocess_output(helper_result.stdout).strip()
        or "Helper output file was not created."
      )
      raise HTTPException(status_code=502, detail=f"Local FunASR transcription failed: {detail}")

    try:
      helper_payload = json.loads(helper_output_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
      raise HTTPException(status_code=502, detail=f"Local FunASR returned invalid JSON: {exc}") from exc

    helper_results = helper_payload.get("results")
    if not isinstance(helper_results, list):
      raise HTTPException(status_code=502, detail="Local FunASR returned an invalid results payload.")

    chunks: list[dict[str, Any]] = []
    transcript_parts: list[str] = []

    chunk_result_map: dict[str, dict[str, Any]] = {}
    for item in helper_results:
      if not isinstance(item, dict):
        continue
      file_name = str(item.get("file_name") or "").strip()
      if file_name:
        chunk_result_map[file_name] = item

    for index, chunk_path in enumerate(chunk_paths, start=1):
      payload = chunk_result_map.get(chunk_path.name, {})
      transcript = _extract_asr_text(payload)
      chunk_start = round((index - 1) * AUDIO_CHUNK_SECONDS, 2)
      chunk_end = round(min(index * AUDIO_CHUNK_SECONDS, duration_seconds or index * AUDIO_CHUNK_SECONDS), 2)

      chunk_entry = {
        "index": index,
        "file_name": chunk_path.name,
        "start_seconds": chunk_start,
        "end_seconds": chunk_end,
        "text": transcript,
        "empty": not bool(transcript),
      }
      segments = payload.get("segments")
      if isinstance(segments, list):
        normalized_segments: list[dict[str, Any]] = []
        for segment in segments:
          if not isinstance(segment, dict):
            continue
          try:
            local_start_seconds = float(segment.get("start") or 0) / 1000
            local_end_seconds = float(segment.get("end") or 0) / 1000
          except (TypeError, ValueError):
            local_start_seconds = 0
            local_end_seconds = 0
          normalized_segments.append(
            segment
            | {
              "start_seconds": round(chunk_start + local_start_seconds, 3),
              "end_seconds": round(chunk_start + local_end_seconds, 3),
            }
          )
        chunk_entry["segments"] = normalized_segments
      chunks.append(chunk_entry)
      if transcript:
        transcript_parts.append(transcript.strip())

    transcript = "\n".join(part for part in transcript_parts if part).strip()
    if not transcript:
      raise HTTPException(status_code=502, detail="Local FunASR did not return any usable transcript text.")

    markdown_path = _write_asr_debug_outputs(
      transcript=transcript,
      chunks=chunks,
      source_name=file_path.name,
      duration_seconds=duration_seconds,
      model=LOCAL_ASR_MODEL,
    )
    result = {
      "text": transcript,
      "chunks": chunks,
      "chunk_count": len(chunks),
      "duration_seconds": duration_seconds,
      "engine": "local-funasr",
      "model": LOCAL_ASR_MODEL,
      "python": str(LOCAL_ASR_PYTHON),
      "markdown_path": markdown_path,
    }
    return result
  finally:
    shutil.rmtree(chunk_dir, ignore_errors=True)


def build_classroom_session_from_text_api(
  *,
  transcript: str,
  lecture_markdown: str,
  base_url: str,
  api_key: str,
  model: str,
) -> dict[str, Any]:
  lecture_pages: list[dict[str, Any]] = []
  matches = list(re.finditer(r"^##\s*[^\n\r]*?(\d+)[^\n\r]*$", lecture_markdown, re.MULTILINE))
  for index, match in enumerate(matches):
    page_number = int(match.group(1))
    start = match.start()
    end = matches[index + 1].start() if index + 1 < len(matches) else len(lecture_markdown)
    content = re.sub(r"^##\s*[^\n\r]*$", "", lecture_markdown[start:end], count=1, flags=re.MULTILINE)
    content = re.sub(r"\s+", " ", content).strip()
    lecture_pages.append({"page_number": page_number, "content": content})

  lecture_digest = "\n".join(
    f"第 {page['page_number']} 页：{page['content'][:420]}"
    for page in lecture_pages
    if page["content"]
  )[:36000]

  response = requests.post(
    _normalize_chat_base_url(base_url),
    headers={
      "Authorization": f"Bearer {api_key.strip()}",
      "Content-Type": "application/json",
    },
    data=json.dumps(
      {
        "model": model.strip(),
        "temperature": 0.2,
        "messages": [
          {
            "role": "system",
            "content": (
              "你是课堂讲义整理与页码映射助手。"
              "请把课堂转写内容整理成通顺的课堂讲解片段，并严格返回 JSON 对象，"
              "不要输出 Markdown，不要解释，不要代码块。"
            ),
          },
          {
            "role": "user",
            "content": "\n".join(
              [
                "请基于以下讲义和课堂转写，返回一个 JSON 对象：",
                '{"polishedOverview":"","segments":[{"title":"","summary":"","polishedText":"","anchorText":"","pageNumbers":[1]}]}',
                "要求：",
                "1. polishedOverview 概括这次课堂主要讲了什么。",
                "2. segments 必须拆成多个课堂片段，每个片段都要语言通顺，适合直接给学生阅读。",
                "3. pageNumbers 填写该片段对应的所有讲义页码；只要讲解内容与某页知识点相关，就应建立关联，可以多页。",
                "4. anchorText 尽量摘录讲义中的短语或课堂中的关键词，方便回查定位。",
                "5. 如果模型不完全确定页码，也要给出最可能的讲义页，不要留空。",
                "",
                f"讲义分页摘要：\n{lecture_digest}",
                "",
                f"讲义 Markdown：\n{lecture_markdown[:36000]}",
                "",
                f"课堂转写文本：\n{transcript[:20000]}",
              ]
            ),
          },
        ],
      }
    ),
    timeout=AUDIO_REQUEST_TIMEOUT_SECONDS,
  )

  if not response.ok:
    detail = response.text.strip()
    try:
      payload = response.json()
      if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
          detail = str(error.get("message") or detail)
    except Exception:
      detail = response.text.strip() or f"HTTP {response.status_code}"
    raise HTTPException(status_code=502, detail=f"Lesson mapping request failed: {detail}")

  payload = _parse_response_json(response)
  choices = payload.get("choices")
  if not isinstance(choices, list) or not choices:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return choices.")

  message = choices[0].get("message") if isinstance(choices[0], dict) else None
  content = message.get("content") if isinstance(message, dict) else ""
  content_text = str(content or "").strip()
  if not content_text:
    raise HTTPException(status_code=502, detail="Lesson mapping model returned empty content.")

  normalized = re.sub(r"```(?:json)?", "", content_text, flags=re.IGNORECASE).strip()
  start = normalized.find("{")
  end = normalized.rfind("}")
  if start < 0 or end < start:
    raise HTTPException(status_code=502, detail="Lesson mapping model did not return a JSON object.")

  try:
    return json.loads(normalized[start : end + 1])
  except json.JSONDecodeError as exc:
    raise HTTPException(status_code=502, detail=f"Lesson mapping model returned invalid JSON: {exc}") from exc


def build_classroom_session_from_text_api_v2(
  *,
  transcript: str,
  lecture_markdown: str,
  base_url: str,
  api_key: str,
  model: str,
) -> dict[str, Any]:
  transcript_sentences = _normalize_transcript_sentences([], transcript)
  if not transcript_sentences:
    raise HTTPException(status_code=400, detail="Transcript is empty.")

  lecture_pages = _build_lecture_page_anchors(lecture_markdown)
  transcript_windows = _build_transcript_mapping_windows(transcript_sentences)
  if not lecture_pages or not transcript_windows:
    return {
      "polishedOverview": "",
      "segments": [],
    }

  lecture_page_embeddings = _fetch_embeddings(
    base_url=base_url,
    api_key=api_key,
    inputs=[str(page.get("content") or "")[:4000] for page in lecture_pages],
    model=CLASSROOM_EMBEDDING_MODEL,
  )
  transcript_window_embeddings = _fetch_embeddings(
    base_url=base_url,
    api_key=api_key,
    inputs=[str(window.get("text") or "")[:2000] for window in transcript_windows],
    model=CLASSROOM_EMBEDDING_MODEL,
  )
  collected_segments: list[dict[str, Any]] = []
  current_page_index = 0
  buffer_page_index: int | None = None
  current_page_misses = 0

  for window in transcript_windows:
    if current_page_index >= len(lecture_pages) and buffer_page_index is None:
      break

    candidate_page_indices = list(
      dict.fromkeys(
        [
          page_index
          for page_index in [buffer_page_index, current_page_index]
          if isinstance(page_index, int) and 0 <= page_index < len(lecture_pages)
        ]
      )
    )
    if not candidate_page_indices:
      continue

    window_embedding = transcript_window_embeddings[int(window.get("index") or 0)] if int(window.get("index") or 0) < len(transcript_window_embeddings) else []
    candidates: list[dict[str, Any]] = []
    for page_index in candidate_page_indices:
      page = lecture_pages[page_index]
      candidates.append(
        {
          "page_index": page_index,
          "page_number": int(page.get("page_number") or 0),
          "content": str(page.get("content") or ""),
          "role": "current" if page_index == current_page_index else "buffer",
          "score": _cosine_similarity(
            window_embedding,
            lecture_page_embeddings[page_index] if page_index < len(lecture_page_embeddings) else [],
          ),
        }
      )

    current_candidate = next((candidate for candidate in candidates if candidate.get("role") == "current"), None)
    buffer_candidate = next((candidate for candidate in candidates if candidate.get("role") == "buffer"), None)
    best_candidate_score = max((float(candidate.get("score") or -1.0) for candidate in candidates), default=-1.0)

    matched_page_numbers: list[int] = []
    polished_text = ""
    anchor_text = ""
    source_sentence_ids = [
      str(sentence_id).strip()
      for sentence_id in (window.get("sentence_ids") or [])
      if str(sentence_id).strip()
    ]

    if best_candidate_score >= 0.1:
      parsed = _request_sliding_window_page_mapping(
        transcript_window=window,
        candidates=candidates,
        base_url=base_url,
        api_key=api_key,
        model=model,
      )
      raw_matched_pages = (
        parsed.get("matchedPageNumbers")
        if isinstance(parsed.get("matchedPageNumbers"), list)
        else parsed.get("pageNumbers")
        if isinstance(parsed.get("pageNumbers"), list)
        else []
      )
      matched_page_numbers = sorted(
        {
          int(page_number)
          for page_number in raw_matched_pages
          if str(page_number).strip()
          and any(int(candidate.get("page_number") or 0) == int(page_number) for candidate in candidates)
        }
      )
      polished_text = str(parsed.get("polishedText") or "").strip()
      anchor_text = str(parsed.get("anchorText") or "").strip()
      if isinstance(parsed.get("sourceSentenceIds"), list):
        allowed_ids = set(source_sentence_ids)
        filtered_ids = [
          str(sentence_id).strip()
          for sentence_id in parsed.get("sourceSentenceIds")
          if str(sentence_id).strip() and str(sentence_id).strip() in allowed_ids
        ]
        if filtered_ids:
          source_sentence_ids = filtered_ids

    buffer_matched = (
      isinstance(buffer_candidate, dict)
      and int(buffer_candidate.get("page_number") or 0) in matched_page_numbers
    )
    current_matched = (
      isinstance(current_candidate, dict)
      and int(current_candidate.get("page_number") or 0) in matched_page_numbers
    )

    if matched_page_numbers:
      next_text = polished_text or str(window.get("text") or "").strip()
      collected_segments.append(
        {
          "title": f"课堂讲解 · 第 {' / '.join(str(page_number) for page_number in matched_page_numbers)} 页",
          "summary": _summarize_lecture_segment_text(next_text),
          "polishedText": next_text,
          "anchorText": anchor_text,
          "pageNumbers": matched_page_numbers,
          "startSeconds": float(window.get("start_seconds")) if isinstance(window.get("start_seconds"), (int, float)) else None,
          "endSeconds": float(window.get("end_seconds")) if isinstance(window.get("end_seconds"), (int, float)) else None,
          "sourceSentenceIds": source_sentence_ids,
        }
      )

    if buffer_candidate and not buffer_matched:
      buffer_page_index = None

    if current_matched and current_candidate:
      buffer_page_index = int(current_candidate.get("page_index") or 0)
      current_page_index = int(current_candidate.get("page_index") or 0) + 1
      current_page_misses = 0
      continue

    if buffer_matched:
      current_page_misses = 0
      continue

    if current_candidate and float(current_candidate.get("score") or -1.0) < 0.1:
      current_page_misses += 1
      if current_page_misses >= 4:
        current_page_index = min(current_page_index + 1, len(lecture_pages))
        current_page_misses = 0
    else:
      current_page_misses = 0

  normalized_segments = _normalize_classroom_segments_payload(
    {
      "segments": _merge_sequential_classroom_segments(collected_segments),
    },
    lecture_markdown,
  )

  return {
    "polishedOverview": "",
    "segments": normalized_segments,
  }


def _extract_layout_blocks_from_archive_payload(payload: Any) -> list[dict[str, Any]]:
  # Retained only as an import-safe compatibility shim for external callers.
  # The active local MinerU parser exposes normalized blocks through DocumentPipeline.
  return []

  if not isinstance(payload, list):
    return []

  blocks: list[dict[str, Any]] = []

  for index, item in enumerate(payload):
    if not isinstance(item, dict):
      continue

    page_number: int | None = None
    if isinstance(item.get("page_idx"), (int, float)):
      page_number = int(item["page_idx"]) + 1
    else:
      for key in ("page_no", "page_num", "page_number", "page"):
        if isinstance(item.get(key), (int, float)):
          page_number = int(item[key])
          break

    bbox = _normalize_mineru_bbox(item.get("bbox") or item.get("box") or item.get("poly"))
    if not page_number or page_number < 1 or bbox is None:
      continue

    kind = _normalize_mineru_block_kind(item.get("type"), item.get("sub_type"))
    text = _collect_mineru_block_text(item)
    label = str(
      item.get("label")
      or item.get("sub_type")
      or item.get("type")
      or f"第 {page_number} 页区块 {index + 1}"
    ).strip()

    if not text:
      if kind == "formula":
        text = "公式区域"
      elif kind == "image":
        text = "图片区域"
      elif kind == "table":
        text = "表格区域"
      else:
        text = label

    blocks.append(
      {
        "id": f"page-{page_number}-block-{len(blocks) + 1}",
        "pageNumber": page_number,
        "kind": kind,
        "label": label,
        "text": text,
        "bbox": bbox,
      }
    )

  return blocks


@backend_router.get("/api/health")
async def health() -> dict[str, str]:
  return {"status": "ok"}


def _convert_office_to_pdf(source_path: Path, output_dir: Path) -> Path:
  """用本机 PowerPoint/Word (COM) 把 ppt/pptx/doc/docx 转成 PDF。

  Windows 上服务器机器装了 Office 才可用；找不到对应 COM 组件就抛 500，
  让前端把该文件当作 office 直接走 MinerU（不阻断整体拉取流程）。
  """
  import pythoncom  # type: ignore
  import win32com.client  # type: ignore

  suffix = source_path.suffix.lower()
  if suffix in (".ppt", ".pptx"):
    app_id = "PowerPoint.Application"
  elif suffix in (".doc", ".docx"):
    app_id = "Word.Application"
  else:
    raise HTTPException(status_code=422, detail=f"暂不支持的 Office 转换类型: {suffix}")

  output_dir.mkdir(parents=True, exist_ok=True)
  target_pdf = output_dir / f"{source_path.stem}.pdf"
  app = None
  doc = None
  com_initialized = False
  try:
    pythoncom.CoInitialize()
    com_initialized = True
    app = win32com.client.DispatchEx(app_id)
    # 尽量后台运行，不弹界面；Word/PowerPoint 对 Visible 的支持略有差异，统一关掉。
    try:
      app.Visible = False
    except Exception:
      pass
    if app_id == "PowerPoint.Application":
      try:
        app.DisplayAlerts = False
      except Exception:
        pass
      doc = app.Presentations.Open(
        os.path.abspath(source_path),
        ReadOnly=True,
        Untitled=False,
        WithWindow=False,
      )
      doc.SaveAs(os.path.abspath(target_pdf), 32)  # 32 = ppSaveAsPDF
    else:  # Word
      doc = app.Documents.Open(
        os.path.abspath(source_path),
        ReadOnly=True,
        Visible=False,
      )
      doc.SaveAs2(os.path.abspath(target_pdf), 17)  # 17 = wdFormatPDF

    if not target_pdf.is_file():
      raise HTTPException(status_code=502, detail="Office 转 PDF 未输出文件。")
    return target_pdf
  except HTTPException:
    raise
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f"Office 转 PDF 失败: {exc}") from exc
  finally:
    if doc is not None:
      try:
        doc.Close(False)
      except Exception:
        pass
    if app is not None:
      try:
        app.Quit()
      except Exception:
        pass
    if com_initialized:
      try:
        pythoncom.CoUninitialize()
      except Exception:
        pass


@backend_router.post("/api/office/to-pdf")
async def convert_office_to_pdf(file: UploadFile = File(...)) -> Response:
  suffix = _guess_upload_suffix(file)
  if suffix.lower() not in (".ppt", ".pptx", ".doc", ".docx"):
    raise HTTPException(status_code=422, detail="仅支持 ppt/pptx/doc/docx 转 PDF。")

  temp_dir = Path(tempfile.mkdtemp(prefix="student-platform-office-convert-"))
  source_path = temp_dir / f"source{suffix}"
  try:
    file.file.seek(0)
    with source_path.open("wb") as target:
      shutil.copyfileobj(file.file, target)

    pdf_path = _run_in_thread(_convert_office_to_pdf, source_path, temp_dir)
    pdf_bytes = pdf_path.read_bytes()
    download_name = f"{Path(file.filename or 'converted').stem}.pdf"
    return Response(
      content=pdf_bytes,
      media_type="application/pdf",
      headers={"Content-Disposition": _build_download_content_disposition(download_name)},
    )
  finally:
    shutil.rmtree(temp_dir, ignore_errors=True)


def _run_in_thread(func, *args):
  import concurrent.futures

  with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
    return pool.submit(func, *args).result()


def _build_download_content_disposition(file_name: str) -> str:
  sanitized_name = file_name.replace('"', "").replace("\r", " ").replace("\n", " ").strip() or "download"
  ascii_fallback = re.sub(r"[^A-Za-z0-9._-]+", "_", sanitized_name).strip("._") or "download"
  encoded_name = quote(sanitized_name, safe="")
  return f'attachment; filename="{ascii_fallback}"; filename*=UTF-8\'\'{encoded_name}'


@backend_router.post("/api/audio/transcribe")
async def transcribe_audio(
  file: UploadFile = File(...),
  course_id: str | None = Form(None),
  document_id: str | None = Form(None),
) -> dict[str, Any]:
  source_dir: Path | None = None
  source_path: Path | None = None
  try:
    source_dir, source_path = _write_upload_file_to_temp(file)
    result = transcribe_audio_file_with_chunking(source_path)
    normalized_course_id = str(course_id or '').strip()
    normalized_document_id = str(document_id or '').strip()
    if bool(normalized_course_id) != bool(normalized_document_id):
      raise HTTPException(status_code=422, detail='course_id and document_id must be provided together.')
    if normalized_course_id and normalized_document_id:
      recording_id = str(uuid.uuid4())
      recording_dir = PROJECT_ROOT / '.runtime' / 'audio-recordings' / normalized_course_id / recording_id
      recording_dir.mkdir(parents=True, exist_ok=True)
      saved_audio_path = recording_dir / f'source{source_path.suffix or ".bin"}'
      shutil.copy2(source_path, saved_audio_path)
      recording = LectureRecording(
        id=recording_id,
        course_id=normalized_course_id,
        document_id=normalized_document_id,
        audio_path=str(saved_audio_path.relative_to(PROJECT_ROOT)),
        duration=float(result.get('duration_seconds') or 0),
      )
      transcript_segments: list[TranscriptSegment] = []
      for chunk_index, chunk in enumerate(result.get('chunks') or [], start=1):
        if not isinstance(chunk, dict):
          continue
        raw_segments = chunk.get('segments')
        if isinstance(raw_segments, list) and raw_segments:
          for segment_index, segment in enumerate(raw_segments, start=1):
            if not isinstance(segment, dict) or not str(segment.get('text') or '').strip():
              continue
            transcript_segments.append(TranscriptSegment(
              id=f'{recording_id}:segment:{chunk_index}:{segment_index}',
              recording_id=recording_id,
              start_time=float(segment.get('start_seconds') or chunk.get('start_seconds') or 0),
              end_time=float(segment.get('end_seconds') or chunk.get('end_seconds') or 0),
              text=str(segment.get('text') or '').strip(),
            ))
        elif str(chunk.get('text') or '').strip():
          transcript_segments.append(TranscriptSegment(
            id=f'{recording_id}:chunk:{chunk_index}',
            recording_id=recording_id,
            start_time=float(chunk.get('start_seconds') or 0),
            end_time=float(chunk.get('end_seconds') or 0),
            text=str(chunk.get('text') or '').strip(),
          ))
      if not transcript_segments:
        raise HTTPException(status_code=502, detail='ASR returned text but no timestamped transcript segments.')
      AudioAlignmentService().register(recording, transcript_segments)
      result['recording'] = recording.model_dump()
      result['transcript_segment_count'] = len(transcript_segments)
    return result
  finally:
    if source_dir is not None:
      shutil.rmtree(source_dir, ignore_errors=True)


@backend_router.get("/api/audio/debug-mapping")
async def get_latest_debug_mapping() -> dict[str, Any]:
  return _load_latest_debug_mapping_payload()


@backend_router.post('/api/audio/recordings')
async def register_lecture_recording(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  """Persist timestamped ASR output before any page alignment is attempted."""
  try:
    recording = LectureRecording.model_validate(payload.get('recording') or payload)
    segments = [
      TranscriptSegment.model_validate(item)
      for item in (payload.get('transcript_segments') or [])
    ]
    return AudioAlignmentService().register(recording, segments)
  except ValueError as exc:
    raise HTTPException(status_code=422, detail=str(exc)) from exc


@backend_router.post('/api/audio/recordings/{recording_id}/align')
async def align_lecture_recording(
  recording_id: str,
  payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
  """Run ordered AI page alignment; this intentionally never queries Qdrant."""
  course_id = str(payload.get('course_id') or '').strip()
  document_id = str(payload.get('document_id') or '').strip()
  if not course_id or not document_id:
    raise HTTPException(status_code=422, detail='course_id and document_id are required.')
  pages = get_document_pipeline().pages(document_id)
  if any(str(page.get('course_id') or '') != course_id for page in pages):
    raise HTTPException(status_code=422, detail='Document does not belong to the requested course.')
  try:
    return await run_pipeline_task(AudioAlignmentService().align, course_id, recording_id, pages)
  except (FileNotFoundError, ValueError) as exc:
    raise HTTPException(status_code=422, detail=str(exc)) from exc


@backend_router.get('/api/audio/recordings/{recording_id}')
async def get_lecture_recording(recording_id: str, course_id: str) -> dict[str, Any]:
  try:
    return AudioAlignmentService().store.read(course_id, recording_id)
  except FileNotFoundError as exc:
    raise HTTPException(status_code=404, detail=str(exc)) from exc


@backend_router.get('/api/audio/recordings/{recording_id}/media')
async def stream_lecture_recording_audio(recording_id: str, course_id: str) -> FileResponse:
  """Stream the original recording for timestamp-based page playback."""
  try:
    stored = AudioAlignmentService().store.read(course_id, recording_id)
    recording = LectureRecording.model_validate(stored.get('recording') or {})
  except (FileNotFoundError, ValueError) as exc:
    raise HTTPException(status_code=404, detail='Lecture recording was not found.') from exc

  recordings_root = (PROJECT_ROOT / '.runtime' / 'audio-recordings').resolve()
  audio_path = (PROJECT_ROOT / recording.audio_path).resolve()
  try:
    audio_path.relative_to(recordings_root)
  except ValueError as exc:
    raise HTTPException(status_code=400, detail='Invalid lecture recording path.') from exc
  if not audio_path.is_file():
    raise HTTPException(status_code=404, detail='Lecture recording media file is unavailable.')

  media_type = mimetypes.guess_type(audio_path.name)[0] or 'application/octet-stream'
  return FileResponse(audio_path, media_type=media_type, filename=audio_path.name)


def create_app():
  return create_app_with_router(backend_router, lifespan=application_lifespan)


app = create_app()


build_classroom_session_from_text_api = build_classroom_session_from_text_api_v2


__all__ = [
  "app",
  "backend_router",
  "build_classroom_session_from_text_api",
  "create_app",
  "mount_student_learning_platform_demo_frontend",
  "transcribe_audio_file_with_chunking",
]
