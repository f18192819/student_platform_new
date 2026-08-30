from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Protocol

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from .adaptive_testing import delete_learning_document
from .application_runtime import ApplicationRuntime
from .knowledge_storage import (
  delete_knowledge_homework_document,
  is_knowledge_file_deleted,
  sync_knowledge_homework_pipeline_result,
)
from .question_pipeline import QUESTION_UPLOAD_EXTENSIONS


class PipelineRuntime(Protocol):
  def require_document_pipeline(self): ...
  def require_question_pipeline(self): ...
  def require_question_relations(self): ...
  def require_chat_retriever(self): ...
  def require_pipeline_coordinator(self): ...
  async def run_pipeline_task(self, function, *args, **kwargs): ...
  def schedule_question_pipeline_resume(self) -> asyncio.Task: ...


class PipelineApiService:
  """Application workflows for document, question, and relation HTTP APIs."""

  def __init__(self, runtime: PipelineRuntime) -> None:
    self.runtime = runtime

  @property
  def documents(self):
    return self.runtime.require_document_pipeline()

  @property
  def questions(self):
    return self.runtime.require_question_pipeline()

  @property
  def relations(self):
    return self.runtime.require_question_relations()

  @property
  def coordinator(self):
    return self.runtime.require_pipeline_coordinator()

  async def process_document(
    self,
    *,
    source: bytes,
    file_name: str,
    course_id: str,
    document_type: str,
    source_type: str,
    document_id: str | None,
  ) -> dict[str, Any]:
    state = await asyncio.to_thread(
      self.documents.enqueue,
      source=source,
      file_name=file_name,
      course_id=course_id,
      document_type=document_type,
      source_type=source_type,
      document_id=document_id,
    )
    normalized_id = str(state['document_id'])
    asyncio.create_task(
      self.runtime.run_pipeline_task(self.coordinator.run_document_with_relations, normalized_id)
    )
    return self.documents.result(normalized_id)

  async def retry_document(self, document_id: str) -> dict[str, Any]:
    await asyncio.to_thread(self.documents.prepare_retry, document_id)
    asyncio.create_task(
      self.runtime.run_pipeline_task(self.coordinator.run_document_with_relations, document_id)
    )
    return self.documents.result(document_id)

  async def reindex_document(self, document_id: str) -> dict[str, Any]:
    await self.runtime.run_pipeline_task(self.documents.reindex, document_id)
    state = self.documents.result(document_id)
    if state.get('status') == 'completed' and state.get('document_type') == 'lecture':
      await self.runtime.run_pipeline_task(
        self.relations.link_course,
        str(state.get('course_id') or ''),
      )
    return state

  async def move_document(self, document_id: str, course_id: str) -> dict[str, Any]:
    state = await self.runtime.run_pipeline_task(
      self.documents.move_to_course,
      document_id,
      course_id,
    )
    if state.get('status') == 'completed' and state.get('document_type') == 'lecture':
      await self.runtime.run_pipeline_task(self.relations.link_course, course_id)
    return self.documents.result(document_id)

  async def process_question(
    self,
    *,
    source: bytes,
    file_name: str,
    course_id: str,
    document_type: str,
    document_id: str | None,
  ) -> dict[str, Any]:
    state = await self.runtime.run_pipeline_task(
      self.questions.submit,
      source=source,
      file_name=file_name,
      course_id=course_id,
      document_type=document_type,
      document_id=document_id,
    )
    normalized_id = str(state['document_id'])
    result = self.questions.result(normalized_id)
    await self.runtime.run_pipeline_task(
      sync_knowledge_homework_pipeline_result,
      normalized_id,
      result,
    )
    if state.get('status') == 'completed':
      self.coordinator.queue_question_relation_refresh(normalized_id)
    return result

  async def retry_question(self, document_id: str) -> dict[str, Any]:
    state = await self.runtime.run_pipeline_task(self.questions.run, document_id)
    result = self.questions.result(document_id)
    await self.runtime.run_pipeline_task(
      sync_knowledge_homework_pipeline_result,
      document_id,
      result,
    )
    if state.get('status') == 'completed':
      self.coordinator.queue_question_relation_refresh(document_id)
    return result

  async def reextract_question(self, document_id: str) -> dict[str, Any]:
    await self.runtime.run_pipeline_task(self.relations.delete_question_document, document_id)
    await self.runtime.run_pipeline_task(self.relations.remove_target_document, document_id)
    await self.runtime.run_pipeline_task(self.questions.prepare_reextract, document_id)
    state = await self.runtime.run_pipeline_task(self.questions.run, document_id)
    relation_refresh_error = ''
    if state.get('status') == 'completed':
      relation_refresh_error = await self.runtime.run_pipeline_task(
        self.coordinator.refresh_course_relations,
        str(state.get('course_id') or ''),
      )
    result = self.questions.result(document_id)
    if relation_refresh_error:
      result['relation_refresh_error'] = relation_refresh_error
    await self.runtime.run_pipeline_task(
      sync_knowledge_homework_pipeline_result,
      document_id,
      result,
    )
    return result

  async def delete_homework_document(self, course_id: str, document_id: str) -> dict[str, Any]:
    result = await self.runtime.run_pipeline_task(
      delete_knowledge_homework_document,
      course_id,
      document_id,
      self.coordinator.delete_question_with_relations,
    )
    if result.get('deleted'):
      await asyncio.to_thread(delete_learning_document, course_id, document_id)
    return result

  async def question_status(self, document_id: str) -> dict[str, Any]:
    state = await asyncio.to_thread(self.questions.status, document_id)
    status = str(state.get('status') or '')
    if status == 'completed' or status.endswith('_failed'):
      result = await asyncio.to_thread(self.questions.result, document_id)
      await asyncio.to_thread(sync_knowledge_homework_pipeline_result, document_id, result)
      return result
    return state


def create_pipeline_router(runtime: ApplicationRuntime) -> APIRouter:
  router = APIRouter(tags=['pipelines'])
  service = PipelineApiService(runtime)

  @router.post('/api/documents/process')
  async def process_document(
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
      raise HTTPException(status_code=410, detail='This document was deleted and processing was cancelled.')
    return await service.process_document(
      source=await file.read(),
      file_name=file.filename or 'document.pdf',
      course_id=course_id,
      document_type=document_type,
      source_type=source_type,
      document_id=document_id,
    )

  @router.get('/api/documents/{document_id}/status')
  async def document_status(document_id: str) -> dict[str, Any]:
    return service.documents.result(document_id)

  @router.post('/api/documents/{document_id}/retry')
  async def retry_document(document_id: str) -> dict[str, Any]:
    return await service.retry_document(document_id)

  @router.post('/api/documents/{document_id}/reindex')
  async def reindex_document(document_id: str) -> dict[str, Any]:
    return await service.reindex_document(document_id)

  @router.post('/api/documents/{document_id}/move-course')
  async def move_document(
    document_id: str,
    payload: dict[str, Any] = Body(...),
  ) -> dict[str, Any]:
    return await service.move_document(
      document_id,
      str(payload.get('course_id') or '').strip(),
    )

  @router.post('/api/documents/retrieve')
  async def retrieve_document_chunks(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    query = str(payload.get('query') or '').strip()
    if not query:
      raise HTTPException(status_code=422, detail='query is required.')
    return {
      'results': service.documents.retrieve(
        query=query,
        course_id=str(payload.get('course_id') or '').strip(),
        document_type=str(payload.get('document_type') or '').strip(),
        top_n=max(1, min(int(payload.get('top_n') or 8), 50)),
      )
    }

  @router.post('/api/chat/retrieve-context')
  async def retrieve_chat_context(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return await asyncio.to_thread(
      runtime.require_chat_retriever().retrieve,
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

  @router.get('/api/vector-store/storage')
  async def vector_store_storage() -> dict[str, Any]:
    return service.documents.vector_store.storage_summary()

  @router.post('/api/questions/process')
  async def process_question(
    file: UploadFile = File(...),
    course_id: str = Form(...),
    document_type: str = Form(...),
    document_id: str | None = Form(None),
  ) -> dict[str, Any]:
    file_name = str(file.filename or '').strip()
    if Path(file_name).suffix.lower() not in QUESTION_UPLOAD_EXTENSIONS:
      raise HTTPException(
        status_code=422,
        detail='Unsupported question file. Supported formats: PDF, PNG, JPG, JPEG, and WebP.',
      )
    if document_type not in {'homework', 'past-exam'}:
      raise HTTPException(
        status_code=422,
        detail='Question pipeline only accepts homework or past-exam documents.',
      )
    return await service.process_question(
      source=await file.read(),
      file_name=file.filename or 'questions.pdf',
      course_id=course_id,
      document_type=document_type,
      document_id=document_id,
    )

  @router.post('/api/questions/resume-pending')
  async def resume_pending_questions() -> dict[str, Any]:
    pending_count = len(await asyncio.to_thread(service.questions.pending_document_ids))
    if pending_count:
      runtime.schedule_question_pipeline_resume()
    return {
      'checked': True,
      'pending_count': pending_count,
      'message': (
        'Pending questions were queued for recovery.'
        if pending_count
        else 'No question documents require recovery.'
      ),
    }

  @router.post('/api/questions/{document_id}/retry')
  async def retry_question(document_id: str) -> dict[str, Any]:
    return await service.retry_question(document_id)

  @router.post('/api/questions/{document_id}/reextract')
  async def reextract_question(document_id: str) -> dict[str, Any]:
    return await service.reextract_question(document_id)

  @router.get('/api/question-relations/config')
  async def relation_config() -> dict[str, Any]:
    return service.relations.config()

  @router.put('/api/question-relations/config')
  async def update_relation_config(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return service.relations.update_config(payload)

  @router.post('/api/question-relations/documents/{document_id}/run')
  async def run_document_relations(document_id: str) -> dict[str, Any]:
    result = await runtime.run_pipeline_task(service.relations.link_document, document_id)
    service.coordinator.queue_assessment_preparations(set(result.get('question_ids') or []))
    return result

  @router.post('/api/question-relations/documents/{document_id}/questions/{question_id}/run')
  async def run_question_relations(document_id: str, question_id: str) -> dict[str, Any]:
    result = await runtime.run_pipeline_task(
      service.relations.link_document_question,
      document_id,
      question_id,
    )
    service.coordinator.queue_assessment_preparations({question_id})
    return result

  @router.post('/api/question-relations/courses/{course_id}/run')
  async def run_course_relations(course_id: str) -> dict[str, Any]:
    result = await runtime.run_pipeline_task(service.relations.link_course, course_id)
    question_ids = {
      str(question_id)
      for document in result.get('documents') or []
      for question_id in document.get('question_ids') or []
      if str(question_id or '').strip()
    }
    service.coordinator.queue_assessment_preparations(question_ids)
    return result

  @router.get('/api/question-relations/questions/{question_id}')
  async def question_relations(question_id: str) -> dict[str, Any]:
    return service.relations.result(question_id)

  @router.post('/api/question-relations/rebuild-page-indexes')
  async def rebuild_relation_indexes() -> dict[str, Any]:
    return await runtime.run_pipeline_task(service.relations.rebuild_lecture_page_indexes)

  @router.get('/api/question-relations/courses/{course_id}/lectures/{document_id}/pages/{page_number}')
  async def lecture_page_relations(
    course_id: str,
    document_id: str,
    page_number: int,
  ) -> dict[str, Any]:
    return service.relations.lecture_page_relations(course_id, document_id, page_number)

  @router.delete('/api/questions/{document_id}')
  async def delete_question(document_id: str) -> dict[str, Any]:
    await runtime.run_pipeline_task(service.coordinator.delete_question_with_relations, document_id)
    return {'deleted': True, 'document_id': document_id}

  @router.delete('/api/knowledge/courses/{course_id}/homework-documents/{document_id}')
  async def delete_homework_document(course_id: str, document_id: str) -> dict[str, Any]:
    return await service.delete_homework_document(course_id, document_id)

  @router.get('/api/questions/{document_id}/status')
  async def question_status(document_id: str) -> dict[str, Any]:
    return await service.question_status(document_id)

  return router
