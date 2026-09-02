from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from .user_answers import (
  UserAnswerError,
  UserAnswerNotFound,
  UserAnswerStore,
  UserAnswerValidationError,
)
from .user_answer_grading import UserAnswerGradingCoordinator


def create_user_answer_router(
  store: UserAnswerStore,
  grading: UserAnswerGradingCoordinator | None = None,
) -> APIRouter:
  router = APIRouter(prefix='/api/user-answers', tags=['user-question-answers'])

  def translate(error: UserAnswerError) -> HTTPException:
    if isinstance(error, UserAnswerNotFound):
      return HTTPException(status_code=404, detail=str(error))
    if isinstance(error, UserAnswerValidationError):
      return HTTPException(status_code=422, detail=str(error))
    return HTTPException(status_code=500, detail='Unable to process user answer.')

  @router.get('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}')
  async def get_answer(course_id: str, source_document_id: str, question_id: str) -> dict:
    try:
      answer = await asyncio.to_thread(store.get, course_id, source_document_id, question_id)
      return {'answer': answer.model_dump() if answer else None}
    except UserAnswerError as error:
      raise translate(error) from error

  @router.post('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}')
  async def upload_answer(
    course_id: str,
    source_document_id: str,
    question_id: str,
    source_type: str = Form(...),
    files: list[UploadFile] = File(...),
  ) -> dict:
    try:
      answer = await asyncio.to_thread(
        store.replace,
        course_id,
        source_document_id,
        question_id,
        source_type,
        files,
      )
      if grading is not None:
        grading.queue(answer)
      return {'answer': answer.model_dump()}
    except UserAnswerError as error:
      raise translate(error) from error

  @router.delete('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}')
  async def delete_answer(course_id: str, source_document_id: str, question_id: str) -> dict:
    try:
      deleted = await asyncio.to_thread(store.delete, course_id, source_document_id, question_id)
      return {'deleted': deleted}
    except UserAnswerError as error:
      raise translate(error) from error

  @router.get('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}/assets/{asset_id}')
  async def get_answer_asset(
    course_id: str,
    source_document_id: str,
    question_id: str,
    asset_id: str,
  ) -> FileResponse:
    try:
      path, asset = await asyncio.to_thread(
        store.asset, course_id, source_document_id, question_id, asset_id,
      )
      return FileResponse(
        path,
        media_type=asset.content_type,
        filename=asset.filename,
        content_disposition_type='inline',
      )
    except UserAnswerError as error:
      raise translate(error) from error

  @router.get('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}/attempts')
  async def list_attempts(course_id: str, source_document_id: str, question_id: str) -> dict:
    try:
      attempts = await asyncio.to_thread(
        store.list_attempts, course_id, source_document_id, question_id,
      )
      return {'attempts': [attempt.model_dump() for attempt in attempts]}
    except UserAnswerError as error:
      raise translate(error) from error

  @router.get('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}/attempts/{attempt_id}')
  async def get_attempt(
    course_id: str,
    source_document_id: str,
    question_id: str,
    attempt_id: str,
  ) -> dict:
    try:
      attempt = await asyncio.to_thread(
        store.get_attempt, course_id, source_document_id, question_id, attempt_id,
      )
      if attempt is None:
        raise UserAnswerNotFound('User answer attempt not found.')
      return {'answer': attempt.model_dump()}
    except UserAnswerError as error:
      raise translate(error) from error

  @router.post('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}/attempts/{attempt_id}/grade')
  async def retry_grading(
    course_id: str,
    source_document_id: str,
    question_id: str,
    attempt_id: str,
  ) -> dict:
    try:
      attempt = await asyncio.to_thread(
        store.get_attempt, course_id, source_document_id, question_id, attempt_id,
      )
      if attempt is None:
        raise UserAnswerNotFound('User answer attempt not found.')
      if grading is None:
        raise UserAnswerValidationError('Answer grading is not configured.')
      queued = grading.queue(attempt)
      return {'queued': queued, 'answer': attempt.model_dump()}
    except UserAnswerError as error:
      raise translate(error) from error

  @router.get('/courses/{course_id}/documents/{source_document_id}/questions/{question_id}/attempts/{attempt_id}/assets/{asset_id}')
  async def get_attempt_asset(
    course_id: str,
    source_document_id: str,
    question_id: str,
    attempt_id: str,
    asset_id: str,
  ) -> FileResponse:
    try:
      path, asset = await asyncio.to_thread(
        store.asset,
        course_id,
        source_document_id,
        question_id,
        asset_id,
        attempt_id,
      )
      return FileResponse(
        path,
        media_type=asset.content_type,
        filename=asset.filename,
        content_disposition_type='inline',
      )
    except UserAnswerError as error:
      raise translate(error) from error

  return router
