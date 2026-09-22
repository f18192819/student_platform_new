from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from .deepseek_web_bridge import DeepSeekWebBridgeError
from .deepseek_web_runtime import ensure_deepseek_web_bridge, should_auto_start_deepseek_web_bridge
from .deepseek_web_process import DeepSeekWebStartupError
from .provider_models import fetch_provider_models
from .runtime_config import load_api_config, save_api_config

provider_router = APIRouter(tags=['provider-config'])


@provider_router.get('/api/config')
async def get_api_config() -> dict[str, Any]:
  config = load_api_config()
  return {'configured': config is not None, 'config': config}


@provider_router.put('/api/config')
async def update_api_config(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  # Knowledge graph fields remain persisted for backward compatibility.
  config = save_api_config(payload)
  if should_auto_start_deepseek_web_bridge(config):
    # Complete an API -> Web switch before returning, so the next request can
    # rely on the same ready Bridge lifecycle as a cold start.
    try:
      await asyncio.to_thread(ensure_deepseek_web_bridge, config=config)
    except (DeepSeekWebBridgeError, DeepSeekWebStartupError) as exc:
      raise HTTPException(
        status_code=503,
        detail={
          'code': 'bridge_start_failed',
          'message': f'DeepSeek 网页端 bridge 启动失败，请检查登录态是否过期或 Playwright/Chromium 是否已安装：{exc}',
        },
      ) from exc
  return {'configured': True, 'config': config}


@provider_router.post('/api/provider-models')
async def list_provider_models(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  return await asyncio.to_thread(
    fetch_provider_models,
    base_url=str(payload.get('base_url') or '').strip(),
    api_key=str(payload.get('api_key') or '').strip(),
  )
