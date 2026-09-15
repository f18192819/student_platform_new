from __future__ import annotations

import hashlib
import html
import json
import mimetypes
import re
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import requests
from bs4 import BeautifulSoup
from fastapi import HTTPException


LEARN_BASE_URL = 'https://learn.tsinghua.edu.cn'
_LIST_ENDPOINTS = (
  ('pending', '/b/wlxt/kczy/zy/student/zyListWj'),
  ('submitted', '/b/wlxt/kczy/zy/student/zyListYjwg'),
  ('graded', '/b/wlxt/kczy/zy/student/zyListYpg'),
)
_DETAIL_PAGE_BY_STATE = {
  'pending': 'viewZy',
  'submitted': 'viewTj',
  'graded': 'viewCj',
}


def homework_download_id(wlkcid: str, assignment_id: str, attachment_id: str) -> str:
  stable = f'{wlkcid}\0{assignment_id}\0{attachment_id}'.encode('utf-8')
  return f'homework-{hashlib.sha256(stable).hexdigest()[:32]}'


def _session(cookies: list[dict[str, Any]]) -> requests.Session:
  session = requests.Session()
  session.headers.update({
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'User-Agent': 'Mozilla/5.0 StudentLearningPlatform/1.0',
  })
  for cookie in cookies:
    name = str(cookie.get('name') or '').strip()
    value = str(cookie.get('value') or '')
    if name:
      session.cookies.set(name, value, domain=str(cookie.get('domain') or '.tsinghua.edu.cn'))
  return session


def _csrf(cookies: list[dict[str, Any]]) -> str:
  return next(
    (str(item.get('value') or '').strip() for item in cookies if item.get('name') == 'XSRF-TOKEN'),
    '',
  )


def _referer(wlkcid: str) -> str:
  return f'{LEARN_BASE_URL}/f/wlxt/kczy/zy/student/beforePageList?wlkcid={wlkcid}'


def _ensure_json_response(response: requests.Response, label: str) -> dict[str, Any]:
  if response.status_code != 200:
    raise HTTPException(status_code=502, detail=f'{label}请求失败：HTTP {response.status_code}')
  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'{label}没有返回合法 JSON。') from exc
  if not isinstance(payload, dict) or payload.get('result') != 'success':
    raise HTTPException(status_code=502, detail=f'{label}返回了异常结果。')
  return payload


def _data_table_payload(wlkcid: str) -> str:
  return json.dumps([
    {'name': 'sEcho', 'value': 1},
    {'name': 'iDisplayStart', 'value': 0},
    {'name': 'iDisplayLength', 'value': 999},
    {'name': 'wlkcid', 'value': wlkcid},
  ], ensure_ascii=False)


def _assignment_rows(
  session: requests.Session,
  cookies: list[dict[str, Any]],
  wlkcid: str,
) -> list[dict[str, Any]]:
  csrf = _csrf(cookies)
  rows: list[dict[str, Any]] = []
  seen: set[str] = set()
  for state, endpoint in _LIST_ENDPOINTS:
    try:
      response = session.post(
        f'{LEARN_BASE_URL}{endpoint}',
        params={'_csrf': csrf} if csrf else {},
        data={'aoData': _data_table_payload(wlkcid)},
        headers={'Referer': _referer(wlkcid), 'X-Requested-With': 'XMLHttpRequest'},
        timeout=30,
      )
    except requests.RequestException as exc:
      raise HTTPException(status_code=502, detail=f'作业列表接口请求失败：{exc}') from exc
    payload = _ensure_json_response(response, '作业列表接口')
    table = payload.get('object')
    remote_rows = table.get('aaData') if isinstance(table, dict) else None
    if not isinstance(remote_rows, list):
      raise HTTPException(status_code=502, detail='作业列表接口返回结构异常。')
    for raw in remote_rows:
      if not isinstance(raw, dict):
        continue
      assignment_id = str(raw.get('zyid') or '').strip()
      if not assignment_id or assignment_id in seen:
        continue
      seen.add(assignment_id)
      rows.append({**raw, '_state': state})
  return rows


def _parse_byte_size(value: str) -> int:
  match = re.search(r'([0-9]+(?:\.[0-9]+)?)\s*(B|K|KB|M|MB|G|GB)?', value, re.I)
  if not match:
    return 0
  amount = float(match.group(1))
  unit = (match.group(2) or 'B').upper()
  multiplier = 1024 ** ({'B': 0, 'K': 1, 'KB': 1, 'M': 2, 'MB': 2, 'G': 3, 'GB': 3}.get(unit, 0))
  return int(amount * multiplier)


def _filename_from_disposition(response: requests.Response, fallback: str) -> str:
  disposition = str(response.headers.get('Content-Disposition') or '')
  encoded = re.search(r"filename\*=UTF-8''([^;]+)", disposition, re.I)
  plain = re.search(r'filename="?([^";]+)', disposition, re.I)
  value = unquote(encoded.group(1)) if encoded else (plain.group(1).strip() if plain else fallback)
  if not encoded:
    try:
      value = value.encode('latin-1').decode('utf-8')
    except (UnicodeEncodeError, UnicodeDecodeError):
      pass
  sanitized = re.sub(r'[<>:"/\\|?*]+', '_', value).strip()
  return sanitized or fallback


def _detail_description(
  session: requests.Session,
  cookies: list[dict[str, Any]],
  assignment_id: str,
  referer: str,
) -> str:
  try:
    response = session.post(
      f'{LEARN_BASE_URL}/b/wlxt/kczy/zy/student/detail',
      params={key: value for key, value in {'_csrf': _csrf(cookies), 'id': assignment_id}.items() if value},
      headers={'Referer': referer, 'X-Requested-With': 'XMLHttpRequest'},
      timeout=20,
    )
    payload = _ensure_json_response(response, '作业详情接口')
  except HTTPException:
    return ''
  markup = html.unescape(str(payload.get('msg') or ''))
  return BeautifulSoup(markup, 'html.parser').get_text('\n', strip=True)


def _detail_attachments(
  session: requests.Session,
  cookies: list[dict[str, Any]],
  wlkcid: str,
  row: dict[str, Any],
) -> tuple[list[dict[str, Any]], str]:
  assignment_id = str(row.get('zyid') or '').strip()
  student_assignment_id = str(row.get('xszyid') or '').strip()
  state = str(row.get('_state') or 'pending')
  view = _DETAIL_PAGE_BY_STATE.get(state, 'viewZy')
  query = f'wlkcid={wlkcid}&sfgq=0&zyid={assignment_id}'
  if student_assignment_id:
    query += f'&xszyid={student_assignment_id}'
  detail_url = f'{LEARN_BASE_URL}/f/wlxt/kczy/zy/student/{view}?{query}'
  try:
    response = session.get(detail_url, timeout=30)
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'作业详情页请求失败：{exc}') from exc
  if response.status_code != 200:
    raise HTTPException(status_code=502, detail=f'作业详情页请求失败：HTTP {response.status_code}')

  soup = BeautifulSoup(response.text, 'html.parser')
  # The first attachment section is the question attachment. Later sections may
  # contain the reference answer and must never be imported as a student prompt.
  question_section = soup.select_one('.detail .list.fujian')
  attachments: list[dict[str, Any]] = []
  if question_section is not None:
    for anchor in question_section.select('a[href]'):
      href = html.unescape(str(anchor.get('href') or '').strip())
      parsed = urlparse(href)
      if not parsed.path.startswith('/b/wlxt/kczy/zy/student/downloadFile/'):
        nested = (parse_qs(parsed.query).get('downloadUrl') or [''])[0]
        href = nested or href
      if not urlparse(href).path.startswith('/b/wlxt/kczy/zy/student/downloadFile/'):
        continue
      path = urlparse(href).path
      attachment_id = path.rstrip('/').split('/')[-1]
      if not attachment_id or any(item['attachmentId'] == attachment_id for item in attachments):
        continue
      filename = anchor.get_text(' ', strip=True)
      if not filename or filename in {'下载', 'download'}:
        filename = question_section.select_one('.ftitle').get_text(' ', strip=True) if question_section.select_one('.ftitle') else attachment_id
      size_node = question_section.select_one('.color_999')
      byte_size = _parse_byte_size(size_node.get_text(' ', strip=True) if size_node else '')
      mime_type = mimetypes.guess_type(filename)[0] or 'application/octet-stream'
      attachments.append({
        'attachmentId': attachment_id,
        'fileName': filename,
        'byteSize': byte_size,
        'mimeType': mime_type,
        'downloadPath': path,
      })
  return attachments, _detail_description(session, cookies, assignment_id, detail_url)


def fetch_homework_catalog(
  cookies: list[dict[str, Any]],
  *,
  course_name: str,
  course_code: str,
  wlkcid: str,
  semester_id: str,
  semester_name: str,
) -> list[dict[str, Any]]:
  if not wlkcid:
    raise HTTPException(status_code=422, detail='当前课程缺少 wlkcid，无法拉取作业。')
  session = _session(cookies)
  files: list[dict[str, Any]] = []
  for row in _assignment_rows(session, cookies, wlkcid):
    assignment_id = str(row.get('zyid') or '').strip()
    title = str(row.get('bt') or '未命名作业').strip()
    attachments, description = _detail_attachments(session, cookies, wlkcid, row)
    for attachment in attachments:
      attachment_id = str(attachment['attachmentId'])
      file_id = homework_download_id(wlkcid, assignment_id, attachment_id)
      files.append({
        'id': file_id,
        'resourceType': 'homework',
        'courseName': course_name,
        'courseCode': course_code,
        'wlkcid': wlkcid,
        'semesterId': semester_id,
        'semesterName': semester_name,
        'assignmentId': assignment_id,
        'studentAssignmentId': str(row.get('xszyid') or '').strip(),
        'assignmentTitle': title,
        'description': description,
        'dueAt': str(row.get('jzsjStr') or '').strip(),
        'state': str(row.get('_state') or ''),
        'fileName': attachment['fileName'],
        'displayName': f'{title} - {attachment["fileName"]}',
        'byteSize': attachment['byteSize'],
        'mimeType': attachment['mimeType'],
        'kind': 'pdf' if str(attachment['fileName']).lower().endswith('.pdf') else 'other',
        'downloadedAt': str(row.get('kssjStr') or '').strip(),
        'batchId': '',
        'downloadPath': attachment['downloadPath'],
      })
  return files


def download_homework_files(
  cookies: list[dict[str, Any]],
  catalog: list[dict[str, Any]],
  download_dir: Path,
  *,
  batch_id: str,
  requested_file_ids: set[str] | None = None,
  known_file_ids: set[str] | None = None,
  known_file_names: set[str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
  session = _session(cookies)
  csrf = _csrf(cookies)
  download_dir.mkdir(parents=True, exist_ok=True)
  downloaded: list[dict[str, Any]] = []
  skipped: list[dict[str, str]] = []
  for record in catalog:
    file_id = str(record.get('id') or '')
    file_name = str(record.get('fileName') or '')
    display_name = str(record.get('displayName') or '')
    if requested_file_ids is not None and file_id not in requested_file_ids:
      continue
    if known_file_ids and file_id in known_file_ids:
      continue
    if known_file_names and {
      name.casefold() for name in (file_name, display_name) if name
    }.intersection(known_file_names):
      skipped.append({'courseName': str(record.get('courseName') or ''), 'fileName': file_name, 'reason': '本地已保存同名作业，跳过下载。'})
      continue
    if record.get('kind') != 'pdf':
      skipped.append({'courseName': str(record.get('courseName') or ''), 'fileName': file_name, 'reason': '该作业附件不是 PDF，暂不支持导入题目库。'})
      continue
    path = str(record.get('downloadPath') or '')
    if not path.startswith('/b/wlxt/kczy/zy/student/downloadFile/'):
      skipped.append({'courseName': str(record.get('courseName') or ''), 'fileName': file_name, 'reason': '作业附件下载地址无效。'})
      continue
    try:
      response = session.get(
        f'{LEARN_BASE_URL}{path}',
        params={'_csrf': csrf} if csrf else {},
        headers={'Referer': _referer(str(record.get('wlkcid') or ''))},
        timeout=120,
        stream=True,
      )
    except requests.RequestException as exc:
      skipped.append({'courseName': str(record.get('courseName') or ''), 'fileName': file_name, 'reason': f'作业下载失败：{exc}'})
      continue
    content_type = str(response.headers.get('Content-Type') or '').lower()
    if response.status_code != 200 or 'text/html' in content_type or 'json' in content_type:
      skipped.append({'courseName': str(record.get('courseName') or ''), 'fileName': file_name, 'reason': f'作业下载接口返回异常：HTTP {response.status_code}'})
      continue
    resolved_name = _filename_from_disposition(response, file_name or f'{file_id}.pdf')
    target = download_dir / resolved_name
    suffix = 1
    while target.exists():
      target = download_dir / f'{Path(resolved_name).stem}_{suffix}{Path(resolved_name).suffix}'
      suffix += 1
    with target.open('wb') as handle:
      for chunk in response.iter_content(chunk_size=65536):
        if chunk:
          handle.write(chunk)
    downloaded.append({
      **record,
      'fileName': target.name,
      'byteSize': target.stat().st_size,
      'mimeType': content_type.split(';', 1)[0] or 'application/pdf',
      'batchId': batch_id,
      'path': str(target),
    })
  return downloaded, skipped


def public_homework_file(record: dict[str, Any]) -> dict[str, Any]:
  return {
    key: value
    for key, value in record.items()
    if key not in {'path', 'downloadPath'}
  }


__all__ = [
  'download_homework_files',
  'fetch_homework_catalog',
  'homework_download_id',
  'public_homework_file',
]
