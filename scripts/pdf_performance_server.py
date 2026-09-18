import argparse
import asyncio
import subprocess
import types
from pathlib import Path

import fitz
import uvicorn
from fastapi import FastAPI
from fastapi.responses import Response, FileResponse

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
if args.baseline:
    code = subprocess.check_output(['git', 'show', 'HEAD:backend/knowledge_storage.py'], cwd=root).decode('utf-8')
    storage = types.ModuleType('backend.benchmark_storage')
    storage.__file__ = str(root / 'backend/knowledge_storage.py')
    exec(compile(code, storage.__file__, 'exec'), storage.__dict__)
else:
    from backend import knowledge_storage as storage
fixture_root = root / '.pytest-tmp/pdf-performance'
fixture_root.mkdir(parents=True, exist_ok=True)
storage.KNOWLEDGE_PDF_DIR = fixture_root
storage.KNOWLEDGE_PDF_PAGE_DIR = fixture_root / ('baseline-pages' if args.baseline else 'updated-pages')
storage.KNOWLEDGE_LIBRARY_PATH = fixture_root / 'library.json'
files = []
for count in [10, 50, 120]:
    target = fixture_root / f'benchmark-{count}.pdf'
    if not target.exists():
        with fitz.open(root / '_converted.pdf') as source, fitz.open() as output:
            for index in range(count):
                page = output.new_page(width=612, height=792)
                page.show_pdf_page(page.rect, source, index % min(3, len(source)))
            output.save(target, garbage=4, deflate=True)
    files.append(dict(id=f'benchmark-{count}', courseId='benchmark-course', fileName=f'Benchmark {count}.pdf', pageCount=count, byteSize=target.stat().st_size, hasPdfSource=True, markdown='# Benchmark', pipelineStatus='completed', libraryFolder='courseware', layoutBlocks=[], annotations=[], classroomSessions=[], chatMessages=[]))
library = dict(files=files, courses=[dict(id='benchmark-course', name='Benchmark', title='Benchmark')], homeworkDocuments=[], knowledgeLinks=[])
storage.read_knowledge_library = lambda: library
app = FastAPI()

@app.get('/api/knowledge/library')
@app.put('/api/knowledge/library')
async def get_library():
    return library

@app.get('/api/knowledge/pdf/{file_id}')
async def get_pdf(file_id: str):
    path = fixture_root / f'{file_id}.pdf'
    return Response(path.read_bytes(), media_type='application/pdf') if args.baseline else FileResponse(path, media_type='application/pdf')

@app.get('/api/knowledge/pdf/{file_id}/pages/{page_number}')
async def get_page(file_id: str, page_number: int):
    return Response(await asyncio.to_thread(storage.read_pdf_page_image, file_id, page_number), media_type='image/png')

@app.get('/api/{remaining:path}')
async def other(remaining: str):
    return {}

uvicorn.run(app, host='127.0.0.1', port=18080, log_level='warning')
