from __future__ import annotations

import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Protocol, Sequence

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from backend.config import PROJECT_ROOT

from .browser import PersistentBrowser
from .deepseek_client import BridgeOperationError, DeepSeekWebClient
from .models import BridgeStatus, ChatRequest, ChatResponse, OcrResponse


logger = logging.getLogger(__name__)
ALLOWED_IMAGE_TYPES = {'image/png', 'image/jpeg', 'image/webp'}
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_FILES = 16


class BridgeClient(Protocol):
  async def open_browser(self) -> dict[str, bool]: ...
  async def status(self) -> dict[str, bool]: ...
  async def chat(self, prompt: str) -> str: ...
  async def ocr(self, files: Sequence[Path], prompt: str = '') -> str: ...


def _http_error(exc: BridgeOperationError) -> HTTPException:
  logger.warning('DeepSeek Web Bridge operation failed [%s]: %s', exc.code, exc)
  status = 401 if exc.code == 'not_logged_in' else 408 if exc.code == 'generation_timeout' else 409
  return HTTPException(status_code=status, detail={'code': exc.code, 'message': str(exc)})


def create_bridge_app(client: BridgeClient | None = None) -> FastAPI:
  browser = None
  if client is None:
    profile = Path(os.environ.get(
      'DEEPSEEK_WEB_PROFILE',
      str(PROJECT_ROOT / '.runtime' / 'deepseek-web-profile'),
    )).resolve()
    browser = PersistentBrowser(profile, headless=False)
    client = DeepSeekWebClient(browser)

  @asynccontextmanager
  async def lifespan(_app: FastAPI):
    yield
    if browser is not None:
      await browser.close()

  app = FastAPI(title='DeepSeek Web Local Debug Bridge', lifespan=lifespan)

  @app.get('/health')
  async def health() -> dict[str, bool]:
    return {'ok': True}

  @app.get('/status', response_model=BridgeStatus)
  async def status():
    return await client.status()

  @app.post('/browser/open')
  async def open_browser():
    try:
      return await client.open_browser()
    except BridgeOperationError as exc:
      raise _http_error(exc) from exc

  @app.post('/v1/chat', response_model=ChatResponse)
  async def chat(request: ChatRequest):
    try:
      return ChatResponse(text=await client.chat(request.prompt))
    except BridgeOperationError as exc:
      raise _http_error(exc) from exc

  @app.post('/v1/ocr', response_model=OcrResponse)
  async def ocr(prompt: str = Form(default=''), files: list[UploadFile] = File(...)):
    if not files or len(files) > MAX_FILES:
      raise HTTPException(
        status_code=422,
        detail={'code': 'upload_failed', 'message': f'每次必须上传 1 到 {MAX_FILES} 张图片。'},
      )
    with tempfile.TemporaryDirectory(prefix='deepseek-web-ocr-') as temporary:
      paths = []
      for index, upload in enumerate(files, start=1):
        if upload.content_type not in ALLOWED_IMAGE_TYPES:
          raise HTTPException(
            status_code=415,
            detail={'code': 'upload_failed', 'message': f'不支持的图片格式：{upload.content_type or "unknown"}'},
          )
        content = await upload.read(MAX_FILE_BYTES + 1)
        if len(content) > MAX_FILE_BYTES:
          raise HTTPException(
            status_code=413,
            detail={'code': 'upload_failed', 'message': '单张图片不能超过 8 MB。'},
          )
        suffix = '.png' if upload.content_type == 'image/png' else '.webp' if upload.content_type == 'image/webp' else '.jpg'
        path = Path(temporary) / f'{index:03d}{suffix}'
        path.write_bytes(content)
        paths.append(path)
      try:
        text = await client.ocr(paths, prompt)
      except BridgeOperationError as exc:
        raise _http_error(exc) from exc
    return OcrResponse(text=text, page_count=len(paths))

  return app


app = create_bridge_app()


if __name__ == '__main__':
  import uvicorn

  uvicorn.run(app, host='127.0.0.1', port=8765)
