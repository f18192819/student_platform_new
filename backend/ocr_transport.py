from __future__ import annotations

import re
from collections.abc import Mapping
from threading import RLock
from typing import Any, Literal

from .provider_transport import normalize_openai_api_root


OcrTransport = Literal['litellm_ocr', 'openai_chat_vision']
INCOMPATIBLE_OCR_MESSAGE = (
  '当前模型存在，但服务端没有提供兼容的 OCR / 视觉调用接口。请尝试其他 OCR 模型。'
)

_transport_lock = RLock()
_transport_cache: dict[tuple[str, str], OcrTransport] = {}
_OCR_NAME_PATTERN = re.compile(r'(^|[-_.:/])(ocr|paddleocr|mistral-ocr)([-_.:/]|$)', re.IGNORECASE)


def _string_values(value: Any) -> set[str]:
  if isinstance(value, str):
    values = [value]
  elif isinstance(value, (list, tuple, set)):
    values = [item for item in value if isinstance(item, str)]
  elif isinstance(value, Mapping):
    values = [str(key) for key, enabled in value.items() if enabled is True]
  else:
    values = []
  return {item.strip().casefold() for item in values if item.strip()}


def _metadata_transport(metadata: Mapping[str, Any] | None) -> OcrTransport | None:
  if not metadata:
    return None
  mode = str(metadata.get('mode') or '').strip().casefold()
  model_type = str(metadata.get('type') or '').strip().casefold()
  capabilities = _string_values(metadata.get('capabilities'))
  endpoints = _string_values(metadata.get('supported_endpoints'))
  if mode == 'ocr' or model_type == 'ocr' or 'ocr' in capabilities:
    return 'litellm_ocr'
  if any(endpoint.rstrip('/').endswith('/ocr') or endpoint == 'ocr' for endpoint in endpoints):
    return 'litellm_ocr'
  return None


def _cache_key(base_url: str, model: str) -> tuple[str, str]:
  return normalize_openai_api_root(base_url).casefold(), str(model or '').strip().casefold()


def cache_ocr_transport(base_url: str, model: str, transport: OcrTransport) -> None:
  key = _cache_key(base_url, model)
  if not all(key):
    return
  with _transport_lock:
    _transport_cache[key] = transport


def cached_ocr_transport(base_url: str, model: str) -> OcrTransport | None:
  with _transport_lock:
    return _transport_cache.get(_cache_key(base_url, model))


def clear_ocr_transport_cache() -> None:
  with _transport_lock:
    _transport_cache.clear()


def resolve_ocr_transport(
  model: str,
  provider_metadata: Mapping[str, Any] | None = None,
  *,
  base_url: str = '',
  capability_registry: Mapping[str, Mapping[str, Any]] | None = None,
) -> OcrTransport:
  """Resolve OCR protocol from provider facts, registry data, cache, then a narrow name heuristic."""
  metadata_mode = _metadata_transport(provider_metadata)
  if metadata_mode:
    cache_ocr_transport(base_url, model, metadata_mode)
    return metadata_mode

  normalized_model = str(model or '').strip().casefold()
  if capability_registry:
    registry_metadata = next(
      (
        metadata for model_id, metadata in capability_registry.items()
        if str(model_id).strip().casefold() == normalized_model
      ),
      None,
    )
    registry_mode = _metadata_transport(registry_metadata)
    if registry_mode:
      cache_ocr_transport(base_url, model, registry_mode)
      return registry_mode

  cached = cached_ocr_transport(base_url, model)
  if cached:
    return cached

  mode: OcrTransport = (
    'litellm_ocr' if _OCR_NAME_PATTERN.search(normalized_model) else 'openai_chat_vision'
  )
  cache_ocr_transport(base_url, model, mode)
  return mode


__all__ = [
  'INCOMPATIBLE_OCR_MESSAGE',
  'OcrTransport',
  'cache_ocr_transport',
  'cached_ocr_transport',
  'clear_ocr_transport_cache',
  'resolve_ocr_transport',
]
