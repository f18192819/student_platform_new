from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import HTTPException

from .config import PROJECT_ROOT

CONFIG_DIR = PROJECT_ROOT / '.runtime'
CONFIG_PATH = CONFIG_DIR / 'api-config.json'
_config_lock = Lock()


def _string(value: Any, fallback: str = '') -> str:
  return value.strip() if isinstance(value, str) else fallback


def _context_window_overrides(value: Any) -> dict[str, int]:
  if not isinstance(value, dict):
    return {}
  normalized: dict[str, int] = {}
  for raw_model_id, raw_window in value.items():
    model_id = _string(raw_model_id)
    try:
      context_window = int(raw_window)
    except (TypeError, ValueError):
      continue
    if model_id and context_window >= 4096:
      normalized[model_id] = context_window
  return normalized


def _compaction_threshold(value: Any) -> float:
  try:
    threshold = float(value)
  except (TypeError, ValueError):
    return 0.6
  return min(0.9, max(0.4, threshold))


def normalize_api_config(payload: dict[str, Any]) -> dict[str, Any]:
  raw_models = payload.get('models')
  models = (
    list(dict.fromkeys(_string(model) for model in raw_models if _string(model)))
    if isinstance(raw_models, list)
    else []
  )
  model = _string(payload.get('model'))
  if model and model not in models:
    models.insert(0, model)
  if not model and models:
    model = models[0]

  def model_group(models_key: str, model_key: str, fallback_model: str) -> tuple[list[str], str]:
    raw_group_models = payload.get(models_key)
    group_models = (
      list(dict.fromkeys(_string(item) for item in raw_group_models if _string(item)))
      if isinstance(raw_group_models, list)
      else []
    )
    group_model = _string(payload.get(model_key), fallback_model)
    if group_model and group_model not in group_models:
      group_models.insert(0, group_model)
    if not group_model and group_models:
      group_model = group_models[0]
    return group_models or [fallback_model], group_model or fallback_model

  embedding_models, embedding_model = model_group('embeddingModels', 'embeddingModel', 'GLM-Embedding-3')
  rerank_models, rerank_model = model_group('rerankModels', 'rerankModel', 'GLM-Rerank')
  doubt_models, doubt_model = model_group('doubtModels', 'doubtModel', model or 'GLM-4.6V')

  return {
    'baseUrl': _string(payload.get('baseUrl')),
    'apiKey': _string(payload.get('apiKey')),
    'model': model,
    'models': models,
    'doubtModel': doubt_model,
    'doubtModels': doubt_models,
    'contextWindowOverrides': _context_window_overrides(payload.get('contextWindowOverrides')),
    'contextCompactionThreshold': _compaction_threshold(payload.get('contextCompactionThreshold')),
    'embeddingBaseUrl': _string(payload.get('embeddingBaseUrl'), _string(payload.get('baseUrl'))),
    'embeddingApiKey': _string(payload.get('embeddingApiKey'), _string(payload.get('apiKey'))),
    'embeddingModel': embedding_model,
    'embeddingModels': embedding_models,
    'rerankBaseUrl': _string(payload.get('rerankBaseUrl'), _string(payload.get('baseUrl'))),
    'rerankApiKey': _string(payload.get('rerankApiKey'), _string(payload.get('apiKey'))),
    'rerankModel': rerank_model,
    'rerankModels': rerank_models,
    # Neo4j is optional: Qdrant remains the vector store even when this is enabled.
    'neo4jEnabled': bool(payload.get('neo4jEnabled', False)),
    'neo4jAutoStart': bool(payload.get('neo4jAutoStart', True)),
    'neo4jHome': _string(payload.get('neo4jHome')),
    'neo4jUri': _string(payload.get('neo4jUri'), 'bolt://127.0.0.1:7687'),
    'neo4jUsername': _string(payload.get('neo4jUsername')),
    'neo4jPassword': _string(payload.get('neo4jPassword')),
    'neo4jDatabase': _string(payload.get('neo4jDatabase'), 'neo4j'),
    # Keep the legacy field synchronized so old browser data cannot select a stale model.
    'homeworkSplitModel': model,
    'systemPrompt': _string(payload.get('systemPrompt')),
    'asrBaseUrl': _string(payload.get('asrBaseUrl'), 'local://conda-funasr'),
    'asrApiKey': _string(payload.get('asrApiKey'), 'local'),
    'asrModel': _string(payload.get('asrModel'), 'paraformer-zh'),
    'asrPrompt': _string(payload.get('asrPrompt')),
  }


def load_api_config() -> dict[str, Any] | None:
  if not CONFIG_PATH.is_file():
    return None

  try:
    payload = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
  except (OSError, json.JSONDecodeError) as exc:
    raise HTTPException(status_code=500, detail=f'Unable to read server API configuration: {exc}') from exc

  if not isinstance(payload, dict):
    raise HTTPException(status_code=500, detail='Server API configuration is invalid.')
  return normalize_api_config(payload)


def save_api_config(payload: dict[str, Any]) -> dict[str, Any]:
  config = normalize_api_config(payload)
  if not config['baseUrl'] or not config['apiKey'] or not config['model']:
    raise HTTPException(
      status_code=422,
      detail='baseUrl, apiKey, and one active text model are required.',
    )

  CONFIG_DIR.mkdir(parents=True, exist_ok=True)
  temp_path = CONFIG_PATH.with_suffix('.tmp')
  with _config_lock:
    try:
      temp_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
      temp_path.replace(CONFIG_PATH)
    except OSError as exc:
      raise HTTPException(status_code=500, detail=f'Unable to save server API configuration: {exc}') from exc

  return config
