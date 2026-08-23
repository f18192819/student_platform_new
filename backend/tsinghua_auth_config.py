from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import Any

from fastapi import HTTPException

from .config import PROJECT_ROOT

CONFIG_DIR = PROJECT_ROOT / '.runtime'
AUTH_CONFIG_PATH = CONFIG_DIR / 'tsinghua-auth.json'
_auth_lock = Lock()


def _string(value: Any, fallback: str = '') -> str:
  return value.strip() if isinstance(value, str) else fallback


def normalize_tsinghua_auth_config(
  payload: dict[str, Any],
  existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
  previous = existing or {}
  username = _string(payload.get('username'), _string(previous.get('username')))
  next_password = payload.get('password')
  if isinstance(next_password, str):
    password = next_password if next_password else _string(previous.get('password'))
  else:
    password = _string(previous.get('password'))

  return {
    'username': username,
    'password': password,
    'autoLoginEnabled': bool(payload.get('autoLoginEnabled', previous.get('autoLoginEnabled', True))),
  }


def load_tsinghua_auth_config() -> dict[str, Any] | None:
  if not AUTH_CONFIG_PATH.is_file():
    return None

  try:
    payload = json.loads(AUTH_CONFIG_PATH.read_text(encoding='utf-8'))
  except (OSError, json.JSONDecodeError) as exc:
    raise HTTPException(status_code=500, detail=f'Unable to read Tsinghua auth configuration: {exc}') from exc

  if not isinstance(payload, dict):
    raise HTTPException(status_code=500, detail='Tsinghua auth configuration is invalid.')
  return normalize_tsinghua_auth_config(payload)


def save_tsinghua_auth_config(payload: dict[str, Any]) -> dict[str, Any]:
  existing = load_tsinghua_auth_config()
  config = normalize_tsinghua_auth_config(payload, existing)
  if not config['username']:
    raise HTTPException(status_code=422, detail='Tsinghua username is required.')
  if not config['password']:
    raise HTTPException(status_code=422, detail='Tsinghua password is required.')

  CONFIG_DIR.mkdir(parents=True, exist_ok=True)
  temp_path = AUTH_CONFIG_PATH.with_suffix('.tmp')
  with _auth_lock:
    try:
      temp_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding='utf-8')
      temp_path.replace(AUTH_CONFIG_PATH)
    except OSError as exc:
      raise HTTPException(status_code=500, detail=f'Unable to save Tsinghua auth configuration: {exc}') from exc

  return config


def build_tsinghua_auth_public_config(config: dict[str, Any] | None) -> dict[str, Any]:
  if not config:
    return {
      'configured': False,
      'username': '',
      'hasPassword': False,
      'autoLoginEnabled': True,
    }

  return {
    'configured': bool(config.get('username') and config.get('password')),
    'username': _string(config.get('username')),
    'hasPassword': bool(_string(config.get('password'))),
    'autoLoginEnabled': bool(config.get('autoLoginEnabled', True)),
  }

