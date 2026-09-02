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


def _string_values(value: Any) -> list[str]:
  if isinstance(value, str):
    values = [value]
  elif isinstance(value, (list, tuple, set)):
    values = [item for item in value if isinstance(item, str)]
  elif isinstance(value, dict):
    values = [str(key) for key, enabled in value.items() if enabled is True]
  else:
    values = []
  return sorted({item.strip().lower() for item in values if item.strip()})


def _model_metadata(item: dict[str, Any]) -> dict[str, Any]:
  capabilities = set(_string_values(item.get('capabilities')))
  capabilities.update(_string_values(item.get('supported_endpoints')))
  capabilities.update(_string_values(item.get('mode')))
  capabilities.update(_string_values(item.get('type')))

  input_modalities = set(_string_values(item.get('input_modalities')))
  output_modalities = set(_string_values(item.get('output_modalities')))
  modalities = item.get('modalities')
  if isinstance(modalities, dict):
    input_modalities.update(_string_values(modalities.get('input')))
    output_modalities.update(_string_values(modalities.get('output')))
  elif modalities is not None:
    input_modalities.update(_string_values(modalities))

  supported = item.get('supported_modalities')
  if isinstance(supported, dict):
    input_modalities.update(_string_values(supported.get('input')))
    output_modalities.update(_string_values(supported.get('output')))
  elif supported is not None:
    input_modalities.update(_string_values(supported))

  metadata: dict[str, Any] = {}
  if capabilities:
    metadata['capabilities'] = sorted(capabilities)
  if input_modalities:
    metadata['input_modalities'] = sorted(input_modalities)
  if output_modalities:
    metadata['output_modalities'] = sorted(output_modalities)
  return metadata


def _extract_models(payload: Any) -> list[dict[str, Any]]:
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

  models: dict[str, dict[str, Any]] = {}
  for item in candidates:
    if isinstance(item, str):
      model_id = item.strip()
      metadata: dict[str, Any] = {}
    elif isinstance(item, dict):
      model_id = str(item.get('id') or item.get('model') or item.get('name') or '').strip()
      metadata = _model_metadata(item)
    else:
      model_id = ''
    if model_id:
      existing = models.setdefault(model_id, {'id': model_id})
      for field in ('capabilities', 'input_modalities', 'output_modalities'):
        if field in metadata:
          existing[field] = sorted(set(existing.get(field) or []) | set(metadata[field]))
  return sorted(models.values(), key=lambda item: str(item['id']).casefold())


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
    models = _extract_models(response.json())
  except ValueError as exc:
    raise HTTPException(status_code=502, detail='模型服务没有返回有效 JSON。') from exc
  if not models:
    raise HTTPException(status_code=502, detail='模型服务响应中没有可选择的模型。')
  # Keep the legacy string list so an older cached frontend can still render
  # models while the richer DTO is used by capability-aware clients.
  return {
    'models': [str(model['id']) for model in models],
    'discovered_models': models,
    'count': len(models),
    'source_url': url,
  }
