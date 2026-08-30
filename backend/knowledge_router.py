from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Body, File, HTTPException, Request, UploadFile
from fastapi.responses import Response

from .adaptive_testing import delete_learning_course, delete_learning_document
from .application_runtime import ApplicationRuntime
from .knowledge_storage import (
  delete_annotation_asset,
  delete_homework_asset,
  delete_knowledge_course,
  delete_knowledge_lecture,
  delete_pdf_bytes,
  mark_knowledge_file_deleted,
  read_annotation_asset,
  read_homework_asset,
  read_knowledge_library,
  read_pdf_bytes,
  update_knowledge_course_settings,
  write_annotation_asset,
  write_homework_binary_asset,
  write_homework_text_asset,
  write_knowledge_library,
  write_pdf_bytes,
)
from .study_plan_storage import read_course_study_plan, write_course_study_plan
from .tsinghua_courseware_state import mark_deleted_synced_courseware


class KnowledgeLibraryService:
  """Coordinates durable knowledge deletion without depending on FastAPI."""

  def __init__(self, runtime: ApplicationRuntime) -> None:
    self.runtime = runtime

  def delete_file(self, file_id: str) -> dict[str, Any]:
    library = read_knowledge_library()
    deleted_file = next(
      (
        item for item in library.get('files') or []
        if isinstance(item, dict) and str(item.get('id') or '') == file_id
      ),
      None,
    )
    mark_knowledge_file_deleted(file_id, deleted_file)
    self.runtime.require_document_pipeline().cancel_and_wait(file_id)
    coordinator = self.runtime.require_pipeline_coordinator()
    result = delete_knowledge_lecture(
      file_id,
      coordinator.delete_document_with_relations,
      coordinator.delete_question_with_relations,
    )
    if result.get('deleted'):
      delete_learning_document(str((deleted_file or {}).get('courseId') or ''), file_id)
      mark_deleted_synced_courseware(deleted_file)
    return result

  def delete_course(self, course_id: str) -> dict[str, Any]:
    library = read_knowledge_library()
    course_files = [
      item for item in library.get('files') or []
      if isinstance(item, dict) and str(item.get('courseId') or '') == course_id
    ]
    for file_record in course_files:
      mark_knowledge_file_deleted(str(file_record.get('id') or ''), file_record)
    coordinator = self.runtime.require_pipeline_coordinator()
    result = delete_knowledge_course(
      course_id,
      coordinator.delete_document_with_relations,
      coordinator.delete_question_with_relations,
      coordinator.delete_course_artifacts,
    )
    if result.get('deleted'):
      delete_learning_course(course_id)
      for file_record in course_files:
        mark_deleted_synced_courseware(file_record)
    return result


def create_knowledge_router(runtime: ApplicationRuntime) -> APIRouter:
  router = APIRouter(tags=['knowledge-library'])
  service = KnowledgeLibraryService(runtime)

  @router.get('/api/knowledge/library')
  async def get_library() -> dict[str, Any]:
    return read_knowledge_library()

  @router.put('/api/knowledge/library')
  async def update_library(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    return write_knowledge_library(payload)

  @router.delete('/api/knowledge/files/{file_id}')
  async def remove_file(file_id: str) -> dict[str, Any]:
    return await asyncio.to_thread(service.delete_file, file_id)

  @router.delete('/api/knowledge/courses/{course_id}')
  async def remove_course(course_id: str) -> dict[str, Any]:
    return await asyncio.to_thread(service.delete_course, course_id)

  @router.patch('/api/knowledge/courses/{course_id}')
  async def update_course(
    course_id: str,
    payload: dict[str, Any] = Body(...),
  ) -> dict[str, Any]:
    return await asyncio.to_thread(update_knowledge_course_settings, course_id, payload)

  @router.get('/api/study-plans/courses/{course_id}')
  async def get_study_plan(course_id: str) -> dict[str, Any]:
    return await asyncio.to_thread(read_course_study_plan, course_id)

  @router.put('/api/study-plans/courses/{course_id}')
  async def update_study_plan(
    course_id: str,
    payload: dict[str, Any] = Body(...),
  ) -> dict[str, Any]:
    return await asyncio.to_thread(write_course_study_plan, course_id, payload)

  @router.get('/api/knowledge/pdf/{file_id}')
  async def get_pdf(file_id: str) -> Response:
    return Response(content=read_pdf_bytes(file_id), media_type='application/pdf')

  @router.put('/api/knowledge/pdf/{file_id}')
  async def update_pdf(file_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
    file.file.seek(0)
    write_pdf_bytes(file_id, file.file.read())
    return {'ok': True, 'fileId': file_id}

  @router.delete('/api/knowledge/pdf/{file_id}')
  async def remove_pdf(file_id: str) -> dict[str, Any]:
    delete_pdf_bytes(file_id)
    return {'ok': True, 'fileId': file_id}

  @router.get('/api/knowledge/annotation-asset/{asset_id}')
  async def get_annotation_asset(asset_id: str) -> dict[str, Any]:
    return {'assetId': asset_id, 'dataUrl': read_annotation_asset(asset_id)}

  @router.put('/api/knowledge/annotation-asset/{asset_id}')
  async def update_annotation_asset(
    asset_id: str,
    payload: dict[str, Any] = Body(...),
  ) -> dict[str, Any]:
    write_annotation_asset(asset_id, str(payload.get('dataUrl') or ''))
    return {'ok': True, 'assetId': asset_id}

  @router.delete('/api/knowledge/annotation-asset/{asset_id}')
  async def remove_annotation_asset(asset_id: str) -> dict[str, Any]:
    delete_annotation_asset(asset_id)
    return {'ok': True, 'assetId': asset_id}

  @router.get('/api/knowledge/homework-asset/{asset_id}', response_model=None)
  async def get_homework_asset(asset_id: str) -> Response | dict[str, Any]:
    payload = read_homework_asset(asset_id)
    if payload['kind'] == 'text':
      return {'assetId': asset_id, 'kind': 'text', 'text': payload['text']}
    return Response(
      content=payload['bytes'],
      media_type=str(payload['contentType'] or 'application/octet-stream'),
      headers={'X-Student-Asset-Kind': 'binary'},
    )

  @router.put('/api/knowledge/homework-asset/{asset_id}')
  async def update_homework_asset(asset_id: str, request: Request) -> dict[str, Any]:
    content_type = (request.headers.get('content-type') or '').lower()
    if content_type.startswith('application/json'):
      payload = await request.json()
      if not isinstance(payload, dict):
        raise HTTPException(status_code=422, detail='Invalid homework asset payload.')
      write_homework_text_asset(asset_id, str(payload.get('text') or ''))
      return {'ok': True, 'assetId': asset_id, 'kind': 'text'}
    write_homework_binary_asset(
      asset_id,
      await request.body(),
      request.headers.get('x-student-content-type')
      or request.headers.get('content-type')
      or 'application/octet-stream',
    )
    return {'ok': True, 'assetId': asset_id, 'kind': 'binary'}

  @router.delete('/api/knowledge/homework-asset/{asset_id}')
  async def remove_homework_asset(asset_id: str) -> dict[str, Any]:
    delete_homework_asset(asset_id)
    return {'ok': True, 'assetId': asset_id}

  return router
