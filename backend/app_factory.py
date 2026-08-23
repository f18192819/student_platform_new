from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import FRONTEND_DIST, PROJECT_ROOT, PUBLIC_DIR, UI_PREFIX

try:
  from service_manager.runtime.ui import register_service_frontend_static
except Exception:  # noqa: BLE001
  register_service_frontend_static = None


def mount_frontend_shell(app: FastAPI) -> None:
  if not FRONTEND_DIST.is_dir():
    return

  assets_dir = FRONTEND_DIST / 'assets'
  if assets_dir.is_dir():
    app.mount('/assets', StaticFiles(directory=str(assets_dir)), name='assets')

  for static_name in ('favicon.svg', 'icons.svg'):
    static_file = FRONTEND_DIST / static_name
    if not static_file.is_file():
      static_file = PUBLIC_DIR / static_name
    if static_file.is_file():
      route_path = f'/{static_name}'

      async def _serve_static(file_path: Path = static_file) -> FileResponse:
        return FileResponse(file_path)

      app.add_api_route(route_path, _serve_static, include_in_schema=False)

  @app.get('/{full_path:path}', include_in_schema=False)
  async def serve_spa(full_path: str) -> FileResponse:
    if full_path.startswith('api/'):
      raise HTTPException(status_code=404, detail='API route not found.')

    requested = (FRONTEND_DIST / full_path).resolve()
    try:
      requested.relative_to(FRONTEND_DIST.resolve())
    except ValueError:
      requested = FRONTEND_DIST / 'index.html'

    if full_path and requested.is_file():
      return FileResponse(requested)

    index_file = FRONTEND_DIST / 'index.html'
    if not index_file.is_file():
      raise HTTPException(status_code=404, detail='Frontend build not found.')
    return FileResponse(index_file)


def create_app_with_router(router, lifespan=None) -> FastAPI:
  app = FastAPI(title='Student Learning Platform Demo', lifespan=lifespan)
  app.include_router(router)
  mount_frontend_shell(app)
  return app


def mount_student_learning_platform_demo_frontend(app_instance) -> None:
  if not FRONTEND_DIST.is_dir() or register_service_frontend_static is None:
    return
  register_service_frontend_static(
    app_instance,
    ui_prefix=UI_PREFIX,
    service_path=PROJECT_ROOT,
  )


def create_app():
  from app import backend_router

  return create_app_with_router(backend_router)
