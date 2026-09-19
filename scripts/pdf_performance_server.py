import argparse
import asyncio
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import fitz
import uvicorn
from fastapi import FastAPI
from fastapi.responses import Response, FileResponse

DEFAULT_BASELINE_REF = 'c7225717a82b0bf4025ee3e87a3c00c7506ba3d5'

parser = argparse.ArgumentParser()
parser.add_argument('--baseline', action='store_true')
parser.add_argument('--baseline-ref', default=os.environ.get('PDF_BENCH_BASELINE_REF', DEFAULT_BASELINE_REF))
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root))
baseline_ref = subprocess.check_output(['git', 'rev-parse', args.baseline_ref], cwd=root).decode('utf-8').strip()
candidate_ref = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root).decode('utf-8').strip()
print(json.dumps({
    'pdfBenchmark': 'server',
    'mode': 'baseline' if args.baseline else 'candidate',
    'baselineRef': baseline_ref,
    'candidateRef': candidate_ref,
}), flush=True)
if args.baseline:
    code = subprocess.check_output(
        ['git', 'show', f'{baseline_ref}:backend/knowledge_storage.py'],
        cwd=root,
    ).decode('utf-8')
    storage = types.ModuleType('backend.benchmark_storage')
    storage.__file__ = str(root / 'backend/knowledge_storage.py')
    exec(compile(code, storage.__file__, 'exec'), storage.__dict__)
else:
    from backend import knowledge_storage as storage
fixture_root = root / '.pytest-tmp/pdf-performance'
fixture_root.mkdir(parents=True, exist_ok=True)
storage.KNOWLEDGE_PDF_DIR = fixture_root
storage.KNOWLEDGE_PDF_PAGE_DIR = fixture_root / (
    f'baseline-{baseline_ref[:12]}-pages' if args.baseline else f'candidate-{candidate_ref[:12]}-pages'
)
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
