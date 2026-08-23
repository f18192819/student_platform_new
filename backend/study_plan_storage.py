from __future__ import annotations

import json
import re
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from backend.config import PROJECT_ROOT

STUDY_PLAN_ROOT = PROJECT_ROOT / '.runtime' / 'study-plans'
_storage_lock = threading.RLock()
_SAFE_COURSE_ID = re.compile(r'[^A-Za-z0-9._-]+')
_RESOURCE_TYPES = {'lecture', 'homework', 'past-exam'}


def _now() -> str:
  return datetime.now(tz=timezone.utc).isoformat()


def _path(course_id: str) -> Path:
  normalized = str(course_id or '').strip()
  safe_id = _SAFE_COURSE_ID.sub('-', normalized).strip('.-')
  if not safe_id:
    raise HTTPException(status_code=422, detail='course_id is required.')
  STUDY_PLAN_ROOT.mkdir(parents=True, exist_ok=True)
  return STUDY_PLAN_ROOT / f'{safe_id}.json'


def _default_plan(course_id: str) -> dict[str, Any]:
  return {'courseId': course_id, 'items': [], 'updatedAt': _now()}


def _parse_datetime(value: Any, field: str) -> datetime:
  try:
    parsed = datetime.fromisoformat(str(value or '').replace('Z', '+00:00'))
  except ValueError as exc:
    raise HTTPException(status_code=422, detail=f'{field} must be an ISO date-time.') from exc
  return parsed


def _normalize_item(item: Any, index: int) -> dict[str, Any]:
  if not isinstance(item, dict):
    raise HTTPException(status_code=422, detail=f'items[{index}] must be an object.')
  start_at = str(item.get('startAt') or '').strip()
  end_at = str(item.get('endAt') or '').strip()
  start = _parse_datetime(start_at, f'items[{index}].startAt')
  end = _parse_datetime(end_at, f'items[{index}].endAt')
  if end <= start:
    raise HTTPException(status_code=422, detail='安排结束时间必须晚于开始时间。')
  if (end - start).total_seconds() > 12 * 60 * 60:
    raise HTTPException(status_code=422, detail='单个安排不能超过 12 小时。')

  resources = item.get('resources')
  if not isinstance(resources, list):
    raise HTTPException(status_code=422, detail=f'items[{index}].resources must be a list.')
  if len(resources) > 32:
    raise HTTPException(status_code=422, detail='单个安排最多选择 32 份资料。')
  normalized_resources = []
  for resource_index, resource in enumerate(resources):
    if not isinstance(resource, dict):
      raise HTTPException(status_code=422, detail=f'items[{index}].resources[{resource_index}] is invalid.')
    resource_id = str(resource.get('id') or '').strip()
    resource_type = str(resource.get('type') or '').strip()
    label = str(resource.get('label') or '').strip()
    if not resource_id or resource_type not in _RESOURCE_TYPES or not label:
      raise HTTPException(status_code=422, detail=f'items[{index}].resources[{resource_index}] is invalid.')
    course_id = str(resource.get('courseId') or '').strip()
    course_name = str(resource.get('courseName') or '').strip()
    normalized_resource = {'id': resource_id, 'type': resource_type, 'label': label[:240]}
    if course_id:
      normalized_resource['courseId'] = course_id[:160]
    if course_name:
      normalized_resource['courseName'] = course_name[:160]
    normalized_resources.append(normalized_resource)

  title = str(item.get('title') or '').strip()[:160]
  return {
    'id': str(item.get('id') or uuid.uuid4()),
    'title': title or '学习安排',
    'startAt': start_at,
    'endAt': end_at,
    'resources': normalized_resources,
    'createdAt': str(item.get('createdAt') or _now()),
    'updatedAt': _now(),
  }


def read_course_study_plan(course_id: str) -> dict[str, Any]:
  path = _path(course_id)
  with _storage_lock:
    if not path.is_file():
      return _default_plan(course_id)
    try:
      payload = json.loads(path.read_text(encoding='utf-8'))
    except Exception as exc:  # noqa: BLE001
      raise HTTPException(status_code=500, detail=f'Failed to read study plan: {exc}') from exc
  if not isinstance(payload, dict):
    return _default_plan(course_id)
  items = payload.get('items') if isinstance(payload.get('items'), list) else []
  return {
    'courseId': str(payload.get('courseId') or course_id),
    'items': items,
    'updatedAt': str(payload.get('updatedAt') or _now()),
  }


def write_course_study_plan(course_id: str, payload: dict[str, Any]) -> dict[str, Any]:
  raw_items = payload.get('items') if isinstance(payload, dict) else None
  if not isinstance(raw_items, list):
    raise HTTPException(status_code=422, detail='items must be a list.')
  if len(raw_items) > 300:
    raise HTTPException(status_code=422, detail='单门课程最多保存 300 个安排。')
  normalized_items = [_normalize_item(item, index) for index, item in enumerate(raw_items)]
  normalized_items.sort(key=lambda item: (item['startAt'], item['endAt'], item['id']))
  result = {'courseId': course_id, 'items': normalized_items, 'updatedAt': _now()}
  path = _path(course_id)
  temporary = path.with_suffix('.tmp')
  with _storage_lock:
    temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)
  return result
