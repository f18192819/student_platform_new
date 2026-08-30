from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Body

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
  return {'configured': True, 'config': save_api_config(payload)}


@provider_router.post('/api/provider-models')
async def list_provider_models(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
  return await asyncio.to_thread(
    fetch_provider_models,
    base_url=str(payload.get('base_url') or '').strip(),
    api_key=str(payload.get('api_key') or '').strip(),
  )

