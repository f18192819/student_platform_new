from __future__ import annotations

from pathlib import Path
import random

import fitz
import uvicorn
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / '.pytest-tmp' / 'pdf-reader-smoke'
FIXTURE_ROOT.mkdir(parents=True, exist_ok=True)
NOW = '2026-09-19T00:00:00.000Z'


def build_pdf(
  name: str,
  page_count: int,
  hue: tuple[float, float, float],
  range_padding_bytes: int = 0,
) -> Path:
  target = FIXTURE_ROOT / name
  if target.exists() and (not range_padding_bytes or target.stat().st_size > 2 * 65_536):
    return target
  if target.exists():
    target.unlink()

  document = fitz.open()
  for page_index in range(page_count):
    page = document.new_page(width=612, height=792)
    page.draw_rect(fitz.Rect(36, 36, 576, 150), color=hue, fill=hue)
    page.draw_rect(fitz.Rect(72, 220, 540, 650), color=(0.1, 0.2, 0.35), width=3)
    page.insert_text(
      fitz.Point(64, 105),
      f'{name} / page {page_index + 1}',
      fontsize=24,
      color=(1, 1, 1),
    )
    page.insert_text(
      fitz.Point(96, 300),
      f'PDF reader smoke fixture {page_index + 1}',
      fontsize=18,
      color=(0.05, 0.08, 0.12),
    )
  if range_padding_bytes:
    padding = random.Random(42).randbytes(range_padding_bytes)
    document.embfile_add('range-padding.bin', padding, filename='range-padding.bin')
  document.save(target, garbage=4, deflate=True)
  document.close()
  return target


PDF_PATHS = {
  'smoke-a': build_pdf('smoke-a.pdf', 3, (0.12, 0.42, 0.78)),
  'smoke-b': build_pdf('smoke-b.pdf', 3, (0.72, 0.22, 0.32)),
  'smoke-120': build_pdf('smoke-120.pdf', 120, (0.18, 0.58, 0.34), 256 * 1024),
  'smoke-homework': build_pdf('smoke-homework.pdf', 3, (0.55, 0.30, 0.72)),
}


def homework_document() -> dict:
  return {
    'id': 'smoke-homework',
    'lectureDocumentId': 'smoke-a',
    'assetId': 'smoke-homework',
    'fileName': 'Smoke Homework.pdf',
    'sourceType': 'pdf',
    'mimeType': 'application/pdf',
    'byteSize': PDF_PATHS['smoke-homework'].stat().st_size,
    'pageCount': 3,
    'status': 'ready',
    'extractor': 'mineru',
    'extractedMarkdown': '# Smoke homework',
    'layoutBlocks': [],
    'questions': [{
      'id': 'smoke-question',
      'homeworkDocumentId': 'smoke-homework',
      'index': 0,
      'title': 'Smoke question',
      'content': 'Verify the PDF viewer remains stable.',
      'pageNumber': 1,
      'analysis': None,
    }],
    'knowledgeLinks': [{
      'id': 'smoke-link',
      'homeworkDocumentId': 'smoke-homework',
      'lectureDocumentId': 'smoke-a',
      'questionId': 'smoke-question',
      'questionTitle': 'Smoke question',
      'questionIndex': 0,
      'conceptTitle': 'Viewer stability',
      'lecturePageNumber': 1,
      'lectureAnchorText': 'PDF reader smoke fixture',
    }],
    'annotations': [],
    'errorMessage': None,
    'createdAt': NOW,
    'updatedAt': NOW,
  }


def file_record(file_id: str, name: str, page_count: int) -> dict:
  return {
    'id': file_id,
    'sourceKey': f'smoke:{file_id}',
    'courseId': 'smoke-course',
    'fileName': name,
    'pageCount': page_count,
    'pageSizes': [{'width': 612, 'height': 792} for _ in range(page_count)],
    'byteSize': PDF_PATHS[file_id].stat().st_size,
    'hasPdfSource': True,
    'markdown': f'# {name}',
    'layoutBlocks': [],
    'annotationMarkdown': '',
    'createdAt': NOW,
    'updatedAt': NOW,
    'lastOpenedAt': NOW,
    'annotations': [],
    'chatMessages': [],
    'homeworkDocuments': [],
    'classroomSessions': [],
    'libraryFolder': 'courseware',
    'pipelineStatus': 'completed',
    'mineruStatus': 'completed',
  }


HOMEWORK = homework_document()
LIBRARY = {
  'files': [
    file_record('smoke-a', 'Smoke A.pdf', 3),
    file_record('smoke-b', 'Smoke B.pdf', 3),
    file_record('smoke-120', 'Smoke 120.pdf', 120),
  ],
  'courses': [{
    'id': 'smoke-course',
    'name': 'Smoke Course',
    'source': 'manual',
    'homeworkFolders': [
      {
        'id': 'smoke-course:homework',
        'courseId': 'smoke-course',
        'folderType': 'homework',
        'name': 'Homework',
        'homeworkDocuments': [HOMEWORK],
        'createdAt': NOW,
        'updatedAt': NOW,
      },
      {
        'id': 'smoke-course:past-exam',
        'courseId': 'smoke-course',
        'folderType': 'past-exam',
        'name': 'Past exams',
        'homeworkDocuments': [],
        'createdAt': NOW,
        'updatedAt': NOW,
      },
    ],
    'createdAt': NOW,
    'updatedAt': NOW,
  }],
}

app = FastAPI()


@app.get('/health')
async def health() -> dict:
  return {'ok': True}


@app.get('/api/knowledge/library')
async def read_library() -> dict:
  return LIBRARY


@app.put('/api/knowledge/library')
async def write_library(_payload: dict = Body(...)) -> dict:
  return LIBRARY


@app.get('/api/knowledge/pdf/{file_id}')
async def read_pdf(file_id: str) -> FileResponse:
  path = PDF_PATHS.get(file_id)
  if not path:
    raise HTTPException(status_code=404)
  return FileResponse(path, media_type='application/pdf')


@app.get('/api/knowledge/pdf/{file_id}/pages/{page_number}')
async def read_pdf_page(file_id: str, page_number: int) -> JSONResponse:
  del file_id, page_number
  return JSONResponse({'detail': 'Raster enhancement intentionally unavailable.'}, status_code=404)


@app.get('/api/knowledge/homework-asset/{asset_id}')
async def read_homework_asset(asset_id: str) -> FileResponse:
  if asset_id != 'smoke-homework':
    raise HTTPException(status_code=404)
  return FileResponse(PDF_PATHS['smoke-homework'], media_type='application/pdf')


@app.get('/api/question-relations/{remaining:path}')
async def read_relations(remaining: str) -> dict:
  del remaining
  return {'status': 'completed', 'relations': []}


@app.get('/api/user-answers/courses/{course_id}/documents/{document_id}/questions/{question_id}/attempts')
async def read_user_answer_attempts(course_id: str, document_id: str, question_id: str) -> dict:
  del course_id, document_id, question_id
  return {'attempts': []}


@app.api_route('/api/{remaining:path}', methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
async def other_api(remaining: str) -> dict:
  del remaining
  return {}


if __name__ == '__main__':
  uvicorn.run(app, host='127.0.0.1', port=18081, log_level='warning')
