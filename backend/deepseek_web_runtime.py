from __future__ import annotations

from typing import Any

from .deepseek_web_bridge import (
  DEFAULT_DEEPSEEK_WEB_BRIDGE_URL,
  DeepSeekWebBridgeClient,
  DeepSeekWebBridgeError,
  normalize_bridge_url,
)
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


def get_deepseek_web_bridge_status(
  config: dict[str, Any] | None = None,
  *,
  bridge: DeepSeekWebBridgeClient | None = None,
  process_manager: DeepSeekWebProcessManager | None = None,
) -> dict[str, Any]:
  """Expose process health separately from the browser's login/session state."""
  resolved_config = config
  if resolved_config is None:
    resolved_config = load_api_config() or {}
  url = resolve_deepseek_web_bridge_url(resolved_config)
  manager = process_manager or deepseek_web_process_manager
  process = manager.status(url)
  browser = {
    'browser_running': False,
    'logged_in': False,
    'chat_available': False,
    'image_upload_available': False,
    'status_available': False,
    'error': None,
  }
  try:
    browser.update((bridge or DeepSeekWebBridgeClient()).status(url))
    browser['status_available'] = True
  except DeepSeekWebBridgeError as exc:
    browser['error'] = str(exc)

  # Keep the original flat fields for older clients while adding the stable
  # nested shape used by newer diagnostics and settings screens.
  return {
    'bridge': process,
    'browser': browser,
    'bridge_url': url,
    **{key: browser[key] for key in (
      'browser_running',
      'logged_in',
      'chat_available',
      'image_upload_available',
    )},
  }


__all__ = [
  'ensure_deepseek_web_bridge',
  'get_deepseek_web_bridge_status',
  'resolve_deepseek_web_bridge_url',
  'should_auto_start_deepseek_web_bridge',
]
