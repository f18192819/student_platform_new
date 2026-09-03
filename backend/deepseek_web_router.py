from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Body, HTTPException

from .deepseek_web_bridge import DeepSeekWebBridgeClient, DeepSeekWebBridgeError
from .runtime_config import load_api_config


def create_deepseek_web_router(
  client: DeepSeekWebBridgeClient | None = None,
) -> APIRouter:
  bridge = client or DeepSeekWebBridgeClient()
  router = APIRouter(prefix='/api/deepseek-web', tags=['deepseek-web-debug'])

  def bridge_url(payload: dict[str, Any] | None = None) -> str:
    config = load_api_config() or {}
    return str((payload or {}).get('bridge_url') or config.get('deepseekWebBridgeUrl') or '').strip()

  async def execute(function, *args, **kwargs):
    try:
      return await asyncio.to_thread(function, *args, **kwargs)
    except DeepSeekWebBridgeError as exc:
      status = 503 if exc.code in {'bridge_not_ready', 'browser_closed'} else 409
      raise HTTPException(status_code=status, detail={'code': exc.code, 'message': str(exc)}) from exc

  @router.get('/status')
  async def status() -> dict[str, Any]:
    return await execute(bridge.status, bridge_url())

  @router.post('/open')
  async def open_browser(payload: dict[str, Any] = Body(default={})) -> dict[str, Any]:
    return await execute(bridge.open_browser, bridge_url(payload))

  @router.post('/chat')
  async def chat(payload: dict[str, Any] = Body(...)) -> dict[str, str]:
    prompt = str(payload.get('prompt') or '').strip()
    if not prompt:
      raise HTTPException(status_code=422, detail='prompt is required.')
    text = await execute(bridge.chat, bridge_url(payload), prompt)
    return {'text': text, 'provider': 'deepseek-web'}

  return router


__all__ = ['create_deepseek_web_router']
