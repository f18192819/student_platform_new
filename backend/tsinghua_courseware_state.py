from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from backend.config import PROJECT_ROOT


STATE_PATH = PROJECT_ROOT / '.runtime' / 'tsinghua-sync' / 'courseware-auto-sync.json'
_state_lock = threading.RLock()


def _normalize_file_name(value: Any) -> str:
  return str(value or '').strip().casefold()


def _default_state() -> dict[str, list[dict[str, str]]]:
  return {'suppressed': []}


def _read_state() -> dict[str, list[dict[str, str]]]:
  if not STATE_PATH.is_file():
    return _default_state()
  try:
    payload = json.loads(STATE_PATH.read_text(encoding='utf-8'))
  except Exception:
    return _default_state()
  suppressed = payload.get('suppressed') if isinstance(payload, dict) else None
  return {
    'suppressed': [item for item in suppressed if isinstance(item, dict)]
    if isinstance(suppressed, list)
    else [],
  }


def _write_state(state: dict[str, list[dict[str, str]]]) -> None:
  STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
  temporary_path = STATE_PATH.with_suffix('.tmp')
  temporary_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
  temporary_path.replace(STATE_PATH)


def load_suppressed_courseware() -> list[dict[str, str]]:
  with _state_lock:
    return [dict(item) for item in _read_state()['suppressed']]


def mark_deleted_synced_courseware(file_record: dict[str, Any] | None) -> None:
  """Persist a user deletion so automatic courseware sync never restores it."""
  if not isinstance(file_record, dict):
    return

  source_key = str(file_record.get('sourceKey') or '').strip()
  if not source_key.startswith('tsinghua-courseware:'):
    return

  course_id = str(file_record.get('courseId') or '').strip()
  file_name = _normalize_file_name(file_record.get('fileName'))
  marker = {
    'sourceKey': source_key,
    'courseId': course_id,
    'fileName': file_name,
    'deletedAt': datetime.now(timezone.utc).isoformat(),
  }

  with _state_lock:
    state = _read_state()
    state['suppressed'] = [
      item
      for item in state['suppressed']
      if str(item.get('sourceKey') or '') != source_key
      and not (
        course_id
        and file_name
        and str(item.get('courseId') or '') == course_id
        and _normalize_file_name(item.get('fileName')) == file_name
      )
    ]
    state['suppressed'].append(marker)
    _write_state(state)


def restore_deleted_synced_courseware(source_keys: list[str] | set[str]) -> None:
  """Remove suppression only after the user explicitly chooses to re-download."""
  normalized = {str(value or '').strip() for value in source_keys if str(value or '').strip()}
  if not normalized:
    return
  with _state_lock:
    state = _read_state()
    next_suppressed = [
      item for item in state['suppressed']
      if str(item.get('sourceKey') or '').strip() not in normalized
    ]
    if len(next_suppressed) == len(state['suppressed']):
      return
    state['suppressed'] = next_suppressed
    _write_state(state)
