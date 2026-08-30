from __future__ import annotations

from fastapi import APIRouter

from backend.adaptive_testing import adaptive_testing_router
from backend.app_factory import (
  create_app_with_router,
  mount_student_learning_platform_demo_frontend,
)
from backend.application_runtime import ApplicationRuntime
from backend.knowledge_router import create_knowledge_router
from backend.media_router import (
  build_classroom_session_from_text_api,
  create_media_router,
  transcribe_audio_file_with_chunking,
)
from backend.pipeline_router import create_pipeline_router
from backend.provider_router import provider_router
from backend.tsinghua_sync import tsinghua_router


application_runtime = ApplicationRuntime()
application_lifespan = application_runtime.lifespan
backend_router = APIRouter()
backend_router.include_router(tsinghua_router)
backend_router.include_router(adaptive_testing_router)
backend_router.include_router(provider_router)
backend_router.include_router(create_knowledge_router(application_runtime))
backend_router.include_router(create_pipeline_router(application_runtime))
backend_router.include_router(create_media_router(application_runtime))


def create_app():
  return create_app_with_router(backend_router, lifespan=application_lifespan)


app = create_app()


__all__ = [
  'app',
  'backend_router',
  'build_classroom_session_from_text_api',
  'create_app',
  'mount_student_learning_platform_demo_frontend',
  'transcribe_audio_file_with_chunking',
]
