from __future__ import annotations

import json
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from backend.config import PROJECT_ROOT

KNOWLEDGE_BASE_DIR = PROJECT_ROOT / ".runtime" / "knowledge-base"
KNOWLEDGE_LIBRARY_PATH = KNOWLEDGE_BASE_DIR / "library.json"
KNOWLEDGE_DELETED_FILES_PATH = KNOWLEDGE_BASE_DIR / "deleted-file-markers.json"
KNOWLEDGE_PDF_DIR = KNOWLEDGE_BASE_DIR / "pdf-files"
KNOWLEDGE_ANNOTATION_DIR = KNOWLEDGE_BASE_DIR / "annotation-assets"
KNOWLEDGE_HOMEWORK_DIR = KNOWLEDGE_BASE_DIR / "homework-assets"

_storage_lock = threading.RLock()


def ensure_knowledge_storage_dirs() -> None:
  KNOWLEDGE_PDF_DIR.mkdir(parents=True, exist_ok=True)
  KNOWLEDGE_ANNOTATION_DIR.mkdir(parents=True, exist_ok=True)
  KNOWLEDGE_HOMEWORK_DIR.mkdir(parents=True, exist_ok=True)


def _library_payload_default() -> dict[str, Any]:
  return {
    "files": [],
    "courses": [],
  }


def _read_deleted_file_markers_unlocked() -> dict[str, set[str]]:
  if not KNOWLEDGE_DELETED_FILES_PATH.is_file():
    return {'ids': set(), 'source_keys': set()}
  try:
    payload = json.loads(KNOWLEDGE_DELETED_FILES_PATH.read_text(encoding='utf-8'))
  except Exception:
    return {'ids': set(), 'source_keys': set()}
  return {
    'ids': {str(value).strip() for value in payload.get('ids') or [] if str(value).strip()}
      if isinstance(payload, dict) else set(),
    'source_keys': {str(value).strip() for value in payload.get('sourceKeys') or [] if str(value).strip()}
      if isinstance(payload, dict) else set(),
  }


def _write_deleted_file_markers_unlocked(markers: dict[str, set[str]]) -> None:
  KNOWLEDGE_DELETED_FILES_PATH.write_text(
    json.dumps({
      'ids': sorted(markers['ids']),
      'sourceKeys': sorted(markers['source_keys']),
    }, ensure_ascii=False, indent=2),
    encoding='utf-8',
  )


def _filter_deleted_library_files(
  files: list[Any],
  markers: dict[str, set[str]],
) -> list[Any]:
  return [
    item for item in files
    if not isinstance(item, dict)
    or (
      str(item.get('id') or '').strip() not in markers['ids']
      and str(item.get('sourceKey') or '').strip() not in markers['source_keys']
    )
  ]


def mark_knowledge_file_deleted(file_id: str, file_record: dict[str, Any] | None = None) -> None:
  """Prevent stale browser snapshots from restoring a deleted lecture."""
  normalized_id = str(file_id or '').strip()
  source_key = str((file_record or {}).get('sourceKey') or '').strip()
  if not normalized_id and not source_key:
    return
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    markers = _read_deleted_file_markers_unlocked()
    if normalized_id:
      markers['ids'].add(normalized_id)
    # Source-key suppression is reserved for automatically fetched courseware.
    # A user must still be able to deliberately upload the same manual PDF again.
    if source_key.startswith('tsinghua-courseware:'):
      markers['source_keys'].add(source_key)
    _write_deleted_file_markers_unlocked(markers)


def is_knowledge_file_deleted(file_id: str) -> bool:
  normalized_id = str(file_id or '').strip()
  if not normalized_id:
    return False
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    return normalized_id in _read_deleted_file_markers_unlocked()['ids']


def restore_knowledge_file_source_keys(source_keys: list[str] | set[str]) -> None:
  """Allow an explicit user download to restore selected synced courseware."""
  normalized = {str(value or '').strip() for value in source_keys if str(value or '').strip()}
  if not normalized:
    return
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    markers = _read_deleted_file_markers_unlocked()
    if not markers['source_keys'].intersection(normalized):
      return
    markers['source_keys'].difference_update(normalized)
    _write_deleted_file_markers_unlocked(markers)


def read_knowledge_library(include_deleted: bool = False) -> dict[str, Any]:
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    if not KNOWLEDGE_LIBRARY_PATH.is_file():
      return _library_payload_default()

    try:
      payload = json.loads(KNOWLEDGE_LIBRARY_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
      raise HTTPException(status_code=500, detail=f"Failed to read knowledge library: {exc}") from exc

  if not isinstance(payload, dict):
    return _library_payload_default()

  files = payload.get("files")
  courses = payload.get("courses")
  normalized_files = files if isinstance(files, list) else []
  if not include_deleted:
    with _storage_lock:
      normalized_files = _filter_deleted_library_files(
        normalized_files,
        _read_deleted_file_markers_unlocked(),
      )
  return {
    "files": normalized_files,
    "courses": courses if isinstance(courses, list) else [],
  }


def write_knowledge_library(payload: dict[str, Any]) -> dict[str, Any]:
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    normalized = {
      "files": _filter_deleted_library_files(
        payload.get("files") if isinstance(payload.get("files"), list) else [],
        _read_deleted_file_markers_unlocked(),
      ),
      "courses": payload.get("courses") if isinstance(payload.get("courses"), list) else [],
    }
    KNOWLEDGE_LIBRARY_PATH.write_text(
      json.dumps(normalized, ensure_ascii=False, indent=2),
      encoding="utf-8",
    )
  return normalized


def update_knowledge_course_settings(course_id: str, payload: dict[str, Any]) -> dict[str, Any]:
  """Update a display label and its optional unique Tsinghua course binding."""
  normalized_course_id = str(course_id or '').strip()
  display_name = str(payload.get('displayName') or '').strip()
  association = payload.get('association')
  if not normalized_course_id:
    raise HTTPException(status_code=422, detail='course_id is required.')
  if not display_name:
    raise HTTPException(status_code=422, detail='课程显示名称不能为空。')
  if association is not None and not isinstance(association, dict):
    raise HTTPException(status_code=422, detail='课程关联格式不正确。')

  ensure_knowledge_storage_dirs()
  with _storage_lock:
    library = read_knowledge_library(include_deleted=True)
    courses = [item for item in library['courses'] if isinstance(item, dict)]
    current = next((item for item in courses if str(item.get('id') or '') == normalized_course_id), None)
    if current is None:
      raise HTTPException(status_code=404, detail='未找到要编辑的课程。')

    updated = dict(current)
    updated['displayName'] = display_name
    updated['updatedAt'] = datetime.now(tz=timezone.utc).isoformat()
    if association is None:
      updated.update({
        'source': 'manual',
        'semesterId': None,
        'semesterName': None,
        'courseCode': None,
        'wlkcid': None,
      })
    else:
      course_name = str(association.get('name') or '').strip()
      semester_id = str(association.get('semesterId') or '').strip()
      semester_name = str(association.get('semesterName') or '').strip()
      course_code = str(association.get('courseCode') or '').strip()
      wlkcid = str(association.get('wlkcid') or '').strip()
      if not course_name or not semester_id or not wlkcid:
        raise HTTPException(status_code=422, detail='请选择完整的学期和网络学堂课程。')
      owner = next(
        (
          item for item in courses
          if str(item.get('id') or '') != normalized_course_id
          and str(item.get('semesterId') or '').strip() == semester_id
          and str(item.get('wlkcid') or '').strip() == wlkcid
        ),
        None,
      )
      if owner is not None:
        owner_name = str(owner.get('displayName') or owner.get('name') or '另一门课程').strip()
        raise HTTPException(
          status_code=409,
          detail=f'网络学堂课程“{course_name}”已关联到“{owner_name}”，不能重复绑定。',
        )
      updated.update({
        # Keep the network name for deterministic courseware lookup while the
        # displayName remains entirely user-controlled.
        'name': course_name,
        'source': 'tsinghua-sync',
        'semesterId': semester_id,
        'semesterName': semester_name or semester_id,
        'courseCode': course_code or None,
        'wlkcid': wlkcid,
      })

    next_courses = [updated if str(item.get('id') or '') == normalized_course_id else item for item in courses]
    written = write_knowledge_library({'files': library['files'], 'courses': next_courses})
    saved_course = next(
      item for item in written['courses']
      if isinstance(item, dict) and str(item.get('id') or '') == normalized_course_id
    )
    return {'course': saved_course, 'library': written}


def sync_knowledge_homework_pipeline_result(
  document_id: str,
  result: dict[str, Any],
) -> dict[str, Any]:
  """Synchronize a question-pipeline result into its course-library card."""
  document_id = str(document_id or '').strip()
  if not document_id:
    raise HTTPException(status_code=422, detail='document_id is required.')

  pipeline_status = str(result.get('status') or '')
  if pipeline_status == 'completed':
    card_status = 'ready'
  elif pipeline_status.endswith('_failed'):
    card_status = 'error'
  else:
    card_status = 'processing'

  questions = [
    {
      'id': str(question.get('question_id') or ''),
      'homeworkDocumentId': document_id,
      'index': max(1, int(question.get('index') or index)),
      'title': str(question.get('title') or f'Question {index}'),
      'content': str(question.get('content') or ''),
      'pageNumber': max(1, int(question.get('page_number') or 1)),
      'anchorText': str(question.get('anchor_text') or '') or None,
      'analysis': question.get('analysis') if isinstance(question.get('analysis'), dict) else None,
    }
    for index, question in enumerate(result.get('questions') or [], start=1)
    if isinstance(question, dict)
  ]
  updated_timestamp = float(result.get('updated_at') or 0)
  updated_at = (
    datetime.fromtimestamp(updated_timestamp, tz=timezone.utc).isoformat()
    if updated_timestamp > 0
    else datetime.now(tz=timezone.utc).isoformat()
  )

  def update_document(document: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    if str(document.get('id') or '') != document_id:
      return document, False
    updated = dict(document)
    updated.update({
      'pageCount': max(1, int(result.get('page_count') or document.get('pageCount') or 1)),
      'status': card_status,
      'pipelineStatus': pipeline_status or None,
      'parserStatus': str(result.get('parser_status') or '') or None,
      'extractionStatus': str(result.get('extraction_status') or '') or None,
      'analysisStatus': str(result.get('analysis_status') or '') or None,
      'embeddingStatus': str(result.get('embedding_status') or '') or None,
      'vectorStatus': str(result.get('vector_status') or '') or None,
      'embeddingCompletedQuestions': max(0, int(result.get('embedding_completed_questions') or 0)),
      'vectorCompletedQuestions': max(0, int(result.get('vector_completed_questions') or 0)),
      'extractor': 'mineru',
      'extractedMarkdown': str(result.get('markdown') or ''),
      'layoutBlocks': result.get('layout_blocks') if isinstance(result.get('layout_blocks'), list) else [],
      'questions': questions,
      'errorMessage': str(result.get('error') or '') or None,
      'updatedAt': updated_at,
    })
    return updated, True

  ensure_knowledge_storage_dirs()
  with _storage_lock:
    library = read_knowledge_library(include_deleted=True)
    found = False
    next_courses: list[dict[str, Any]] = []
    for course in library['courses']:
      if not isinstance(course, dict):
        continue
      next_course = dict(course)
      next_folders: list[dict[str, Any]] = []
      for folder in course.get('homeworkFolders') or []:
        if not isinstance(folder, dict):
          continue
        next_folder = dict(folder)
        next_documents = []
        for document in folder.get('homeworkDocuments') or []:
          if not isinstance(document, dict):
            continue
          next_document, matched = update_document(document)
          found = found or matched
          next_documents.append(next_document)
        next_folder['homeworkDocuments'] = next_documents
        next_folders.append(next_folder)
      next_course['homeworkFolders'] = next_folders
      next_courses.append(next_course)

    next_files: list[dict[str, Any]] = []
    for lecture in library['files']:
      if not isinstance(lecture, dict):
        continue
      next_lecture = dict(lecture)
      if 'homeworkDocuments' in lecture:
        next_documents = []
        for document in lecture.get('homeworkDocuments') or []:
          if not isinstance(document, dict):
            continue
          next_document, matched = update_document(document)
          found = found or matched
          next_documents.append(next_document)
        next_lecture['homeworkDocuments'] = next_documents
      next_files.append(next_lecture)

    next_library = {'files': next_files, 'courses': next_courses}
    if found:
      write_knowledge_library(next_library)
    return {
      'found': found,
      'documentId': document_id,
      'status': card_status,
      'questionCount': len(questions),
      'library': next_library,
    }


def _asset_path(root: Path, asset_id: str, suffix: str) -> Path:
  safe_asset_id = "".join(character for character in str(asset_id).strip() if character.isalnum() or character in {"-", "_"})
  if not safe_asset_id:
    raise HTTPException(status_code=422, detail="Invalid asset id.")
  return root / f"{safe_asset_id}{suffix}"


def read_pdf_bytes(file_id: str) -> bytes:
  path = _asset_path(KNOWLEDGE_PDF_DIR, file_id, ".pdf")
  if not path.is_file():
    raise HTTPException(status_code=404, detail="Knowledge PDF source not found.")
  return path.read_bytes()


def write_pdf_bytes(file_id: str, payload: bytes) -> None:
  ensure_knowledge_storage_dirs()
  path = _asset_path(KNOWLEDGE_PDF_DIR, file_id, ".pdf")
  path.write_bytes(payload)


def delete_pdf_bytes(file_id: str) -> None:
  path = _asset_path(KNOWLEDGE_PDF_DIR, file_id, ".pdf")
  try:
    path.unlink(missing_ok=True)
  except TypeError:
    if path.exists():
      path.unlink()


def read_annotation_asset(asset_id: str) -> str:
  path = _asset_path(KNOWLEDGE_ANNOTATION_DIR, asset_id, ".txt")
  if not path.is_file():
    raise HTTPException(status_code=404, detail="Knowledge annotation asset not found.")
  return path.read_text(encoding="utf-8")


def write_annotation_asset(asset_id: str, data_url: str) -> None:
  ensure_knowledge_storage_dirs()
  path = _asset_path(KNOWLEDGE_ANNOTATION_DIR, asset_id, ".txt")
  path.write_text(data_url, encoding="utf-8")


def delete_annotation_asset(asset_id: str) -> None:
  path = _asset_path(KNOWLEDGE_ANNOTATION_DIR, asset_id, ".txt")
  try:
    path.unlink(missing_ok=True)
  except TypeError:
    if path.exists():
      path.unlink()


def _homework_meta_path(asset_id: str) -> Path:
  return _asset_path(KNOWLEDGE_HOMEWORK_DIR, asset_id, ".json")


def _homework_binary_path(asset_id: str) -> Path:
  return _asset_path(KNOWLEDGE_HOMEWORK_DIR, asset_id, ".bin")


def write_homework_text_asset(asset_id: str, text: str) -> None:
  ensure_knowledge_storage_dirs()
  _homework_meta_path(asset_id).write_text(
    json.dumps({"kind": "text", "text": text}, ensure_ascii=False, indent=2),
    encoding="utf-8",
  )
  try:
    _homework_binary_path(asset_id).unlink(missing_ok=True)
  except TypeError:
    if _homework_binary_path(asset_id).exists():
      _homework_binary_path(asset_id).unlink()


def write_homework_binary_asset(asset_id: str, payload: bytes, content_type: str) -> None:
  ensure_knowledge_storage_dirs()
  _homework_binary_path(asset_id).write_bytes(payload)
  _homework_meta_path(asset_id).write_text(
    json.dumps(
      {
        "kind": "binary",
        "contentType": content_type.strip() or "application/octet-stream",
      },
      ensure_ascii=False,
      indent=2,
    ),
    encoding="utf-8",
  )


def read_homework_asset(asset_id: str) -> dict[str, Any]:
  meta_path = _homework_meta_path(asset_id)
  if not meta_path.is_file():
    raise HTTPException(status_code=404, detail="Knowledge homework asset not found.")

  try:
    payload = json.loads(meta_path.read_text(encoding="utf-8"))
  except Exception as exc:  # noqa: BLE001
    raise HTTPException(status_code=500, detail=f"Failed to read homework asset metadata: {exc}") from exc

  if not isinstance(payload, dict):
    raise HTTPException(status_code=500, detail="Knowledge homework asset metadata is invalid.")

  kind = str(payload.get("kind") or "").strip().lower()
  if kind == "text":
    return {
      "kind": "text",
      "text": str(payload.get("text") or ""),
    }
  if kind != "binary":
    raise HTTPException(status_code=500, detail="Knowledge homework asset metadata is invalid.")

  binary_path = _homework_binary_path(asset_id)
  if not binary_path.is_file():
    raise HTTPException(status_code=404, detail="Knowledge homework asset payload not found.")

  return {
    "kind": "binary",
    "contentType": str(payload.get("contentType") or "application/octet-stream"),
    "bytes": binary_path.read_bytes(),
  }


def delete_homework_asset(asset_id: str) -> None:
  meta_path = _homework_meta_path(asset_id)
  binary_path = _homework_binary_path(asset_id)
  try:
    meta_path.unlink(missing_ok=True)
  except TypeError:
    if meta_path.exists():
      meta_path.unlink()
  try:
    binary_path.unlink(missing_ok=True)
  except TypeError:
    if binary_path.exists():
      binary_path.unlink()


def _asset_ids_from_documents(documents: list[dict[str, Any]]) -> tuple[set[str], set[str]]:
  homework_asset_ids: set[str] = set()
  annotation_asset_ids: set[str] = set()
  for document in documents:
    asset_id = str(document.get('assetId') or '').strip()
    if asset_id:
      homework_asset_ids.add(asset_id)
    for annotation in document.get('annotations') or []:
      if not isinstance(annotation, dict):
        continue
      image_asset_id = str(annotation.get('imageAssetId') or '').strip()
      if image_asset_id:
        annotation_asset_ids.add(image_asset_id)
  return homework_asset_ids, annotation_asset_ids


def _delete_assets(pdf_file_ids: set[str], homework_asset_ids: set[str], annotation_asset_ids: set[str]) -> None:
  for pdf_file_id in pdf_file_ids:
    delete_pdf_bytes(pdf_file_id)
  for homework_asset_id in homework_asset_ids:
    delete_homework_asset(homework_asset_id)
  for annotation_asset_id in annotation_asset_ids:
    delete_annotation_asset(annotation_asset_id)


def delete_knowledge_lecture(
  file_id: str,
  delete_pipeline_document: Callable[[str], None],
  delete_question_document: Callable[[str], None] | None = None,
) -> dict[str, Any]:
  """Delete one lecture and every resource explicitly attached to it."""
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    library = read_knowledge_library(include_deleted=True)
    files = [item for item in library['files'] if isinstance(item, dict)]
    lecture = next((item for item in files if str(item.get('id') or '') == file_id), None)
    if lecture is None:
      return {'deleted': False, 'library': library, 'removedHomeworkDocuments': 0}

    course_id = str(lecture.get('courseId') or '')
    course_lecture_count = sum(
      1 for item in files if str(item.get('courseId') or '') == course_id
    )
    lecture_documents = [item for item in lecture.get('homeworkDocuments') or [] if isinstance(item, dict)]
    related_documents = list(lecture_documents)
    next_courses: list[dict[str, Any]] = []

    for course in library['courses']:
      if not isinstance(course, dict):
        continue
      if str(course.get('id') or '') != course_id:
        next_courses.append(course)
        continue

      next_course = dict(course)
      next_folders: list[dict[str, Any]] = []
      for folder in course.get('homeworkFolders') or []:
        if not isinstance(folder, dict):
          continue
        kept_documents: list[dict[str, Any]] = []
        for document in folder.get('homeworkDocuments') or []:
          if not isinstance(document, dict):
            continue
          linked_lecture_id = str(document.get('lectureDocumentId') or '')
          linked_in_question_map = any(
            isinstance(link, dict) and str(link.get('lectureDocumentId') or '') == file_id
            for link in document.get('knowledgeLinks') or []
          )
          legacy_single_lecture_document = (
            course_lecture_count == 1
            and not linked_lecture_id
            and not any(
              isinstance(link, dict) and str(link.get('lectureDocumentId') or '')
              for link in document.get('knowledgeLinks') or []
            )
          )
          if linked_lecture_id == file_id or linked_in_question_map or legacy_single_lecture_document:
            related_documents.append(document)
          else:
            kept_documents.append(document)
        next_folder = dict(folder)
        next_folder['homeworkDocuments'] = kept_documents
        next_folders.append(next_folder)
      next_course['homeworkFolders'] = next_folders
      next_courses.append(next_course)

    homework_asset_ids, annotation_asset_ids = _asset_ids_from_documents(related_documents)
    for annotation in lecture.get('annotations') or []:
      if isinstance(annotation, dict):
        image_asset_id = str(annotation.get('imageAssetId') or '').strip()
        if image_asset_id:
          annotation_asset_ids.add(image_asset_id)

    # Keep the library record intact until every external artifact is gone.
    delete_pipeline_document(file_id)
    if delete_question_document is not None:
      for document in related_documents:
        delete_question_document(str(document.get('id') or ''))
    _delete_assets({file_id}, homework_asset_ids, annotation_asset_ids)
    next_library = {
      'files': [item for item in files if str(item.get('id') or '') != file_id],
      'courses': next_courses,
    }
    write_knowledge_library(next_library)
    return {
      'deleted': True,
      'library': next_library,
      'removedHomeworkDocuments': len(related_documents),
    }


def delete_knowledge_homework_document(
  course_id: str,
  document_id: str,
  delete_pipeline_document: Callable[[str], None],
) -> dict[str, Any]:
  """Atomically delete one homework or past-exam document and its assets."""
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    library = read_knowledge_library()
    removed_documents: list[dict[str, Any]] = []
    next_courses: list[dict[str, Any]] = []

    for course in library['courses']:
      if not isinstance(course, dict) or str(course.get('id') or '') != course_id:
        next_courses.append(course)
        continue
      next_course = dict(course)
      next_folders: list[dict[str, Any]] = []
      for folder in course.get('homeworkFolders') or []:
        if not isinstance(folder, dict):
          continue
        kept_documents = []
        for document in folder.get('homeworkDocuments') or []:
          if not isinstance(document, dict):
            continue
          if str(document.get('id') or '') == document_id:
            removed_documents.append(document)
          else:
            kept_documents.append(document)
        next_folder = dict(folder)
        next_folder['homeworkDocuments'] = kept_documents
        next_folders.append(next_folder)
      next_course['homeworkFolders'] = next_folders
      next_courses.append(next_course)

    next_files: list[dict[str, Any]] = []
    for lecture in library['files']:
      if not isinstance(lecture, dict):
        continue
      next_lecture = dict(lecture)
      kept_legacy_documents = []
      for document in lecture.get('homeworkDocuments') or []:
        if not isinstance(document, dict):
          continue
        if (
          str(lecture.get('courseId') or '') == course_id
          and str(document.get('id') or '') == document_id
        ):
          removed_documents.append(document)
        else:
          kept_legacy_documents.append(document)
      if 'homeworkDocuments' in next_lecture:
        next_lecture['homeworkDocuments'] = kept_legacy_documents
      next_files.append(next_lecture)

    # Keep the library record until all external cleanup succeeds.
    delete_pipeline_document(document_id)
    homework_asset_ids, annotation_asset_ids = _asset_ids_from_documents(removed_documents)
    _delete_assets(set(), homework_asset_ids, annotation_asset_ids)
    next_library = {'files': next_files, 'courses': next_courses}
    write_knowledge_library(next_library)
    return {
      'deleted': True,
      'found': bool(removed_documents),
      'documentId': document_id,
      'library': next_library,
    }


def delete_knowledge_course(
  course_id: str,
  delete_pipeline_document: Callable[[str], None],
  delete_question_document: Callable[[str], None] | None = None,
  delete_course_artifacts: Callable[[str], None] | None = None,
) -> dict[str, Any]:
  """Cascade-delete a course, its lectures, and all remaining course exercises."""
  ensure_knowledge_storage_dirs()
  with _storage_lock:
    library = read_knowledge_library(include_deleted=True)
    files = [item for item in library['files'] if isinstance(item, dict)]
    course = next((item for item in library['courses'] if isinstance(item, dict) and str(item.get('id') or '') == course_id), None)
    if course is None:
      return {'deleted': False, 'library': library}

    course_files = [item for item in files if str(item.get('courseId') or '') == course_id]
    course_documents = [
      document
      for folder in course.get('homeworkFolders') or []
      if isinstance(folder, dict)
      for document in folder.get('homeworkDocuments') or []
      if isinstance(document, dict)
    ]
    legacy_documents = [
      document
      for lecture in course_files
      for document in lecture.get('homeworkDocuments') or []
      if isinstance(document, dict)
    ]
    homework_asset_ids, annotation_asset_ids = _asset_ids_from_documents(course_documents + legacy_documents)
    for lecture in course_files:
      for annotation in lecture.get('annotations') or []:
        if isinstance(annotation, dict):
          image_asset_id = str(annotation.get('imageAssetId') or '').strip()
          if image_asset_id:
            annotation_asset_ids.add(image_asset_id)

    for lecture in course_files:
      delete_pipeline_document(str(lecture.get('id') or ''))
    if delete_question_document is not None:
      for document in course_documents + legacy_documents:
        delete_question_document(str(document.get('id') or ''))
    # The physical vector partition is removed before the authoritative
    # library record is updated. A cleanup failure therefore remains visible
    # and retryable instead of leaving hidden Qdrant data behind.
    if delete_course_artifacts is not None:
      delete_course_artifacts(course_id)
    _delete_assets(
      {str(lecture.get('id') or '') for lecture in course_files if str(lecture.get('id') or '')},
      homework_asset_ids,
      annotation_asset_ids,
    )
    next_library = {
      'files': [item for item in files if str(item.get('courseId') or '') != course_id],
      'courses': [item for item in library['courses'] if not isinstance(item, dict) or str(item.get('id') or '') != course_id],
    }
    write_knowledge_library(next_library)
    return {'deleted': True, 'library': next_library}
