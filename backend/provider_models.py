from __future__ import annotations

import re
from typing import Any

import requests
from fastapi import HTTPException


def _models_url(base_url: str) -> str:
  normalized = str(base_url or '').strip().rstrip('/')
  if not normalized:
    raise HTTPException(status_code=422, detail='Base URL is required before fetching models.')
  if normalized.startswith('local://'):
    raise HTTPException(status_code=422, detail='本地服务不提供远程模型列表，请保留手动填写的模型名称。')
  root = re.sub(
    r'/(chat/completions|embeddings|rerank|audio/transcriptions|models)$',
    '',
    normalized,
    flags=re.IGNORECASE,
  )
  return f'{root}/models'


def _extract_model_ids(payload: Any) -> list[str]:
  if isinstance(payload, list):
    candidates = payload
  elif isinstance(payload, dict):
    candidates = payload.get('data')
    if not isinstance(candidates, list):
      candidates = payload.get('models')
    if isinstance(candidates, dict):
      candidates = [
        {'id': key} | (value if isinstance(value, dict) else {})
        for key, value in candidates.items()
      ]
  else:
    candidates = None
  if not isinstance(candidates, list):
    return []

  model_ids: set[str] = set()
  for item in candidates:
    if isinstance(item, str):
      model_id = item.strip()
    elif isinstance(item, dict):
      model_id = str(item.get('id') or item.get('model') or item.get('name') or '').strip()
    else:
      model_id = ''
    if model_id:
      model_ids.add(model_id)
  return sorted(model_ids, key=str.casefold)


def fetch_provider_models(*, base_url: str, api_key: str = '') -> dict[str, Any]:
  url = _models_url(base_url)
  headers = {'Accept': 'application/json'}
  normalized_api_key = str(api_key or '').strip()
  if normalized_api_key:
    headers['Authorization'] = f'Bearer {normalized_api_key}'
  try:
    response = requests.get(url, headers=headers, timeout=30)
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'获取模型列表失败：{exc}') from exc
  if not response.ok:
    detail = response.text.strip().replace('\n', ' ')[:500]
    raise HTTPException(
      status_code=502,
      detail=f'模型服务返回 HTTP {response.status_code}：{detail or response.reason}',
    )
  try:
    models = _extract_model_ids(response.json())
  except ValueError as exc:
    raise HTTPException(status_code=502, detail='模型服务没有返回有效 JSON。') from exc
  if not models:
    raise HTTPException(status_code=502, detail='模型服务响应中没有可选择的模型。')
  return {'models': models, 'count': len(models), 'source_url': url}
