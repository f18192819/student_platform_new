from __future__ import annotations

import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import BinaryIO, Protocol

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT
from .document_pipeline import read_json_file, safe_storage_name, write_json_atomic
from .knowledge_storage import read_knowledge_library


USER_ANSWERS_ROOT = PROJECT_ROOT / '.runtime' / 'user-answers' / 'courses'
MAX_ASSET_BYTES = 50 * 1024 * 1024
MAX_ANSWER_BYTES = 100 * 1024 * 1024
MAX_ASSETS_PER_ANSWER = 20


class UserAnswerError(Exception):
  pass


class UserAnswerNotFound(UserAnswerError):
  pass


class UserAnswerValidationError(UserAnswerError):
  pass


class UserAnswerAsset(BaseModel):
  id: str
  filename: str
  content_type: str
  kind: str
  order: int
  byte_size: int = 0


class UserQuestionAnswer(BaseModel):
  id: str
  attempt_number: int = 1
  course_id: str
  source_document_id: str
  question_id: str
  source_type: str
  assets: list[UserAnswerAsset] = Field(default_factory=list)
  created_at: str
  updated_at: str
  grading: dict | None = None


class UserQuestionAnswerRecord(BaseModel):
  schema_version: int = 1
  current_attempt_id: str | None = None
  attempts: list[UserQuestionAnswer] = Field(default_factory=list)


class AnswerUpload(Protocol):
  filename: str | None
  content_type: str | None
  file: BinaryIO


class QuestionIdentityResolver(Protocol):
  def source_type(self, course_id: str, source_document_id: str, question_id: str) -> str: ...


class KnowledgeLibraryQuestionResolver:
  def source_type(self, course_id: str, source_document_id: str, question_id: str) -> str:
    library = read_knowledge_library()
    course = next(
      (
        item for item in library.get('courses') or []
        if isinstance(item, dict) and str(item.get('id') or '') == course_id
      ),
      None,
    )
    if course is None:
      raise UserAnswerNotFound('Course not found.')
    for folder in course.get('homeworkFolders') or []:
      if not isinstance(folder, dict):
        continue
      folder_type = str(folder.get('folderType') or '')
      if folder_type not in {'homework', 'past-exam'}:
        continue
      for document in folder.get('homeworkDocuments') or []:
        if not isinstance(document, dict) or str(document.get('id') or '') != source_document_id:
          continue
        if any(
          isinstance(question, dict) and str(question.get('id') or '') == question_id
          for question in document.get('questions') or []
        ):
          return folder_type
        raise UserAnswerNotFound('Question not found in source document.')
    raise UserAnswerNotFound('Source document not found in course.')


def _now() -> str:
  return datetime.now(timezone.utc).isoformat()


def _normalized(value: str, label: str) -> str:
  result = str(value or '').strip()
  if not result:
    raise UserAnswerValidationError(f'{label} is required.')
  return result


def _asset_format(filename: str, content_type: str, header: bytes) -> tuple[str, str, str]:
  suffix = Path(filename).suffix.lower()
  normalized_type = content_type.split(';', 1)[0].strip().lower()
  if header.startswith(b'%PDF-') and (suffix == '.pdf' or normalized_type == 'application/pdf'):
    return 'pdf', 'application/pdf', '.pdf'
  if header.startswith(b'\x89PNG\r\n\x1a\n') and suffix in {'', '.png'}:
    return 'image', 'image/png', '.png'
  if header.startswith(b'\xff\xd8\xff') and suffix in {'', '.jpg', '.jpeg'}:
    return 'image', 'image/jpeg', '.jpg'
  if len(header) >= 12 and header[:4] == b'RIFF' and header[8:12] == b'WEBP' and suffix in {'', '.webp'}:
    return 'image', 'image/webp', '.webp'
  raise UserAnswerValidationError('Only PDF, PNG, JPG, JPEG, and WEBP answers are supported.')


class UserAnswerStore:
  """Durable Question -> user-answer repository with attempt-ready metadata."""

  def __init__(
    self,
    root: Path = USER_ANSWERS_ROOT,
    resolver: QuestionIdentityResolver | None = None,
  ) -> None:
    self.root = root
    self.resolver = resolver or KnowledgeLibraryQuestionResolver()
    self._lock = RLock()

  def _question_dir(self, course_id: str, question_id: str) -> Path:
    return self.root / safe_storage_name(course_id) / safe_storage_name(question_id)

  def _record_path(self, course_id: str, question_id: str) -> Path:
    return self._question_dir(course_id, question_id) / 'record.json'

  def _read_record(self, course_id: str, question_id: str) -> UserQuestionAnswerRecord:
    payload = read_json_file(self._record_path(course_id, question_id), {})
    try:
      return UserQuestionAnswerRecord.model_validate(payload)
    except Exception:
      return UserQuestionAnswerRecord()

  @staticmethod
  def _current(record: UserQuestionAnswerRecord) -> UserQuestionAnswer | None:
    return next(
      (item for item in reversed(record.attempts) if item.id == record.current_attempt_id),
      None,
    )

  def get(self, course_id: str, source_document_id: str, question_id: str) -> UserQuestionAnswer | None:
    course_id = _normalized(course_id, 'course_id')
    source_document_id = _normalized(source_document_id, 'source_document_id')
    question_id = _normalized(question_id, 'question_id')
    with self._lock:
      answer = self._current(self._read_record(course_id, question_id))
      if answer is None:
        return None
      if answer.course_id != course_id or answer.source_document_id != source_document_id:
        return None
      return answer

  def replace(
    self,
    course_id: str,
    source_document_id: str,
    question_id: str,
    requested_source_type: str,
    uploads: list[AnswerUpload],
  ) -> UserQuestionAnswer:
    course_id = _normalized(course_id, 'course_id')
    source_document_id = _normalized(source_document_id, 'source_document_id')
    question_id = _normalized(question_id, 'question_id')
    actual_source_type = self.resolver.source_type(course_id, source_document_id, question_id)
    if actual_source_type != requested_source_type or actual_source_type not in {'homework', 'past-exam'}:
      raise UserAnswerValidationError('source_type does not match the question source.')
    if not uploads or len(uploads) > MAX_ASSETS_PER_ANSWER:
      raise UserAnswerValidationError(f'Upload between 1 and {MAX_ASSETS_PER_ANSWER} answer files.')

    with self._lock:
      record = self._read_record(course_id, question_id)
      answer_id = uuid.uuid4().hex
      question_dir = self._question_dir(course_id, question_id)
      attempt_dir = question_dir / 'attempts' / answer_id
      staging_dir = question_dir / f'.staging-{answer_id}'
      assets_dir = staging_dir / 'assets'
      assets: list[UserAnswerAsset] = []
      total_bytes = 0
      try:
        assets_dir.mkdir(parents=True, exist_ok=False)
        for order, upload in enumerate(uploads):
          filename = Path(str(upload.filename or f'answer-{order + 1}')).name
          upload.file.seek(0)
          header = upload.file.read(16)
          kind, content_type, suffix = _asset_format(filename, str(upload.content_type or ''), header)
          upload.file.seek(0)
          asset_id = uuid.uuid4().hex
          target = assets_dir / f'{order:03d}-{asset_id}{suffix}'
          asset_bytes = 0
          with target.open('wb') as output:
            while True:
              chunk = upload.file.read(1024 * 1024)
              if not chunk:
                break
              asset_bytes += len(chunk)
              total_bytes += len(chunk)
              if asset_bytes > MAX_ASSET_BYTES or total_bytes > MAX_ANSWER_BYTES:
                raise UserAnswerValidationError('Uploaded answer exceeds the size limit.')
              output.write(chunk)
          assets.append(UserAnswerAsset(
            id=asset_id,
            filename=filename,
            content_type=content_type,
            kind=kind,
            order=order,
            byte_size=asset_bytes,
          ))
        attempt_dir.parent.mkdir(parents=True, exist_ok=True)
        staging_dir.replace(attempt_dir)
        timestamp = _now()
        answer = UserQuestionAnswer(
          id=answer_id,
          attempt_number=len(record.attempts) + 1,
          course_id=course_id,
          source_document_id=source_document_id,
          question_id=question_id,
          source_type=actual_source_type,
          assets=assets,
          created_at=timestamp,
          updated_at=timestamp,
        )
        record.attempts.append(answer)
        record.current_attempt_id = answer.id
        write_json_atomic(self._record_path(course_id, question_id), record.model_dump())
        return answer
      except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        if attempt_dir.is_dir() and not any(item.id == answer_id for item in record.attempts):
          shutil.rmtree(attempt_dir, ignore_errors=True)
        raise

  def asset(self, course_id: str, source_document_id: str, question_id: str, asset_id: str) -> tuple[Path, UserAnswerAsset]:
    answer = self.get(course_id, source_document_id, question_id)
    if answer is None:
      raise UserAnswerNotFound('User answer not found.')
    asset = next((item for item in answer.assets if item.id == asset_id), None)
    if asset is None:
      raise UserAnswerNotFound('Answer asset not found.')
    assets_dir = self._question_dir(course_id, question_id) / 'attempts' / answer.id / 'assets'
    matches = list(assets_dir.glob(f'{asset.order:03d}-{safe_storage_name(asset.id)}.*'))
    if len(matches) != 1 or not matches[0].is_file():
      raise UserAnswerNotFound('Answer asset file not found.')
    return matches[0], asset

  def delete(self, course_id: str, source_document_id: str, question_id: str) -> bool:
    answer = self.get(course_id, source_document_id, question_id)
    if answer is None:
      return False
    with self._lock:
      shutil.rmtree(self._question_dir(course_id, question_id), ignore_errors=True)
    return True

  def delete_document(self, course_id: str, source_document_id: str) -> int:
    course_dir = self.root / safe_storage_name(course_id)
    removed = 0
    with self._lock:
      for question_dir in list(course_dir.iterdir()) if course_dir.is_dir() else []:
        record = self._read_record(course_id, question_dir.name)
        if any(item.source_document_id == source_document_id for item in record.attempts):
          shutil.rmtree(question_dir, ignore_errors=True)
          removed += 1
    return removed

  def delete_course(self, course_id: str) -> bool:
    course_dir = self.root / safe_storage_name(course_id)
    existed = course_dir.is_dir()
    with self._lock:
      shutil.rmtree(course_dir, ignore_errors=True)
    return existed
