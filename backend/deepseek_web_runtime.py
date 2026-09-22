from __future__ import annotations

from typing import Any

from .deepseek_web_bridge import DEFAULT_DEEPSEEK_WEB_BRIDGE_URL, normalize_bridge_url
from .deepseek_web_process import DeepSeekWebProcessManager, deepseek_web_process_manager
from .runtime_config import load_api_config


def resolve_deepseek_web_bridge_url(
  config: dict[str, Any] | None = None,
  bridge_url: str | None = None,
) -> str:
  """Resolve one safe loopback URL for every Bridge lifecycle entry point."""
  value = bridge_url if bridge_url is not None else (config or {}).get('deepseekWebBridgeUrl')
  return normalize_bridge_url(str(value or DEFAULT_DEEPSEEK_WEB_BRIDGE_URL).strip())


def ensure_deepseek_web_bridge(
  config: dict[str, Any] | None = None,
  bridge_url: str | None = None,
  *,
  process_manager: DeepSeekWebProcessManager | None = None,
) -> dict[str, Any]:
  """Ensure the bundled Bridge is ready, reusing the manager's concurrency guard."""
  resolved_config = config
  if resolved_config is None and bridge_url is None:
    resolved_config = load_api_config() or {}
  url = resolve_deepseek_web_bridge_url(resolved_config, bridge_url)
  manager = process_manager or deepseek_web_process_manager
  return manager.ensure_started(url)


def should_auto_start_deepseek_web_bridge(config: dict[str, Any] | None) -> bool:
  values = config or {}
  return any(
    str(values.get(field) or 'api').strip().lower() == 'deepseek-web'
    for field in ('doubtProvider', 'ocrProvider')
  )


__all__ = [
  'ensure_deepseek_web_bridge',
  'resolve_deepseek_web_bridge_url',
  'should_auto_start_deepseek_web_bridge',
]
