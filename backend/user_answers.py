from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import BinaryIO, Literal, Protocol

from pydantic import BaseModel, Field

from .config import PROJECT_ROOT
from .document_pipeline import safe_storage_name, write_json_atomic
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


class UserAnswerCorruptionError(UserAnswerError):
  """Raised when durable answer metadata exists but cannot be trusted."""


class UserAnswerAttemptSummary(BaseModel):
  id: str
  attempt_number: int
  created_at: str
  updated_at: str
  processing_status: str
  score: float | None = None
  correct: bool | None = None
  needs_review: bool = False
  asset_count: int = 0
  grading_model: str = ''


class UserAnswerAsset(BaseModel):
  id: str
  filename: str
  content_type: str
  kind: str
  order: int
  byte_size: int = 0


class AnswerUnderstanding(BaseModel):
  transcription: str = ''
  steps: list[str] = Field(default_factory=list)
  final_answer: str = ''
  uncertain_parts: list[str] = Field(default_factory=list)
  confidence: float = Field(default=0.0, ge=0.0, le=1.0)


ErrorType = Literal[
  'conceptual_error', 'formula_error', 'calculation_error', 'reasoning_error',
  'missing_step', 'incomplete_answer', 'misread_question', 'unit_error',
  'notation_error', 'no_error', 'uncertain',
]


class ErrorAnalysis(BaseModel):
  type: ErrorType
  location: str = ''
  student_reasoning: str = ''
  problem: str = ''
  correction: str = ''
  severity: Literal['low', 'medium', 'high'] = 'medium'


class KnowledgePointEvidence(BaseModel):
  name: str
  status: Literal['strong', 'partial', 'weak', 'unknown']
  evidence: str = ''


class UserAnswerGrading(BaseModel):
  score: float = Field(ge=0.0, le=1.0)
  correct: bool
  confidence: float = Field(ge=0.0, le=1.0)
  needs_review: bool = False
  summary: str = ''
  feedback: str = ''
  error_types: list[ErrorType] = Field(default_factory=list)
  errors: list[ErrorAnalysis] = Field(default_factory=list)
  knowledge_points: list[KnowledgePointEvidence] = Field(default_factory=list)
  correct_parts: list[str] = Field(default_factory=list)
  improvement_suggestions: list[str] = Field(default_factory=list)
  is_wrong: bool = False


class UserAnswerGradingRevision(BaseModel):
  revision: int
  understanding: AnswerUnderstanding
  grading: UserAnswerGrading
  model: str
  version: str
  graded_at: str


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
  processing_status: Literal['pending', 'processing', 'completed', 'failed', 'needs_review'] = 'pending'
  grading: UserAnswerGrading | None = None
  understanding: AnswerUnderstanding | None = None
  grading_model: str = ''
  grading_version: str = ''
  graded_at: str = ''
  grading_error: str = ''
  grading_revisions: list[UserAnswerGradingRevision] = Field(default_factory=list)


# Compatibility name retained for the first-stage frontend/API contract.
UserAnswerAttempt = UserQuestionAnswer


class UserQuestionAnswerRecord(BaseModel):
  schema_version: int = 2
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
    path = self._record_path(course_id, question_id)
    if not path.is_file():
      return UserQuestionAnswerRecord()
    try:
      payload = json.loads(path.read_text(encoding='utf-8'))
      return UserQuestionAnswerRecord.model_validate(payload)
    except Exception as exc:
      raise UserAnswerCorruptionError(
        f'User answer metadata is damaged ({path.name}). Restore record.json.bak before retrying.',
      ) from exc

  @staticmethod
  def _backup_path(path: Path) -> Path:
    return path.with_name(f'{path.name}.bak')

  def _write_record(self, course_id: str, question_id: str, record: UserQuestionAnswerRecord) -> None:
    path = self._record_path(course_id, question_id)
    if path.is_file():
      try:
        existing = json.loads(path.read_text(encoding='utf-8'))
        UserQuestionAnswerRecord.model_validate(existing)
      except Exception as exc:
        raise UserAnswerCorruptionError(
          f'User answer metadata is damaged ({path.name}). Restore record.json.bak before retrying.',
        ) from exc
      write_json_atomic(self._backup_path(path), existing)
    write_json_atomic(path, record.model_dump())

  @staticmethod
  def _summary(attempt: UserQuestionAnswer) -> UserAnswerAttemptSummary:
    grading = attempt.grading
    return UserAnswerAttemptSummary(
      id=attempt.id,
      attempt_number=attempt.attempt_number,
      created_at=attempt.created_at,
      updated_at=attempt.updated_at,
      processing_status=attempt.processing_status,
      score=grading.score if grading else None,
      correct=grading.correct if grading else None,
      needs_review=grading.needs_review if grading else attempt.processing_status == 'needs_review',
      asset_count=len(attempt.assets),
      grading_model=attempt.grading_model,
    )

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

  def list_attempts(
    self,
    course_id: str,
    source_document_id: str,
    question_id: str,
  ) -> list[UserQuestionAnswer]:
    course_id = _normalized(course_id, 'course_id')
    source_document_id = _normalized(source_document_id, 'source_document_id')
    question_id = _normalized(question_id, 'question_id')
    with self._lock:
      return [
        item for item in reversed(self._read_record(course_id, question_id).attempts)
        if item.course_id == course_id and item.source_document_id == source_document_id
      ]

  def list_attempt_summaries(
    self,
    course_id: str,
    source_document_id: str,
    question_id: str,
  ) -> list[UserAnswerAttemptSummary]:
    return [
      self._summary(attempt)
      for attempt in self.list_attempts(course_id, source_document_id, question_id)
    ]

  def get_attempt(
    self,
    course_id: str,
    source_document_id: str,
    question_id: str,
    attempt_id: str,
  ) -> UserQuestionAnswer | None:
    return next(
      (
        item for item in self.list_attempts(course_id, source_document_id, question_id)
        if item.id == attempt_id
      ),
      None,
    )

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
      metadata_committed = False
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
        self._write_record(course_id, question_id, record)
        metadata_committed = True
        return answer
      except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        if attempt_dir.is_dir() and not metadata_committed:
          shutil.rmtree(attempt_dir, ignore_errors=True)
        raise

  def asset(
    self,
    course_id: str,
    source_document_id: str,
    question_id: str,
    asset_id: str,
    attempt_id: str | None = None,
  ) -> tuple[Path, UserAnswerAsset]:
    answer = (
      self.get_attempt(course_id, source_document_id, question_id, attempt_id)
      if attempt_id else self.get(course_id, source_document_id, question_id)
    )
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

  def mark_processing(self, course_id: str, question_id: str, attempt_id: str) -> bool:
    with self._lock:
      record = self._read_record(course_id, question_id)
      attempt = next((item for item in record.attempts if item.id == attempt_id), None)
      if attempt is None or attempt.processing_status == 'processing':
        return False
      attempt.processing_status = 'processing'
      attempt.grading_error = ''
      attempt.updated_at = _now()
      self._write_record(course_id, question_id, record)
      return True

  def attempt_exists(self, course_id: str, question_id: str, attempt_id: str) -> bool:
    with self._lock:
      record = self._read_record(course_id, question_id)
      return any(item.id == attempt_id for item in record.attempts)

  def save_grading(
    self,
    course_id: str,
    question_id: str,
    attempt_id: str,
    *,
    understanding: AnswerUnderstanding,
    grading: UserAnswerGrading,
    model: str,
    version: str,
  ) -> UserQuestionAnswer:
    with self._lock:
      record = self._read_record(course_id, question_id)
      attempt = next((item for item in record.attempts if item.id == attempt_id), None)
      if attempt is None:
        raise UserAnswerNotFound('User answer attempt not found.')
      timestamp = _now()
      revision = UserAnswerGradingRevision(
        revision=len(attempt.grading_revisions) + 1,
        understanding=understanding,
        grading=grading,
        model=model,
        version=version,
        graded_at=timestamp,
      )
      attempt.grading_revisions.append(revision)
      attempt.understanding = understanding
      attempt.grading = grading
      attempt.grading_model = model
      attempt.grading_version = version
      attempt.graded_at = timestamp
      attempt.grading_error = ''
      attempt.processing_status = 'needs_review' if grading.needs_review else 'completed'
      attempt.updated_at = timestamp
      self._write_record(course_id, question_id, record)
      return attempt

  def mark_failed(self, course_id: str, question_id: str, attempt_id: str, error: str) -> None:
    with self._lock:
      record = self._read_record(course_id, question_id)
      attempt = next((item for item in record.attempts if item.id == attempt_id), None)
      if attempt is None:
        return
      attempt.processing_status = 'failed'
      attempt.grading_error = str(error or 'Answer grading failed.')[:1000]
      attempt.updated_at = _now()
      self._write_record(course_id, question_id, record)

  def pending_attempts(self) -> list[UserQuestionAnswer]:
    attempts: list[UserQuestionAnswer] = []
    with self._lock:
      for course_dir in self.root.iterdir() if self.root.is_dir() else []:
        for question_dir in course_dir.iterdir() if course_dir.is_dir() else []:
          record = self._read_record(course_dir.name, question_dir.name)
          for attempt in record.attempts:
            if attempt.processing_status in {'pending', 'processing'}:
              if attempt.processing_status == 'processing':
                attempt.processing_status = 'pending'
                attempt.grading_error = 'Interrupted by backend restart; queued again.'
                self._write_record(course_dir.name, question_dir.name, record)
              attempts.append(attempt)
    return attempts

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
