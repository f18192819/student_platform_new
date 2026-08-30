from __future__ import annotations

import html
import hashlib
import shutil
import time
import json
import subprocess
import mimetypes
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse, quote, unquote
import re

import requests

from bs4 import BeautifulSoup
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse
from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

from .tsinghua_auth_config import (
  build_tsinghua_auth_public_config,
  load_tsinghua_auth_config,
  save_tsinghua_auth_config,
)
from .config import PROJECT_ROOT
from . import tsinghua_sync_state as sync_state
from .tsinghua_courseware_state import (
  load_suppressed_courseware,
  restore_deleted_synced_courseware,
)
from .knowledge_storage import restore_knowledge_file_source_keys

COURSE_HOME_URL = 'https://learn.tsinghua.edu.cn/f/wlxt/index/course/student'
LEARN_HOST = 'learn.tsinghua.edu.cn'
LOGIN_HOST = 'id.tsinghua.edu.cn'
SYNC_RUNTIME_DIR = PROJECT_ROOT / '.runtime' / 'tsinghua-sync'
SYNC_RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
COOKIE_STORE_PATH = SYNC_RUNTIME_DIR / 'learn-cookies.json'

tsinghua_router = APIRouter(prefix='/api/tsinghua-sync', tags=['tsinghua-sync'])


def _utc_now() -> str:
  return time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime())


def _normalize_text(value: Any) -> str:
  if not isinstance(value, str):
    return ''
  return ' '.join(value.split()).strip()


def _courseware_download_id(course_wlkcid: str, wjid: str) -> str:
  stable_key = f'{_normalize_text(course_wlkcid)}|{_normalize_text(wjid)}'.encode('utf-8')
  return f'courseware-{hashlib.sha256(stable_key).hexdigest()[:32]}'


def _courseware_file_name_key(value: Any) -> str:
  """Compare a courseware title even when an Office file was stored as PDF."""
  normalized = _normalize_text(str(value or '')).casefold()
  suffix = Path(normalized).suffix
  return normalized[:-len(suffix)] if suffix and len(suffix) <= 12 else normalized


def _resolve_absolute_url(raw_url: str) -> str:
  value = _normalize_text(raw_url)
  if not value:
    return ''
  if value.startswith('http://') or value.startswith('https://'):
    return value
  if value.startswith('/'):
    return f'https://{LEARN_HOST}{value}'
  return value


def _looks_like_course_name(text: str) -> bool:
  normalized = _normalize_text(text)
  return 2 <= len(normalized) <= 120


def _load_persisted_cookies() -> list[dict[str, Any]]:
  if not COOKIE_STORE_PATH.is_file():
    return []
  try:
    payload = json.loads(COOKIE_STORE_PATH.read_text(encoding='utf-8'))
  except Exception:
    return []
  if not isinstance(payload, list):
    return []
  return [item for item in payload if isinstance(item, dict)]


def _persist_cookies(driver: webdriver.Chrome) -> None:
  try:
    current_url = driver.current_url
  except Exception:
    return
  if LEARN_HOST not in current_url:
    return

  try:
    cookies = driver.get_cookies()
  except Exception:
    return

  sanitized: list[dict[str, Any]] = []
  for cookie in cookies:
    if not isinstance(cookie, dict):
      continue
    domain = _normalize_text(cookie.get('domain'))
    if LEARN_HOST not in domain and not domain.endswith('.tsinghua.edu.cn'):
      continue
    next_cookie = {
      key: value
      for key, value in cookie.items()
      if key in {'name', 'value', 'domain', 'path', 'expiry', 'secure', 'httpOnly', 'sameSite'}
    }
    if _normalize_text(next_cookie.get('name')) and 'value' in next_cookie:
      sanitized.append(next_cookie)

  if sanitized:
    COOKIE_STORE_PATH.write_text(
      json.dumps(sanitized, ensure_ascii=False, indent=2),
      encoding='utf-8',
    )


def _restore_cookies(driver: webdriver.Chrome) -> bool:
  cookies = _load_persisted_cookies()
  if not cookies:
    return False

  restored = False
  for cookie in cookies:
    try:
      driver.add_cookie(cookie)
      restored = True
    except Exception:
      continue
  return restored


def _find_first_term_panel(root: BeautifulSoup) -> Any | None:
  selectors = (
    '.paicbq3ow.paicbq3ow1',
    '.paicbq3ow1',
    '.paicbq3ow',
  )
  for selector in selectors:
    panels = root.select(selector)
    for panel in panels:
      if panel.select_one('#selfcourse .hdtitle a.title, .hdtitle a.title'):
        return panel
  return None


def _is_sso_login_page(driver: webdriver.Chrome) -> bool:
  try:
    return bool(driver.find_elements(By.CSS_SELECTOR, '#i_user, input[name="i_user"]'))
  except Exception:
    return False


def _is_learn_login_page(driver: webdriver.Chrome) -> bool:
  try:
    current_url = driver.current_url.lower()
  except Exception:
    current_url = ''
  if '/f/login' in current_url:
    return True
  try:
    return bool(driver.find_elements(By.CSS_SELECTOR, '#loginButtonId'))
  except Exception:
    return False


def _has_relogin_entry(driver: webdriver.Chrome) -> bool:
  try:
    return bool(
      driver.find_elements(
        By.CSS_SELECTOR,
        'a.chongxin, .re_log a.chongxin, a[onclick*="top.document.location"]',
      )
    )
  except Exception:
    return False


def _wait_for_login_surface(driver: webdriver.Chrome, timeout_seconds: float = 10.0) -> None:
  deadline = time.time() + timeout_seconds
  while time.time() < deadline:
    if _is_sso_login_page(driver) or _is_learn_login_page(driver) or _has_relogin_entry(driver):
      return
    try:
      current_url = driver.current_url.lower()
      page_source = driver.page_source
      title = driver.title
    except Exception:
      time.sleep(0.35)
      continue
    if _guess_stage(current_url, title, page_source) == 'ready':
      return
    time.sleep(0.35)


def _open_login_entry_if_needed(driver: webdriver.Chrome) -> None:
  _wait_for_login_surface(driver, 8)
  for _attempt in range(3):
    try:
      relogin_candidates = driver.find_elements(
        By.CSS_SELECTOR,
        'a.chongxin, .re_log a.chongxin, a[onclick*="top.document.location"]',
      )
      if relogin_candidates:
        previous_url = driver.current_url
        try:
          relogin_candidates[0].click()
        except Exception:
          driver.execute_script("arguments[0].click();", relogin_candidates[0])
        try:
          WebDriverWait(driver, 4).until(lambda current: current.current_url != previous_url)
        except Exception:
          pass
        continue
    except Exception:
      pass

    try:
      login_button = driver.find_elements(By.CSS_SELECTOR, '#loginButtonId')
      if login_button:
        previous_url = driver.current_url
        target = driver.execute_script(
          r"""
          const button = document.querySelector('#loginButtonId');
          if (!button) {
            return '';
          }
          const onclickValue = button.getAttribute('onclick') || '';
          const matched = onclickValue.match(/window\.location\.href=['"]([^'"]+)['"]/);
          return matched ? matched[1] : '';
          """
        )
        try:
          login_button[0].click()
        except Exception:
          driver.execute_script("arguments[0].click();", login_button[0])
        target_url = _normalize_text(target)
        try:
          WebDriverWait(driver, 4).until(lambda current: current.current_url != previous_url)
        except Exception:
          if target_url and target_url != previous_url:
            driver.get(target_url)
        if LOGIN_HOST in driver.current_url or _is_sso_login_page(driver):
          return
    except Exception:
      pass

    if LOGIN_HOST in driver.current_url or _is_sso_login_page(driver):
      return
    time.sleep(0.4)

  try:
    login_button = WebDriverWait(driver, 5).until(
      lambda current: current.find_elements(By.CSS_SELECTOR, '#loginButtonId')
    )
    if login_button:
      previous_url = driver.current_url
      target = driver.execute_script(
        r"""
        const button = document.querySelector('#loginButtonId');
        if (!button) {
          return '';
        }
        const onclickValue = button.getAttribute('onclick') || '';
        const matched = onclickValue.match(/window\.location\.href=['"]([^'"]+)['"]/);
        return matched ? matched[1] : '';
        """
      )
      try:
        login_button[0].click()
      except Exception:
        driver.execute_script("arguments[0].click();", login_button[0])
      target_url = _normalize_text(target)
      try:
        WebDriverWait(driver, 4).until(lambda current: current.current_url != previous_url)
      except Exception:
        if target_url and target_url != previous_url:
          driver.get(target_url)
      return
  except Exception:
    pass

  try:
    relogin_candidates = driver.find_elements(
      By.XPATH,
      "//a[contains(., '重新登录') or contains(., '登录')]",
    )
    if relogin_candidates:
      relogin_candidates[0].click()
    return
  except Exception:
    pass


def _maybe_auto_login(driver: webdriver.Chrome) -> bool:
  config = load_tsinghua_auth_config()
  if not config or not config.get('autoLoginEnabled'):
    return False

  username = _normalize_text(config.get('username'))
  password = str(config.get('password') or '')
  if not username or not password:
    return False

  _wait_for_login_surface(driver, 8)

  if _is_learn_login_page(driver) or _has_relogin_entry(driver):
    _open_login_entry_if_needed(driver)
    try:
      WebDriverWait(driver, 8).until(
        lambda current: LOGIN_HOST in current.current_url or _is_sso_login_page(current),
      )
    except Exception:
      if _is_learn_login_page(driver) or _has_relogin_entry(driver):
        _open_login_entry_if_needed(driver)
      try:
        WebDriverWait(driver, 5).until(
          lambda current: LOGIN_HOST in current.current_url or _is_sso_login_page(current),
        )
      except Exception:
        return False
  elif LOGIN_HOST not in driver.current_url and not _is_sso_login_page(driver):
    return False

  if not _is_sso_login_page(driver):
    return False

  try:
    username_input = WebDriverWait(driver, 8).until(
      EC.presence_of_element_located((By.CSS_SELECTOR, '#i_user, input[name="i_user"]')),
    )
    password_input = driver.find_element(By.CSS_SELECTOR, '#i_pass')
  except Exception:
    return False

  try:
    username_input.clear()
    username_input.send_keys(username)
    password_input.clear()
    password_input.send_keys(password)

    submit_buttons = driver.find_elements(
      By.CSS_SELECTOR,
      'a.btn.btn-lg.btn-primary.btn-block, button[type="submit"], input[type="submit"]',
    )
    if submit_buttons:
      submit_buttons[0].click()
    else:
      driver.execute_script(
        "if (typeof doLogin === 'function') { doLogin(); }",
      )
    return True
  except Exception:
    return False


def _dedupe_courses(courses: list[dict[str, str]]) -> list[dict[str, str]]:
  deduped: dict[str, dict[str, str]] = {}
  for course in courses:
    name = _normalize_text(course.get('name'))
    if not _looks_like_course_name(name):
      continue
    href = _resolve_absolute_url(course.get('href', ''))
    key = name.casefold()
    existing = deduped.get(key)
    if not existing:
      deduped[key] = {'name': name, 'href': href}
      continue
    if not existing.get('href') and href:
      existing['href'] = href
  return list(deduped.values())


def _extract_current_term_courses_from_html(page_source: str) -> list[dict[str, str]]:
  if not page_source.strip():
    return []

  soup = BeautifulSoup(page_source, 'html.parser')
  panel = _find_first_term_panel(soup)
  if panel is None:
    return []

  courses: list[dict[str, str]] = []
  for anchor in panel.select('#selfcourse .hdtitle a.title, .hdtitle a.title'):
    name = _normalize_text(anchor.get('title') or anchor.get_text(' ', strip=True))
    href = _normalize_text(anchor.get('href'))
    if not _looks_like_course_name(name):
      continue
    courses.append({'name': name, 'href': href})

  return _dedupe_courses(courses)


def _extract_current_term_courses_from_dom(driver: webdriver.Chrome) -> list[dict[str, str]]:
  try:
    raw_courses = driver.execute_script(
      """
      const panelSelectors = [
        '.paicbq3ow.paicbq3ow1',
        '.paicbq3ow1',
        '.paicbq3ow',
      ];

      const isVisible = (element) => {
        if (!element) return false;
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };

      let panel = null;
      for (const selector of panelSelectors) {
        const panels = Array.from(document.querySelectorAll(selector));
        panel = panels.find((item) => item.querySelector('#selfcourse .hdtitle a.title, .hdtitle a.title'));
        if (panel) break;
      }

      if (!panel) {
        return [];
      }

      const anchors = Array.from(panel.querySelectorAll('#selfcourse .hdtitle a.title, .hdtitle a.title'));
      return anchors.map((anchor) => ({
        name: (anchor.getAttribute('title') || anchor.textContent || '').replace(/\\s+/g, ' ').trim(),
        href: anchor.getAttribute('href') || '',
        visible: isVisible(anchor) && isVisible(panel),
      }));
      """
    )
  except Exception:
    return []

  if not isinstance(raw_courses, list):
    return []

  courses: list[dict[str, str]] = []
  for item in raw_courses:
    if not isinstance(item, dict):
      continue
    if item.get('visible') is False:
      continue
    name = _normalize_text(item.get('name'))
    href = _normalize_text(item.get('href'))
    if not _looks_like_course_name(name):
      continue
    courses.append({'name': name, 'href': href})

  return _dedupe_courses(courses)


def _extract_current_term_course_material_entries(driver: webdriver.Chrome) -> list[dict[str, str]]:
  try:
    raw_entries = driver.execute_script(
      """
      // 真实结构：div#selfcourse > div.item，每个 .item 内含
      //   div.hdtitle > a.title（课程名）+ input.wlkcid
      //   ul.state > li > a.uuuhhh > span.name.kejian（课件入口）
      const container =
        document.querySelector('#selfcourse') ||
        document.querySelector('.paicbq3ow1 #selfcourse') ||
        document.querySelector('.paicbq3ow #selfcourse');
      if (!container) {
        return [];
      }

      const items = Array.from(container.querySelectorAll('.item'));
      return items
        .map((item) => {
          const titleAnchor = item.querySelector('.hdtitle a.title');
          if (!titleAnchor) {
            return null;
          }
          const wlkcidInput = item.querySelector('input.wlkcid');
          const wlkcid = wlkcidInput ? (wlkcidInput.value || '').trim() : '';
          const kejianLabel = item.querySelector('span.name.kejian');
          const kejianAnchor = kejianLabel ? kejianLabel.closest('a') : null;
          let coursewareHref = kejianAnchor ? (kejianAnchor.getAttribute('href') || '') : '';
          // 课件入口缺失时，用 wlkcid 兜底构造课件列表页 URL。
          if (!coursewareHref && wlkcid) {
            coursewareHref = `/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=${wlkcid}&sfgk=0`;
          }
          return {
            name: (titleAnchor.getAttribute('title') || titleAnchor.textContent || '').replace(/\\s+/g, ' ').trim(),
            href: titleAnchor.getAttribute('href') || '',
            wlkcid: wlkcid,
            coursewareHref: coursewareHref,
          };
        })
        .filter(Boolean);
      """
    )
  except Exception:
    return []

  entries: list[dict[str, str]] = []
  if not isinstance(raw_entries, list):
    return entries

  seen = set()
  for item in raw_entries:
    if not isinstance(item, dict):
      continue
    name = _normalize_text(item.get('name'))
    href = _resolve_absolute_url(str(item.get('href') or ''))
    courseware_href = _resolve_absolute_url(str(item.get('coursewareHref') or ''))
    wlkcid = _normalize_text(str(item.get('wlkcid') or ''))
    if not _looks_like_course_name(name):
      continue
    key = name.casefold()
    if key in seen:
      continue
    seen.add(key)
    entries.append(
      {
        'name': name,
        'href': href,
        'wlkcid': wlkcid,
        'coursewareHref': courseware_href,
      }
    )
  return entries


def _extract_current_term_course_material_entries_from_html(page_source: str) -> list[dict[str, str]]:
  if not page_source.strip():
    return []

  soup = BeautifulSoup(page_source, 'html.parser')
  panel = _find_first_term_panel(soup)
  if panel is None:
    return []

  entries: list[dict[str, str]] = []
  seen: set[str] = set()

  for item in panel.select('#selfcourse .item, .item'):
    title_anchor = item.select_one('.hdtitle a.title')
    if title_anchor is None:
      continue
    name = _normalize_text(title_anchor.get('title') or title_anchor.get_text(' ', strip=True))
    href = _resolve_absolute_url(title_anchor.get('href') or '')
    wlkcid_input = item.select_one('input.wlkcid')
    wlkcid = _normalize_text(wlkcid_input.get('value') if wlkcid_input is not None else '')
    kejian_label = item.select_one('span.name.kejian')
    kejian_anchor = kejian_label.find_parent('a') if kejian_label is not None else None
    courseware_href = _resolve_absolute_url(kejian_anchor.get('href') if kejian_anchor is not None else '')
    if not courseware_href and wlkcid:
      courseware_href = _build_courseware_list_referer(wlkcid)
    if not _looks_like_course_name(name):
      continue
    key = name.casefold()
    if key in seen:
      continue
    seen.add(key)
    entries.append(
      {
        'name': name,
        'href': href,
        'wlkcid': wlkcid,
        'coursewareHref': courseware_href,
      }
    )

  return entries


def _guess_courseware_kind(file_name: str, mime_type: str) -> str:
  normalized_name = file_name.lower()
  normalized_mime = mime_type.lower()
  if normalized_name.endswith(('.zip', '.rar', '.7z', '.tar', '.gz')):
    return 'archive'
  if any(token in normalized_mime for token in ('zip', 'rar', '7z', 'x-tar', 'gzip', 'compressed')):
    return 'archive'
  if normalized_name.endswith('.pdf') or normalized_mime == 'application/pdf':
    return 'pdf'
  if normalized_name.endswith(('.ppt', '.pptx', '.doc', '.docx')):
    return 'office'
  if any(token in normalized_mime for token in ('presentation', 'ms-powerpoint', 'msword', 'wordprocessingml')):
    return 'office'
  return 'other'


def _configure_download_dir(driver: webdriver.Chrome, download_dir: Path) -> None:
  download_dir.mkdir(parents=True, exist_ok=True)
  try:
    driver.execute_cdp_cmd(
      'Page.setDownloadBehavior',
      {
        'behavior': 'allow',
        'downloadPath': str(download_dir),
      },
    )
  except Exception as exc:
    raise HTTPException(status_code=500, detail=f'无法配置课件下载目录: {exc}') from exc


def _coerce_int(value: Any, fallback: int = 0) -> int:
  if isinstance(value, bool):
    return fallback
  if isinstance(value, int):
    return value
  if isinstance(value, float):
    return int(value)
  if isinstance(value, str):
    normalized = value.replace(',', '').strip()
    if normalized.isdigit():
      try:
        return int(normalized)
      except Exception:
        return fallback
  return fallback


def _decode_courseware_text(value: Any) -> str:
  if isinstance(value, str):
    return _normalize_text(html.unescape(value.replace('\xa0', ' ')))
  return ''


def _extract_wlkcid_from_course_entry(course_entry: dict[str, str]) -> str:
  direct = _normalize_text(course_entry.get('wlkcid'))
  if direct:
    return direct
  courseware_href = _resolve_absolute_url(str(course_entry.get('coursewareHref') or ''))
  if not courseware_href:
    return ''
  try:
    parsed = urlparse(courseware_href)
    query = parse_qs(parsed.query)
  except Exception:
    return ''
  return _normalize_text((query.get('wlkcid') or [''])[0])


def _build_courseware_list_referer(wlkcid: str) -> str:
  return f'https://{LEARN_HOST}/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid={wlkcid}&sfgk=0'


def _extract_xsrf_token(driver: webdriver.Chrome) -> str:
  try:
    for cookie in driver.get_cookies():
      if _normalize_text(cookie.get('name')) == 'XSRF-TOKEN':
        return str(cookie.get('value') or '').strip()
  except Exception:
    return ''
  return ''


def _looks_like_login_or_error_page(response: requests.Response) -> bool:
  content_type = _normalize_text(response.headers.get('Content-Type', '')).lower()
  if 'text/html' not in content_type:
    return False
  try:
    sample = response.text[:2000].lower()
  except Exception:
    return True
  return any(
    token in sample
    for token in (
      're_log',
      'closecurrentpage',
      'log_fail.png',
      '未登录',
      '登录失效',
      '登录超时',
      '重新登录',
      '404',
    )
  )


def _is_download_response(response: requests.Response) -> bool:
  content_type = _normalize_text(response.headers.get('Content-Type', '')).lower()
  if 'text/html' in content_type or 'application/json' in content_type or '/json' in content_type:
    return False
  return True


def _parse_courseware_api_item(item: Any, fallback_wlkcid: str) -> dict[str, Any] | None:
  if isinstance(item, dict):
    display_name = _decode_courseware_text(
      item.get('bt')
      or item.get('displayName')
      or item.get('mc')
      or item.get('title')
      or item.get('wjmc')
    )
    ext = _normalize_text(
      item.get('fileType')
      or item.get('suffix')
      or item.get('gs')
      or item.get('wjgs')
      or item.get('ext')
    ).lstrip('.')
    wjid = _normalize_text(
      item.get('wjid')
      or item.get('fileId')
      or item.get('resourceId')
      or item.get('downloadId')
      or item.get('id')
    )
    if not display_name or not wjid:
      return None
    byte_size = _coerce_int(item.get('wjdx') or item.get('fileSize') or item.get('size') or item.get('dx'))
    downloaded_at = _normalize_text(
      item.get('scsj')
      or item.get('gxsj')
      or item.get('fbsj')
      or item.get('createTime')
      or item.get('publishTime')
    )
    record_id = _normalize_text(item.get('id') or item.get('remoteId') or wjid)
    wlkcid = _normalize_text(item.get('wlkcid') or fallback_wlkcid)
    fallback_name = display_name
    if ext and not fallback_name.lower().endswith(f'.{ext.lower()}'):
      fallback_name = f'{fallback_name}.{ext}'
    return {
      'recordId': record_id or wjid,
      'displayName': display_name,
      'fallbackName': fallback_name,
      'wjid': wjid,
      'wlkcid': wlkcid,
      'byteSize': byte_size,
      'updatedAt': downloaded_at,
      'extension': ext.lower(),
    }

  if isinstance(item, list):
    if len(item) < 8:
      return None
    display_name = _decode_courseware_text(item[1] if len(item) > 1 else '')
    wjid = _normalize_text(item[7] if len(item) > 7 else '')
    ext = _normalize_text(item[13] if len(item) > 13 else '').lstrip('.')
    record_id = _normalize_text(item[0] if len(item) > 0 else '') or wjid
    wlkcid = _normalize_text(item[4] if len(item) > 4 else '') or fallback_wlkcid
    byte_size = _coerce_int(item[9] if len(item) > 9 else 0)
    downloaded_at = _normalize_text(item[10] if len(item) > 10 else '') or _normalize_text(item[6] if len(item) > 6 else '')
    if not display_name or not wjid:
      return None
    fallback_name = display_name
    if ext and not fallback_name.lower().endswith(f'.{ext.lower()}'):
      fallback_name = f'{fallback_name}.{ext}'
    return {
      'recordId': record_id,
      'displayName': display_name,
      'fallbackName': fallback_name,
      'wjid': wjid,
      'wlkcid': wlkcid,
      'byteSize': byte_size,
      'updatedAt': downloaded_at,
      'extension': ext.lower(),
    }

  return None


def _fetch_courseware_entries_via_api(
  driver: webdriver.Chrome,
  course_entry: dict[str, str],
) -> list[dict[str, Any]]:
  wlkcid = _extract_wlkcid_from_course_entry(course_entry)
  if not wlkcid:
    raise HTTPException(status_code=422, detail='当前课程缺少 wlkcid，无法通过接口拉取课件列表。')

  http_session = _build_requests_session_from_driver(driver)
  csrf_token = _extract_xsrf_token(driver)
  http_session.headers.update(
    {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': _build_courseware_list_referer(wlkcid),
    }
  )

  params = {
    'size': '999',
    'wlkcid': wlkcid,
  }
  if csrf_token:
    params['_csrf'] = csrf_token

  url = f'https://{LEARN_HOST}/b/wlxt/kj/wlkc_kjxxb/student/kjxxbByWlkcidAndSizeForStudent'
  try:
    response = http_session.get(url, params=params, timeout=30)
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'课件列表接口请求失败: {exc}') from exc

  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    raise HTTPException(
      status_code=502,
      detail='课件列表接口返回了登录页或错误页，请重新登录网络学堂后重试。',
    )

  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'课件列表接口未返回合法 JSON: {exc}') from exc

  raw_items = payload.get('object') if isinstance(payload, dict) else None
  if not isinstance(raw_items, list):
    raise HTTPException(status_code=502, detail='课件列表接口返回结构异常，未找到 object 数组。')

  records: list[dict[str, Any]] = []
  seen_wjid: set[str] = set()
  for raw_item in raw_items:
    parsed = _parse_courseware_api_item(raw_item, wlkcid)
    if not parsed:
      continue
    wjid = str(parsed.get('wjid') or '')
    if not wjid or wjid in seen_wjid:
      continue
    seen_wjid.add(wjid)
    records.append(parsed)
  return records


def _click_material_tab_if_present(driver: webdriver.Chrome, title: str) -> None:
  try:
    driver.execute_script(
      """
      const targetText = arguments[0];
      const candidates = Array.from(
        document.querySelectorAll('a, button, li, span')
      );
      const target = candidates.find((node) => {
        const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text !== targetText) {
          return false;
        }
        return !!node.closest('.tabtitle, .tab, .tabs, .nav');
      });
      if (target) {
        target.click();
      }
      """,
      title,
    )
  except Exception:
    return


def _wait_for_material_rows(driver: webdriver.Chrome, timeout_seconds: float = 15.0) -> list[Any]:
  deadline = time.time() + timeout_seconds
  last_rows: list[Any] = []
  while time.time() < deadline:
    try:
      # 真实结构：课件列表通过 AJAX 渲染到 .playli，每个文件是
      #   <ul><li wjid="..." kjbt="..." ...><a class="titlink">...</a>
      #       <div class="adacaouzo"><a class="btn" onclick="downloadkj('...')">下载</a></div></li></ul>
      candidates = driver.find_elements(
        By.CSS_SELECTOR,
        '.playli li[wjid], .playli ul li, ul#filelis > li',
      )
    except Exception:
      candidates = []
    filtered_rows: list[Any] = []
    for row in candidates:
      try:
        has_title = bool(row.find_elements(By.CSS_SELECTOR, 'a.titlink, .titlink, .spancolor'))
        has_download = bool(
          row.find_elements(
            By.CSS_SELECTOR,
            'a.btn[onclick*="downloadkj"], a.btn[onclick*="download"], .downLoadFile, .icon-download',
          )
        )
      except Exception:
        continue
      if has_title and has_download:
        filtered_rows.append(row)
    last_rows = filtered_rows
    if last_rows:
      return last_rows
    time.sleep(0.4)
  return last_rows


def _switch_to_newest_window_if_needed(
  driver: webdriver.Chrome,
  previous_handles: list[str],
  timeout_seconds: float = 5.0,
) -> bool:
  previous = set(previous_handles)
  deadline = time.time() + timeout_seconds
  while time.time() < deadline:
    try:
      current_handles = driver.window_handles
    except Exception:
      time.sleep(0.25)
      continue
    new_handles = [handle for handle in current_handles if handle not in previous]
    if new_handles:
      driver.switch_to.window(new_handles[-1])
      return True
    time.sleep(0.25)
  return False


def _find_download_trigger(row: Any) -> Any | None:
  # 课件下载按钮：<a class="btn" onclick="downloadkj('wjid')"><i class="... downLoadFile icon-download">...
  # 注意“收藏/备注”等按钮也是 a.btn 且含 .tipss2，不能用图标计数判断，必须按 onclick 精确匹配。
  try:
    anchors = row.find_elements(By.CSS_SELECTOR, 'a[onclick*="downloadkj"]')
  except Exception:
    anchors = []
  if anchors:
    return anchors[0]

  # 兜底：含 downLoadFile / icon-download 图标的 <a>。
  try:
    icon_nodes = row.find_elements(By.CSS_SELECTOR, '.downLoadFile, .icon-download')
  except Exception:
    icon_nodes = []

  for icon in icon_nodes:
    try:
      return icon.find_element(By.XPATH, './ancestor::a[1]')
    except Exception:
      continue

  return None


def _wait_for_downloaded_file(
  download_dir: Path,
  existing_names: set[str],
  timeout_seconds: float = 60.0,
) -> Path:
  deadline = time.time() + timeout_seconds
  while time.time() < deadline:
    if any(download_dir.glob('*.crdownload')):
      time.sleep(0.5)
      continue
    candidates = [
      candidate
      for candidate in download_dir.iterdir()
      if candidate.is_file() and candidate.suffix.lower() != '.crdownload'
    ]
    candidates.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    for candidate in candidates:
      if candidate.name not in existing_names:
        return candidate
    time.sleep(0.5)
  raise HTTPException(status_code=504, detail='等待网络学堂课件下载完成超时。')


def _build_requests_session_from_driver(driver: webdriver.Chrome) -> requests.Session:
  session = requests.Session()
  session.headers.update(
    {
      'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      ),
      'Referer': f'https://{LEARN_HOST}/',
    }
  )
  try:
    for cookie in driver.get_cookies():
      name = cookie.get('name')
      value = cookie.get('value')
      if name is None or value is None:
        continue
      session.cookies.set(
        name,
        value,
        domain=cookie.get('domain', LEARN_HOST).lstrip('.'),
        path=cookie.get('path', '/'),
      )
  except Exception as exc:  # noqa: BLE001
    raise HTTPException(status_code=500, detail=f'读取浏览器登录态失败: {exc}') from exc
  return session


def _guess_filename_from_response(response: requests.Response, wjid: str) -> str:
  def _clean_name(value: str) -> str:
    normalized = Path(value).name.strip().strip('"\'' ).strip()
    normalized = re.sub(r'[<>:"/\\|?*]+', '_', normalized)
    return normalized or wjid

  def _extension_from_type(content_type: str) -> str:
    normalized = content_type.split(';', 1)[0].strip().lower()
    explicit = {
      'application/pdf': '.pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
      'application/vnd.ms-powerpoint': '.ppt',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/msword': '.doc',
      'application/zip': '.zip',
    }
    if normalized in explicit:
      return explicit[normalized]
    guessed = mimetypes.guess_extension(normalized) or ''
    return guessed

  content_disposition = response.headers.get('Content-Disposition', '')
  match = re.search(r"filename\*?=['\"]?(?:UTF-8''|GBK''|utf-8'')?([^\"';]+)", content_disposition, re.IGNORECASE)
  if match:
    raw = unquote(match.group(1).strip())
    return _clean_name(raw)
  if content_disposition:
    simple = re.search(r'filename="?([^";]+)"?', content_disposition, re.IGNORECASE)
    if simple:
      return _clean_name(unquote(simple.group(1).strip()))
  url_path = urlparse(response.url).path
  guessed = _clean_name(Path(url_path).name or wjid)
  if Path(guessed).suffix:
    return guessed
  extension = _extension_from_type(response.headers.get('Content-Type', ''))
  return f'{guessed}{extension}' if extension else guessed


def _download_courseware_file_via_http(
  driver: webdriver.Chrome,
  wjid: str,
  download_dir: Path,
  fallback_name: str = '',
  referer: str = '',
) -> Path:
  # 直接复用浏览器登录态走 HTTP 下载，绕开脆弱的 downloadkj(点击 -> AJAX -> window.location) 链路。
  http_session = _build_requests_session_from_driver(driver)

  csrf_token = _extract_xsrf_token(driver)
  if referer:
    http_session.headers['Referer'] = referer

  base = f'https://{LEARN_HOST}'
  before_url = f'{base}/b/wlxt/kj/wlkc_kjxxb/student/downloadFileBefore'
  file_url = f'{base}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile'

  try:
    before_resp = http_session.get(before_url, params={'wjid': wjid}, timeout=30)
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'课件预下载请求失败: {exc}') from exc

  before_ok = False
  try:
    before_json = before_resp.json()
    before_ok = str(before_json.get('result', '')).lower() == 'success'
  except Exception:
    before_ok = False
  if not before_ok:
    # 部分课件 downloadFileBefore 不返回 success 也仍可下载，仅记录、继续尝试实际下载。
    pass

  params = {'sfgk': '0', 'wjid': wjid}
  if csrf_token:
    params['_csrf'] = csrf_token

  try:
    file_resp = http_session.get(file_url, params=params, timeout=120, stream=True)
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'课件下载请求失败: {exc}') from exc

  if file_resp.status_code != 200:
    raise HTTPException(
      status_code=502,
      detail=f'课件下载失败 (HTTP {file_resp.status_code})，可能登录态已失效或无权访问该文件。',
    )

  content_type = _normalize_text(file_resp.headers.get('Content-Type', ''))
  if 'text/html' in content_type or 'json' in content_type:
    # 返回的是 HTML/JSON 而非文件流，通常是登录失效或错误页。
    raise HTTPException(
      status_code=502,
      detail='课件下载返回了网页而非文件，可能登录态已失效，请重新登录网络学堂后重试。',
    )

  file_name = _guess_filename_from_response(file_resp, wjid)
  if fallback_name:
    fallback_path = Path(re.sub(r'[<>:"/\\|?*]+', '_', fallback_name.strip()))
    guessed_path = Path(file_name)
    if not guessed_path.suffix and fallback_path.suffix:
      file_name = f'{guessed_path.stem or guessed_path.name}{fallback_path.suffix}'
    elif guessed_path.name.lower() in {'downloadfile', 'downloadfilebefore', wjid.lower()} and fallback_path.name:
      file_name = fallback_path.name
  target_path = download_dir / file_name
  counter = 1
  while target_path.exists():
    target_path = download_dir / f'{Path(file_name).stem}_{counter}{Path(file_name).suffix}'
    counter += 1

  with target_path.open('wb') as handle:
    for chunk in file_resp.iter_content(chunk_size=65536):
      if chunk:
        handle.write(chunk)
  return target_path


def _download_courseware_file_via_api(
  driver: webdriver.Chrome,
  wjid: str,
  download_dir: Path,
  fallback_name: str = '',
  referer: str = '',
) -> Path:
  http_session = _build_requests_session_from_driver(driver)
  csrf_token = _extract_xsrf_token(driver)
  if referer:
    http_session.headers['Referer'] = referer

  base = f'https://{LEARN_HOST}'
  request_candidates = [
    (
      f'{base}/b/wlxt/kj/wlkc_kjxxb/student/downloadFileBefore',
      {'wjid': wjid, **({'_csrf': csrf_token} if csrf_token else {})},
    ),
    (
      f'{base}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile',
      {'sfgk': '0', 'wjid': wjid, **({'_csrf': csrf_token} if csrf_token else {})},
    ),
  ]
  errors: list[str] = []

  for request_url, params in request_candidates:
    try:
      response = http_session.get(request_url, params=params, timeout=120, stream=True, allow_redirects=True)
    except requests.RequestException as exc:
      errors.append(f'{Path(request_url).name}: {exc}')
      continue

    if response.status_code != 200:
      errors.append(f'{Path(request_url).name}: HTTP {response.status_code}')
      continue
    if _looks_like_login_or_error_page(response):
      errors.append(f'{Path(request_url).name}: returned login/error page')
      continue
    if not _is_download_response(response):
      errors.append(f'{Path(request_url).name}: returned {response.headers.get("Content-Type", "unknown")}')
      continue

    file_name = _guess_filename_from_response(response, wjid)
    if fallback_name:
      fallback_path = Path(re.sub(r'[<>:"/\\|?*]+', '_', fallback_name.strip()))
      guessed_path = Path(file_name)
      if not guessed_path.suffix and fallback_path.suffix:
        file_name = f'{guessed_path.stem or guessed_path.name}{fallback_path.suffix}'
      elif guessed_path.name.lower() in {'downloadfile', 'downloadfilebefore', wjid.lower()} and fallback_path.name:
        file_name = fallback_path.name

    target_path = download_dir / file_name
    counter = 1
    while target_path.exists():
      target_path = download_dir / f'{Path(file_name).stem}_{counter}{Path(file_name).suffix}'
      counter += 1

    with target_path.open('wb') as handle:
      for chunk in response.iter_content(chunk_size=65536):
        if chunk:
          handle.write(chunk)
    return target_path

  joined = '；'.join(errors) if errors else 'unknown error'
  raise HTTPException(status_code=502, detail=f'课件接口下载失败：{joined}')


def _download_courseware_file_via_click(
  driver: webdriver.Chrome,
  row: Any,
  download_dir: Path,
) -> Path:
  download_button = _find_download_trigger(row)
  if download_button is None:
    raise HTTPException(status_code=502, detail='未找到下载按钮，无法回退到页面点击下载。')

  existing_names = {candidate.name for candidate in download_dir.iterdir() if candidate.is_file()}
  try:
    driver.execute_script('arguments[0].click();', download_button)
  except Exception:
    download_button.click()

  return _wait_for_downloaded_file(download_dir, existing_names)


def _ensure_course_home_ready(session: LearnSyncSession, timeout_seconds: float = 25.0) -> None:
  deadline = time.time() + timeout_seconds
  last_error: Exception | None = None
  while time.time() < deadline:
    try:
      current_url = session.driver.current_url
      title = session.driver.title
      page_source = session.driver.page_source
    except Exception as exc:
      last_error = exc
      time.sleep(0.6)
      continue

    if _extract_current_term_courses_from_dom(session.driver) or _extract_current_term_courses_from_html(page_source):
      return

    if (
      LOGIN_HOST in current_url
      or _is_sso_login_page(session.driver)
      or _is_learn_login_page(session.driver)
      or _has_relogin_entry(session.driver)
      or '????' in title
      or 're_log' in page_source[:4000].lower()
    ):
      _maybe_auto_login(session.driver)
      time.sleep(1.0)
      continue

    try:
      session.driver.get(COURSE_HOME_URL)
    except Exception as exc:
      last_error = exc
    time.sleep(1.0)

  if last_error:
    raise HTTPException(status_code=500, detail=f'??????????????: {last_error}')
  _wait_for_course_page(session)


def _open_courseware_page_for_course(
  session: LearnSyncSession,
  course_name: str,
  courseware_href: str,
  timeout_seconds: float = 15.0,
) -> None:
  try:
    previous_handles = list(session.driver.window_handles)
  except Exception:
    previous_handles = []

  def _click_courseware_trigger() -> bool:
    try:
      return bool(
        session.driver.execute_script(
          """
          const targetName = arguments[0];
          const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
          const candidates = Array.from(document.querySelectorAll('.hdtitle a.title'));
          const target = candidates.find((anchor) => normalize(anchor.getAttribute('title') || anchor.textContent) === targetName);
          if (!target) {
            return false;
          }
          const row = target.closest('li, .clearfix, .item, .stuitem');
          if (!row) {
            return false;
          }
          const materialLabel = row.querySelector('span.name.kejian');
          const materialTrigger = materialLabel ? materialLabel.closest('a') || materialLabel : null;
          if (!materialTrigger) {
            return false;
          }
          materialTrigger.click();
          return true;
          """,
          course_name,
        )
      )
    except Exception:
      return False

  _ensure_course_home_ready(session)
  clicked = _click_courseware_trigger()
  if not clicked:
    raise HTTPException(status_code=502, detail=f'未能在课程列表中找到“{course_name}”的课件入口。')
  if previous_handles:
    _switch_to_newest_window_if_needed(session.driver, previous_handles, 4.0)

  deadline = time.time() + timeout_seconds
  while time.time() < deadline:
    current_url = ''
    title = ''
    source_head = ''
    try:
      current_url = session.driver.current_url
      title = session.driver.title
      source_head = session.driver.page_source[:6000].lower()
    except Exception:
      time.sleep(0.5)
      continue

    if (
      LOGIN_HOST in current_url
      or _is_sso_login_page(session.driver)
      or _is_learn_login_page(session.driver)
      or _has_relogin_entry(session.driver)
      or '????' in title
      or any(token in source_head for token in ('re_log', 'closecurrentpage', 'log_fail.png', '404'))
    ):
      _maybe_auto_login(session.driver)
      _ensure_course_home_ready(session)
      try:
        previous_handles = list(session.driver.window_handles)
      except Exception:
        previous_handles = []
      clicked = _click_courseware_trigger()
      if not clicked:
        raise HTTPException(status_code=502, detail=f'重新登录后仍未找到“{course_name}”的课件入口。')
      if previous_handles:
        _switch_to_newest_window_if_needed(session.driver, previous_handles, 4.0)
      time.sleep(1.0)
      continue

    rows = _wait_for_material_rows(session.driver, 1.5)
    if rows:
      return
    time.sleep(0.5)

  raise HTTPException(status_code=504, detail=f'?????{course_name}?????????')


def _wait_for_playli_download_icons(
  driver: webdriver.Chrome,
  timeout_seconds: float = 20.0,
) -> list[Any]:
  """等待 class.html 播放列表 .playli 里的下载图标渲染出来，返回含下载图标的文件行。"""
  deadline = time.time() + timeout_seconds
  triggered_tab = False
  while time.time() < deadline:
    try:
      # 课件文件项：<li wjid="..."> 内含 a.titlink 标题 与 .downLoadFile 下载图标。
      rows = driver.find_elements(By.CSS_SELECTOR, '.playli li[wjid]')
    except Exception:
      rows = []
    if rows:
      return rows
    # 播放列表还没加载：尝试点击第一个分类（如“电子教案”）触发 initList 加载文件列表。
    if not triggered_tab:
      try:
        driver.execute_script(
          """
          const tab = document.querySelector('#tabbox .mytabs li, .mytabs li');
          if (tab) { tab.click(); }
          """
        )
      except Exception:
        pass
      triggered_tab = True
    time.sleep(0.5)
  return rows


def _open_courseware_page_by_url(
  session: LearnSyncSession,
  courseware_href: str,
  course_name: str,
  timeout_seconds: float = 20.0,
) -> None:
  # 直接导航到该课程的课件列表页（/f/wlxt/kj/wlkc_kjxxb/student/beforePageList?wlkcid=...），
  # 这就是 class.html 里“课程文件”tab 的内容页，是有效路由，不会触发 SPA 404。
  session.driver.get(courseware_href)
  deadline = time.time() + timeout_seconds
  while time.time() < deadline:
    try:
      current_url = session.driver.current_url
    except Exception:
      time.sleep(0.5)
      continue

    if (
      LOGIN_HOST in current_url
      or _is_sso_login_page(session.driver)
      or _is_learn_login_page(session.driver)
      or _has_relogin_entry(session.driver)
    ):
      raise HTTPException(
        status_code=409,
        detail='网络学堂尚未完成登录或二次认证，请先在弹出的浏览器窗口中完成认证。',
      )

    rows = _wait_for_playli_download_icons(session.driver, 3.0)
    if rows:
      return
    time.sleep(0.5)


def _guess_stage(current_url: str, title: str, page_source: str) -> str:
  normalized_url = current_url.lower()
  normalized_title = title.lower()
  source_head = page_source[:12000].lower()

  if LOGIN_HOST in normalized_url and ('二次认证' in title or 'check' in normalized_url):
    return 'awaiting_2fa'
  if LOGIN_HOST in normalized_url or '/f/login' in normalized_url or '登录' in title:
    return 'awaiting_login'
  if any(token in source_head for token in ('log_fail.png', 'closecurrentpage', 're_log')):
    return 'awaiting_login'
  if LEARN_HOST in normalized_url:
    return 'navigating'
  if '二次认证' in normalized_title:
    return 'awaiting_2fa'
  return 'navigating'


def _find_browser_binary() -> str:
  candidates = [
    r'C:\Program Files\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  ]
  for path in candidates:
    if Path(path).is_file():
      return path
  raise HTTPException(status_code=500, detail='Chrome or Edge browser was not found on this machine.')


def _course_sample_from_entries(entries: list[dict[str, str]]) -> list[dict[str, str]]:
  return [
    {
      'name': _normalize_text(entry.get('name')),
      'href': _resolve_absolute_url(str(entry.get('href') or '')),
      'semesterId': _normalize_text(str(entry.get('semesterId') or '')),
      'semesterName': _normalize_text(str(entry.get('semesterName') or '')),
      'courseCode': _normalize_text(str(entry.get('courseCode') or '')),
      'wlkcid': _normalize_text(str(entry.get('wlkcid') or '')),
    }
    for entry in entries
    if _looks_like_course_name(_normalize_text(entry.get('name')))
  ][:8]


def _normalize_course_material_entries(entries: Any) -> list[dict[str, str]]:
  if not isinstance(entries, list):
    return []
  normalized_entries: list[dict[str, str]] = []
  seen: set[str] = set()
  for item in entries:
    if not isinstance(item, dict):
      continue
    name = _normalize_text(item.get('name'))
    if not _looks_like_course_name(name):
      continue
    semester_id = _normalize_text(str(item.get('semesterId') or ''))
    course_code = _normalize_text(str(item.get('courseCode') or ''))
    wlkcid = _normalize_text(str(item.get('wlkcid') or ''))
    key = '::'.join(
      [
        semester_id.casefold(),
        wlkcid.casefold(),
        course_code.casefold(),
        name.casefold(),
      ]
    )
    if key in seen:
      continue
    seen.add(key)
    normalized_entries.append(
      {
        'name': name,
        'href': _resolve_absolute_url(str(item.get('href') or '')),
        'wlkcid': wlkcid,
        'coursewareHref': _resolve_absolute_url(str(item.get('coursewareHref') or '')),
        'courseCode': course_code,
        'semesterId': semester_id,
        'semesterName': _normalize_text(str(item.get('semesterName') or '')),
        'teacherName': _normalize_text(str(item.get('teacherName') or '')),
      }
    )
  return normalized_entries


def _extract_current_semester_id_from_html(page_source: str) -> str:
  if not page_source.strip():
    return ''

  soup = BeautifulSoup(page_source, 'html.parser')
  current_semester = soup.select_one('#currentSemester')
  if current_semester is not None:
    value = _normalize_text(current_semester.get('value'))
    if value:
      return value

  matched = re.search(r"queryCurrentSemesterCourse\('([^']+)'\)", page_source)
  if matched:
    return _normalize_text(matched.group(1))

  option = soup.select_one('#xqxqselect option')
  if option is not None:
    return _normalize_text(option.get('value'))
  return ''


def _build_course_entry_from_course_api_item(item: Any) -> dict[str, str] | None:
  if not isinstance(item, dict):
    return None

  semester_id = _normalize_text(item.get('xnxq') or item.get('semesterId'))
  semester_name = _normalize_text(item.get('xnxqmc') or item.get('semesterName'))
  name = _normalize_text(
    item.get('kcm')
    or item.get('name')
    or item.get('courseName')
    or item.get('title')
  )
  course_code = _normalize_text(item.get('kch') or item.get('courseCode') or item.get('code'))
  wlkcid = _normalize_text(item.get('wlkcid') or item.get('kcid') or item.get('courseId'))
  if not _looks_like_course_name(name) or not wlkcid:
    return None

  href = _resolve_absolute_url(
    str(item.get('kcurl') or item.get('href') or f'/f/wlxt/index/course/student/course?wlkcid={wlkcid}')
  )
  return {
    'name': name,
    'href': href,
    'wlkcid': wlkcid,
    'coursewareHref': _build_courseware_list_referer(wlkcid),
    'courseCode': course_code,
    'semesterId': semester_id,
    'semesterName': semester_name,
    'teacherName': _normalize_text(item.get('jsm') or item.get('teacherName')),
  }


def _format_semester_name(semester_id: str) -> str:
  parts = _normalize_text(semester_id).split('-')
  if len(parts) != 3:
    return semester_id
  term_name = {'1': '秋季学期', '2': '春季学期', '3': '夏季学期'}.get(parts[2], '')
  return f'{parts[0]}-{parts[1]}{term_name}' if term_name else semester_id


def _parse_semester_api_item(item: Any) -> dict[str, Any] | None:
  if isinstance(item, str):
    semester_id = _normalize_text(item)
    if not semester_id:
      return None
    return {
      'id': semester_id,
      'semesterId': semester_id,
      'semesterName': _format_semester_name(semester_id),
      'startDate': '',
      'endDate': '',
      'isCurrent': False,
    }
  if not isinstance(item, dict):
    return None

  semester_id = _normalize_text(item.get('id') or item.get('xnxq') or item.get('semesterId'))
  semester_name = _normalize_text(item.get('xnxqmc') or item.get('name') or item.get('semesterName'))
  if not semester_id:
    return None

  return {
    'id': semester_id,
    'semesterId': semester_id,
    'semesterName': semester_name or semester_id,
    'startDate': _normalize_text(item.get('kssj') or item.get('startDate')),
    'endDate': _normalize_text(item.get('jssj') or item.get('endDate')),
    'isCurrent': bool(item.get('isCurrent')),
  }


def _parse_courseware_category_item(item: Any) -> dict[str, str] | None:
  if not isinstance(item, dict):
    return None
  category_id = _normalize_text(item.get('kjflid') or item.get('id') or item.get('uuid'))
  category_name = _normalize_text(item.get('bt') or item.get('mc') or item.get('title') or item.get('name'))
  if not category_id:
    return None
  return {
    'categoryId': category_id,
    'categoryName': category_name or '未命名分类',
  }


def _persist_cookie_payload(cookies: list[dict[str, Any]]) -> None:
  sanitized: list[dict[str, Any]] = []
  for cookie in cookies:
    if not isinstance(cookie, dict):
      continue
    domain = _normalize_text(str(cookie.get('domain') or ''))
    if LEARN_HOST not in domain and not domain.endswith('.tsinghua.edu.cn'):
      continue
    next_cookie = {
      key: cookie.get(key)
      for key in {'name', 'value', 'domain', 'path', 'expires', 'secure', 'httpOnly', 'sameSite'}
      if key in cookie
    }
    if _normalize_text(str(next_cookie.get('name') or '')) and 'value' in next_cookie:
      if 'expires' in next_cookie and 'expiry' not in next_cookie:
        next_cookie['expiry'] = next_cookie.pop('expires')
      sanitized.append(next_cookie)
  if sanitized:
    COOKIE_STORE_PATH.write_text(json.dumps(sanitized, ensure_ascii=False, indent=2), encoding='utf-8')


def _extract_xsrf_token_from_cookies(cookies: list[dict[str, Any]]) -> str:
  for cookie in cookies:
    if _normalize_text(str(cookie.get('name') or '')) == 'XSRF-TOKEN':
      return str(cookie.get('value') or '').strip()
  return ''


def _build_requests_session_from_cookies(cookies: list[dict[str, Any]]) -> requests.Session:
  session = requests.Session()
  session.headers.update(
    {
      'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/120.0 Safari/537.36'
      ),
      'Referer': f'https://{LEARN_HOST}/',
    }
  )
  for cookie in cookies:
    name = cookie.get('name')
    value = cookie.get('value')
    if name is None or value is None:
      continue
    session.cookies.set(
      str(name),
      str(value),
      domain=str(cookie.get('domain', LEARN_HOST)).lstrip('.'),
      path=str(cookie.get('path', '/')),
    )
  return session


def _fetch_semesters_via_cookie_session(cookies: list[dict[str, Any]]) -> list[dict[str, Any]]:
  http_session = _build_requests_session_from_cookies(cookies)
  csrf_token = _extract_xsrf_token_from_cookies(cookies)
  params: dict[str, str] = {'timestamp': str(int(time.time() * 1000))}
  if csrf_token:
    params['_csrf'] = csrf_token
  http_session.headers.update(
    {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': f'{COURSE_HOME_URL}/',
    }
  )

  try:
    response = http_session.get(
      f'https://{LEARN_HOST}/b/kc/zhjw_v_code_xnxq/getCurrentAndNextSemester',
      params=params,
      timeout=30,
      allow_redirects=True,
    )
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'学期列表接口请求失败: {exc}') from exc

  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    raise HTTPException(status_code=502, detail='学期列表接口返回了登录页或错误页，请重新登录网络学堂后重试。')

  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'学期列表接口未返回合法 JSON: {exc}') from exc

  candidates: list[dict[str, Any]] = []
  if isinstance(payload, dict):
    current = _parse_semester_api_item(payload.get('result'))
    if current:
      current['isCurrent'] = True
      candidates.append(current)

    raw_list = payload.get('resultList')
    if isinstance(raw_list, list):
      for item in raw_list:
        parsed = _parse_semester_api_item(item)
        if parsed:
          candidates.append(parsed)
  elif isinstance(payload, list):
    # The current network-school deployment returns a flat array such as
    # [null, '2026-2027-1', '2025-2026-3', ...]. The first usable term is
    # the current/default term; the remaining entries are historical options.
    current_marked = False
    for item in payload:
      parsed = _parse_semester_api_item(item)
      if not parsed:
        continue
      if not current_marked:
        parsed['isCurrent'] = True
        current_marked = True
      candidates.append(parsed)

  # "getCurrentAndNextSemester" deliberately exposes only the visible top
  # tabs. Historical terms are served by the separate "previous courses"
  # selector used by the same course page.
  try:
    history_response = http_session.get(
      f'https://{LEARN_HOST}/b/wlxt/kc/v_wlkc_xs_xktjb_coassb/queryxnxq',
      params=params,
      timeout=30,
      allow_redirects=True,
    )
    historical_terms = history_response.json() if history_response.status_code == 200 else []
  except (requests.RequestException, ValueError):
    historical_terms = []
  if isinstance(historical_terms, list):
    for term in historical_terms:
      parsed = _parse_semester_api_item(term)
      if parsed:
        candidates.append(parsed)

  semesters: list[dict[str, Any]] = []
  seen: set[str] = set()
  for item in candidates:
    semester_id = _normalize_text(str(item.get('id') or item.get('semesterId') or ''))
    if not semester_id or semester_id in seen:
      continue
    seen.add(semester_id)
    semesters.append(
      {
        'id': semester_id,
        'semesterId': semester_id,
        'semesterName': _normalize_text(str(item.get('semesterName') or item.get('xnxqmc') or semester_id)) or semester_id,
        'startDate': _normalize_text(str(item.get('startDate') or '')) or None,
        'endDate': _normalize_text(str(item.get('endDate') or '')) or None,
        'isCurrent': bool(item.get('isCurrent')),
      }
    )

  if semesters:
    return semesters

  raise HTTPException(status_code=502, detail='学期列表接口返回成功，但没有解析到学期信息。')


def _fetch_previous_semester_course_entries(
  http_session: requests.Session,
  csrf_token: str,
  semester_id: str,
  semester_name: str,
) -> list[dict[str, str]]:
  """Fetch the course table behind the network school's previous-term tab."""
  ao_data = [
    {'name': 'sEcho', 'value': '1'},
    {'name': 'iColumns', 'value': '5'},
    {'name': 'sColumns', 'value': ''},
    {'name': 'iDisplayStart', 'value': '0'},
    {'name': 'iDisplayLength', 'value': '500'},
    {'name': 'mDataProp_0', 'value': 'xuh'},
    {'name': 'mDataProp_1', 'value': 'kcm'},
    {'name': 'mDataProp_2', 'value': 'jslx'},
    {'name': 'mDataProp_3', 'value': 'xnxq'},
    {'name': 'mDataProp_4', 'value': 'jsmc'},
    {'name': 'xnxq', 'value': semester_id},
  ]
  form_data = {'aoData': json.dumps(ao_data, ensure_ascii=False)}
  if csrf_token:
    form_data['_csrf'] = csrf_token
  try:
    response = http_session.post(
      f'https://{LEARN_HOST}/b/wlxt/kc/v_wlkc_xs_xktjb_coassb/pageList',
      data=form_data,
      timeout=30,
      allow_redirects=True,
    )
  except requests.RequestException:
    return []
  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    return []
  try:
    payload = response.json()
  except ValueError:
    return []
  table = payload.get('object') if isinstance(payload, dict) else None
  raw_courses = table.get('aaData') if isinstance(table, dict) else None
  if not isinstance(raw_courses, list):
    return []
  return _normalize_course_material_entries([
    entry
    for entry in (
      _build_course_entry_from_course_api_item({
        **item,
        'xnxq': item.get('xnxq') or semester_id,
        'xnxqmc': item.get('xnxqmc') or semester_name,
      })
      for item in raw_courses
      if isinstance(item, dict)
    )
    if entry
  ])


def _run_playwright_login(
  runtime_dir: Path,
  browser_binary: str,
  username: str,
  password: str,
) -> dict[str, Any]:
  request_path = runtime_dir / 'playwright-login-request.json'
  response_path = runtime_dir / 'playwright-login-response.json'
  request_payload = {
    'username': username,
    'password': password,
    'browserBinary': browser_binary,
    'storageDir': str(runtime_dir / 'playwright'),
    'headless': False,
  }
  request_path.write_text(json.dumps(request_payload, ensure_ascii=False, indent=2), encoding='utf-8')
  script_path = Path(__file__).resolve().parent.parent / 'scripts' / 'tsinghua-login-playwright.mjs'
  if not script_path.is_file():
    raise HTTPException(status_code=500, detail='Playwright login script was not found.')

  try:
    completed = subprocess.run(
      ['node', str(script_path), str(request_path), str(response_path)],
      cwd=str(script_path.parent.parent),
      capture_output=True,
      text=True,
      timeout=180,
      check=False,
      encoding='utf-8',
      errors='replace',
    )
  except FileNotFoundError as exc:
    raise HTTPException(status_code=500, detail='Node.js was not found on this machine.') from exc
  except subprocess.TimeoutExpired as exc:
    raise HTTPException(status_code=504, detail='Playwright 登录网络学堂超时。') from exc

  if not response_path.is_file():
    stderr = (completed.stderr or '').strip()
    stdout = (completed.stdout or '').strip()
    detail = stderr or stdout or 'Playwright 登录未返回结果文件。'
    raise HTTPException(status_code=502, detail=detail)

  try:
    payload = json.loads(response_path.read_text(encoding='utf-8'))
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'Playwright 登录返回了无法解析的 JSON: {exc}') from exc

  if not isinstance(payload, dict):
    raise HTTPException(status_code=502, detail='Playwright 登录返回结构异常。')
  if not payload.get('ok'):
    detail = _normalize_text(str(payload.get('error') or '')) or 'Playwright 登录失败。'
    raise HTTPException(status_code=502, detail=detail)
  return payload


def _fetch_course_entries_via_cookie_session(cookies: list[dict[str, Any]]) -> list[dict[str, str]]:
  return _fetch_course_entries_via_cookie_session_v2(cookies)

  http_session = _build_requests_session_from_cookies(cookies)
  candidates = [
    COURSE_HOME_URL,
    f'{COURSE_HOME_URL}/',
    f'https://{LEARN_HOST}/',
  ]
  errors: list[str] = []

  for request_url in candidates:
    try:
      response = http_session.get(request_url, timeout=30, allow_redirects=True)
    except requests.RequestException as exc:
      errors.append(f'{request_url}: {exc}')
      continue

    if response.status_code != 200:
      errors.append(f'{request_url}: HTTP {response.status_code}')
      continue
    if _looks_like_login_or_error_page(response):
      errors.append(f'{request_url}: still redirected to login page')
      continue

    page_source = response.text or ''
    entries = _extract_current_term_course_material_entries_from_html(page_source)
    if entries:
      return entries

    fallback_courses = _extract_current_term_courses_from_html(page_source)
    if fallback_courses:
      return _normalize_course_material_entries(fallback_courses)

    errors.append(f'{request_url}: course list not found in HTML')

  joined_errors = '; '.join(errors[-3:]) or 'unknown error'
  raise HTTPException(status_code=502, detail=f'使用登录后的 cookie 拉取课程列表失败：{joined_errors}')


def _fetch_courseware_entries_via_api_for_session(
  session: 'LearnSyncSession',
  course_entry: dict[str, str],
) -> list[dict[str, Any]]:
  wlkcid = _extract_wlkcid_from_course_entry(course_entry)
  if not wlkcid:
    raise HTTPException(status_code=422, detail='当前课程缺少 wlkcid，无法通过接口拉取课件列表。')

  http_session = _build_requests_session_from_cookies(session.cookies)
  csrf_token = _extract_xsrf_token_from_cookies(session.cookies)
  http_session.headers.update(
    {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': _build_courseware_list_referer(wlkcid),
    }
  )
  params = {'size': '999', 'wlkcid': wlkcid}
  if csrf_token:
    params['_csrf'] = csrf_token

  try:
    response = http_session.get(
      f'https://{LEARN_HOST}/b/wlxt/kj/wlkc_kjxxb/student/kjxxbByWlkcidAndSizeForStudent',
      params=params,
      timeout=30,
    )
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'课件列表接口请求失败: {exc}') from exc

  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    raise HTTPException(status_code=502, detail='课件列表接口返回了登录页或错误页，请重新同步后重试。')

  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'课件列表接口未返回合法 JSON: {exc}') from exc

  raw_items = payload.get('object') if isinstance(payload, dict) else None
  if not isinstance(raw_items, list):
    raise HTTPException(status_code=502, detail='课件列表接口返回结构异常，未找到 object 数组。')

  records: list[dict[str, Any]] = []
  seen_wjid: set[str] = set()
  for raw_item in raw_items:
    parsed = _parse_courseware_api_item(raw_item, wlkcid)
    if not parsed:
      continue
    wjid = str(parsed.get('wjid') or '')
    if not wjid or wjid in seen_wjid:
      continue
    seen_wjid.add(wjid)
    records.append(parsed)
  return records


def _fetch_course_entries_via_cookie_session_v2(cookies: list[dict[str, Any]]) -> list[dict[str, str]]:
  http_session = _build_requests_session_from_cookies(cookies)
  csrf_token = _extract_xsrf_token_from_cookies(cookies)
  candidates = [f'{COURSE_HOME_URL}/', COURSE_HOME_URL, f'https://{LEARN_HOST}/']
  errors: list[str] = []
  semester_id = ''
  home_source = ''

  for request_url in candidates:
    try:
      response = http_session.get(request_url, timeout=30, allow_redirects=True)
    except requests.RequestException as exc:
      errors.append(f'{request_url}: {exc}')
      continue

    if response.status_code != 200:
      errors.append(f'{request_url}: HTTP {response.status_code}')
      continue
    if _looks_like_login_or_error_page(response):
      errors.append(f'{request_url}: still redirected to login page')
      continue

    home_source = response.text or ''
    semester_id = _extract_current_semester_id_from_html(home_source)
    if semester_id:
      break
    errors.append(f'{request_url}: current semester id not found')

  if not semester_id:
    fallback_entries = _extract_current_term_course_material_entries_from_html(home_source)
    if fallback_entries:
      return fallback_entries
    joined_errors = '; '.join(errors[-3:]) or 'unknown error'
    raise HTTPException(status_code=502, detail=f'使用登录后的 cookie 拉取课程列表失败：{joined_errors}')

  api_url = (
    f'https://{LEARN_HOST}/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/'
    f'loadCourseBySemesterId/{quote(semester_id)}/zh'
  )
  params: dict[str, str] = {'timestamp': str(int(time.time() * 1000))}
  if csrf_token:
    params['_csrf'] = csrf_token
  http_session.headers.update(
    {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': f'{COURSE_HOME_URL}/',
    }
  )
  try:
    response = http_session.get(api_url, params=params, timeout=30, allow_redirects=True)
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'课程列表接口请求失败: {exc}') from exc

  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    raise HTTPException(status_code=502, detail='课程列表接口返回了登录页或错误页，请重新登录网络学堂后重试。')

  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'课程列表接口未返回合法 JSON: {exc}') from exc

  raw_courses = payload.get('resultList') if isinstance(payload, dict) else None
  if not isinstance(raw_courses, list):
    raise HTTPException(status_code=502, detail='课程列表接口返回结构异常，未找到 resultList 数组。')

  entries = _normalize_course_material_entries(
    [entry for entry in (_build_course_entry_from_course_api_item(item) for item in raw_courses) if entry]
  )
  if entries:
    return entries

  fallback_entries = _extract_current_term_course_material_entries_from_html(home_source)
  if fallback_entries:
    return fallback_entries
  raise HTTPException(status_code=502, detail='课程列表接口返回成功，但没有解析到当前学期课程。')


def _fetch_course_entries_for_semester_via_cookie_session(
  cookies: list[dict[str, Any]],
  semester_id: str,
) -> list[dict[str, str]]:
  target_semester_id = _normalize_text(semester_id)
  if not target_semester_id:
    return _fetch_course_entries_via_cookie_session_v2(cookies)

  http_session = _build_requests_session_from_cookies(cookies)
  csrf_token = _extract_xsrf_token_from_cookies(cookies)
  target_semester_name = ''

  try:
    semesters = _fetch_semesters_via_cookie_session(cookies)
  except HTTPException:
    semesters = []

  matched_semester = next(
    (
      item
      for item in semesters
      if _normalize_text(str(item.get('id') or item.get('semesterId') or '')) == target_semester_id
    ),
    None,
  )
  if matched_semester is not None:
    target_semester_name = _normalize_text(str(matched_semester.get('semesterName') or ''))

  api_url = (
    f'https://{LEARN_HOST}/b/wlxt/kc/v_wlkc_xs_xkb_kcb_extend/student/'
    f'loadCourseBySemesterId/{quote(target_semester_id)}/zh'
  )
  params: dict[str, str] = {'timestamp': str(int(time.time() * 1000))}
  if csrf_token:
    params['_csrf'] = csrf_token
  http_session.headers.update(
    {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': f'{COURSE_HOME_URL}/',
    }
  )

  try:
    response = http_session.get(api_url, params=params, timeout=30, allow_redirects=True)
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'课程列表接口请求失败: {exc}') from exc

  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    raise HTTPException(status_code=502, detail='课程列表接口返回了登录页或错误页，请重新登录网络学堂后重试。')

  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'课程列表接口未返回合法 JSON: {exc}') from exc

  raw_courses = payload.get('resultList') if isinstance(payload, dict) else None
  entries = _normalize_course_material_entries([
    entry
    for entry in (
      _build_course_entry_from_course_api_item({
        **item,
        'xnxq': item.get('xnxq') or target_semester_id,
        'xnxqmc': item.get('xnxqmc') or target_semester_name,
      })
      for item in raw_courses
      if isinstance(item, dict)
    )
    if entry
  ]) if isinstance(raw_courses, list) else []
  if entries:
    return entries

  historical_entries = _fetch_previous_semester_course_entries(
    http_session,
    csrf_token,
    target_semester_id,
    target_semester_name or _format_semester_name(target_semester_id),
  )
  if historical_entries:
    return historical_entries

  raise HTTPException(status_code=502, detail='课程列表接口返回成功，但没有解析到该学期的课程。')


def _fetch_courseware_categories_via_api_for_session_v2(
  session: 'LearnSyncSession',
  course_entry: dict[str, str],
) -> list[dict[str, str]]:
  wlkcid = _extract_wlkcid_from_course_entry(course_entry)
  if not wlkcid:
    raise HTTPException(status_code=422, detail='当前课程缺少 wlkcid，无法拉取课件分类。')

  http_session = _build_requests_session_from_cookies(session.cookies)
  csrf_token = _extract_xsrf_token_from_cookies(session.cookies)
  http_session.headers.update(
    {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': _build_courseware_list_referer(wlkcid),
    }
  )
  params = {'wlkcid': wlkcid}
  if csrf_token:
    params['_csrf'] = csrf_token

  try:
    response = http_session.get(
      f'https://{LEARN_HOST}/b/wlxt/kj/wlkc_kjflb/student/pageList',
      params=params,
      timeout=30,
      allow_redirects=True,
    )
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'课件分类接口请求失败: {exc}') from exc

  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    raise HTTPException(status_code=502, detail='课件分类接口返回了登录页或错误页，请重新登录网络学堂后重试。')

  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'课件分类接口未返回合法 JSON: {exc}') from exc

  raw_categories = payload.get('object') if isinstance(payload, dict) else None
  if isinstance(raw_categories, dict):
    raw_categories = raw_categories.get('rows')
  if not isinstance(raw_categories, list):
    return []

  categories: list[dict[str, str]] = []
  seen: set[str] = set()
  for parsed in (_parse_courseware_category_item(item) for item in raw_categories):
    if not parsed:
      continue
    category_id = parsed['categoryId']
    if category_id in seen:
      continue
    seen.add(category_id)
    categories.append(parsed)
  return categories


def _fetch_courseware_entries_for_category_via_api_for_session_v2(
  session: 'LearnSyncSession',
  course_entry: dict[str, str],
  category_id: str,
  category_name: str,
) -> list[dict[str, Any]]:
  wlkcid = _extract_wlkcid_from_course_entry(course_entry)
  if not wlkcid:
    raise HTTPException(status_code=422, detail='当前课程缺少 wlkcid，无法拉取分类课件。')

  http_session = _build_requests_session_from_cookies(session.cookies)
  csrf_token = _extract_xsrf_token_from_cookies(session.cookies)
  http_session.headers.update(
    {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': _build_courseware_list_referer(wlkcid),
    }
  )
  params: dict[str, str] = {}
  if csrf_token:
    params['_csrf'] = csrf_token

  try:
    response = http_session.get(
      f'https://{LEARN_HOST}/b/wlxt/kj/wlkc_kjxxb/student/kjxxb/{quote(wlkcid)}/{quote(category_id)}',
      params=params,
      timeout=30,
      allow_redirects=True,
    )
  except requests.RequestException as exc:
    raise HTTPException(status_code=502, detail=f'分类课件接口请求失败: {exc}') from exc

  if response.status_code != 200 or _looks_like_login_or_error_page(response):
    raise HTTPException(status_code=502, detail='分类课件接口返回了登录页或错误页，请重新登录网络学堂后重试。')

  try:
    payload = response.json()
  except Exception as exc:
    raise HTTPException(status_code=502, detail=f'分类课件接口未返回合法 JSON: {exc}') from exc

  raw_items = payload.get('object') if isinstance(payload, dict) else None
  if not isinstance(raw_items, list):
    return []

  records: list[dict[str, Any]] = []
  seen_wjid: set[str] = set()
  for raw_item in raw_items:
    parsed = _parse_courseware_api_item(raw_item, wlkcid)
    if not parsed:
      continue
    wjid = str(parsed.get('wjid') or '')
    if not wjid or wjid in seen_wjid:
      continue
    seen_wjid.add(wjid)
    parsed['categoryId'] = category_id
    parsed['categoryName'] = category_name
    records.append(parsed)
  return records


def _fetch_courseware_entries_via_api_for_session_v2(
  session: 'LearnSyncSession',
  course_entry: dict[str, str],
) -> list[dict[str, Any]]:
  categories = _fetch_courseware_categories_via_api_for_session_v2(session, course_entry)
  if not categories:
    return _fetch_courseware_entries_via_api_for_session(session, course_entry)

  records: list[dict[str, Any]] = []
  seen_wjid: set[str] = set()
  for category in categories:
    category_id = _normalize_text(category.get('categoryId'))
    category_name = _normalize_text(category.get('categoryName'))
    if not category_id:
      continue
    for parsed in _fetch_courseware_entries_for_category_via_api_for_session_v2(
      session,
      course_entry,
      category_id,
      category_name,
    ):
      wjid = str(parsed.get('wjid') or '')
      if not wjid or wjid in seen_wjid:
        continue
      seen_wjid.add(wjid)
      records.append(parsed)
  return records


def _download_courseware_file_via_api_for_session(
  session: 'LearnSyncSession',
  wjid: str,
  download_dir: Path,
  fallback_name: str = '',
  referer: str = '',
) -> Path:
  http_session = _build_requests_session_from_cookies(session.cookies)
  csrf_token = _extract_xsrf_token_from_cookies(session.cookies)
  if referer:
    http_session.headers['Referer'] = referer

  base = f'https://{LEARN_HOST}'
  request_candidates = [
    (
      f'{base}/b/wlxt/kj/wlkc_kjxxb/student/downloadFileBefore',
      {'wjid': wjid, **({'_csrf': csrf_token} if csrf_token else {})},
    ),
    (
      f'{base}/b/wlxt/kj/wlkc_kjxxb/student/downloadFile',
      {'sfgk': '0', 'wjid': wjid, **({'_csrf': csrf_token} if csrf_token else {})},
    ),
  ]
  errors: list[str] = []

  for request_url, params in request_candidates:
    try:
      response = http_session.get(request_url, params=params, timeout=120, stream=True, allow_redirects=True)
    except requests.RequestException as exc:
      errors.append(f'{Path(request_url).name}: {exc}')
      continue

    if response.status_code != 200:
      errors.append(f'{Path(request_url).name}: HTTP {response.status_code}')
      continue
    if _looks_like_login_or_error_page(response):
      errors.append(f'{Path(request_url).name}: returned login/error page')
      continue
    if not _is_download_response(response):
      errors.append(f'{Path(request_url).name}: returned {response.headers.get("Content-Type", "unknown")}')
      continue

    file_name = _guess_filename_from_response(response, wjid)
    if fallback_name:
      fallback_path = Path(re.sub(r'[<>:"/\\|?*]+', '_', fallback_name.strip()))
      guessed_path = Path(file_name)
      if not guessed_path.suffix and fallback_path.suffix:
        file_name = f'{guessed_path.stem or guessed_path.name}{fallback_path.suffix}'
      elif guessed_path.name.lower() in {'downloadfile', 'downloadfilebefore', wjid.lower()} and fallback_path.name:
        file_name = fallback_path.name

    target_path = download_dir / file_name
    counter = 1
    while target_path.exists():
      target_path = download_dir / f'{Path(file_name).stem}_{counter}{Path(file_name).suffix}'
      counter += 1

    with target_path.open('wb') as handle:
      for chunk in response.iter_content(chunk_size=65536):
        if chunk:
          handle.write(chunk)
    return target_path

  joined = '；'.join(errors) if errors else 'unknown error'
  raise HTTPException(status_code=502, detail=f'课件接口下载失败：{joined}')


# Public compatibility type; the active implementation lives in the focused state module.
LearnSyncSession = sync_state.LearnSyncSession


_registry = sync_state.LearnSyncRegistry(
  sync_state.LearnSyncRegistryDeps(
    sync_runtime_dir=SYNC_RUNTIME_DIR,
    course_home_url=COURSE_HOME_URL,
    learn_host=LEARN_HOST,
    load_persisted_cookies=_load_persisted_cookies,
    fetch_course_entries_via_cookie_session_v2=_fetch_course_entries_via_cookie_session_v2,
    load_auth_config=load_tsinghua_auth_config,
    normalize_text=_normalize_text,
    course_sample_from_entries=_course_sample_from_entries,
    guess_stage=_guess_stage,
    extract_current_term_courses_from_dom=_extract_current_term_courses_from_dom,
    extract_current_term_courses_from_html=_extract_current_term_courses_from_html,
    persist_cookies=_persist_cookies,
    find_browser_binary=_find_browser_binary,
    utc_now=_utc_now,
    run_playwright_login=_run_playwright_login,
    normalize_course_material_entries=_normalize_course_material_entries,
    persist_cookie_payload=_persist_cookie_payload,
  ),
)


def _wait_for_course_page(session: LearnSyncSession, timeout_seconds: int = 20) -> tuple[str, str, str]:
  deadline = time.time() + timeout_seconds
  last_url = ''
  last_title = ''
  last_source = ''

  while time.time() < deadline:
    try:
      last_url = session.driver.current_url
      last_title = session.driver.title
      last_source = session.driver.page_source
    except WebDriverException as exc:
      raise HTTPException(status_code=500, detail=f'浏览器会话已失效: {exc}') from exc

    stage = _guess_stage(last_url, last_title, last_source)
    has_courses = bool(
      _extract_current_term_courses_from_dom(session.driver)
      or _extract_current_term_courses_from_html(last_source)
    )
    if has_courses:
      return last_url, last_title, last_source
    if stage in {'awaiting_login', 'awaiting_2fa'}:
      raise HTTPException(
        status_code=409,
        detail='网络学堂尚未完成登录或二次认证，请先在弹出的浏览器窗口中完成认证。',
      )
    time.sleep(1.2)

  return last_url, last_title, last_source


def _extract_courses_from_session(session: LearnSyncSession) -> list[dict[str, str]]:
  if session.driver is None:
    courses = _course_sample_from_entries(session.course_entries)
    if courses:
      return courses
    raise HTTPException(status_code=502, detail='当前同步会话没有可用的课程列表。')
  current_url, _title, page_source = _wait_for_course_page(session)
  courses = _dedupe_courses(
    [
      *_extract_current_term_courses_from_dom(session.driver),
      *_extract_current_term_courses_from_html(page_source),
    ]
  )
  if courses:
    return courses

  host = urlparse(current_url).netloc
  raise HTTPException(
    status_code=502,
    detail=(
      f'当前已经进入 {host or "网络学堂"}，但没有在当前学期课程面板里识别到课程名称。'
      '系统现在只会抓取你截图里那一列蓝色课程标题，也不会再导入以前学期课程。'
    ),
  )


def _pull_courseware_for_one_course(
  session: LearnSyncSession,
  course_entry: dict[str, str],
  download_dir: Path,
  batch_id: str,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
  """拉取单门课程的所有课件文件，返回 (downloaded_files, skipped_files)。

  从 _pull_unread_courseware_from_session 抽出的单课程循环体，供按课程名拉取复用。
  """
  course_name = _normalize_text(course_entry.get('name'))
  courseware_href = _resolve_absolute_url(str(course_entry.get('coursewareHref') or ''))
  course_wlkcid = _extract_wlkcid_from_course_entry(course_entry)
  downloaded_files: list[dict[str, Any]] = []
  skipped_files: list[dict[str, str]] = []

  if not course_name or (not courseware_href and not course_wlkcid):
    skipped_files.append(
      {
        'courseName': course_name or '未命名课程',
        'fileName': '',
        'reason': '缺少课件列表入口，已跳过。',
      }
    )
    return downloaded_files, skipped_files

  api_failure_reason = ''
  try:
    api_records = _fetch_courseware_entries_via_api(session.driver, course_entry)
  except HTTPException as exc:
    api_records = []
    api_failure_reason = str(exc.detail or '')
  except Exception as exc:
    api_records = []
    api_failure_reason = str(exc)
  else:
    api_failure_reason = ''

  if api_records:
    referer = _build_courseware_list_referer(course_wlkcid or _extract_wlkcid_from_course_entry(course_entry))
    for record in api_records:
      if session.closed:
        break
      raw_file_name = _normalize_text(str(record.get('fallbackName') or record.get('displayName') or ''))
      wjid = _normalize_text(str(record.get('wjid') or ''))
      if not raw_file_name or not wjid:
        continue
      try:
        local_path = _download_courseware_file_via_api(
          session.driver,
          wjid,
          download_dir,
          raw_file_name,
          referer,
        )
      except HTTPException as exc:
        skipped_files.append(
          {
            'courseName': course_name,
            'fileName': raw_file_name,
            'reason': str(exc.detail or '课件接口下载失败'),
          }
        )
        continue

      mime_type = _normalize_text(mimetypes.guess_type(local_path.name)[0] or 'application/octet-stream')
      file_payload = {
        'id': _courseware_download_id(course_wlkcid, wjid),
        'courseName': course_name,
        'courseCode': _normalize_text(course_entry.get('courseCode')),
        'wlkcid': course_wlkcid,
        'semesterId': _normalize_text(course_entry.get('semesterId')),
        'semesterName': _normalize_text(course_entry.get('semesterName')),
        'fileName': local_path.name,
        'displayName': _normalize_text(str(record.get('displayName') or raw_file_name)),
        'byteSize': local_path.stat().st_size,
        'mimeType': mime_type or 'application/octet-stream',
        'kind': _guess_courseware_kind(local_path.name, mime_type),
        'downloadedAt': _utc_now(),
        'batchId': batch_id,
        'path': str(local_path),
      }
      downloaded_files.append(file_payload)
      session.downloaded_courseware.append(file_payload)
      time.sleep(0.2)
    return downloaded_files, skipped_files

  if not courseware_href:
    skipped_files.append(
      {
        'courseName': course_name,
        'fileName': '',
        'reason': api_failure_reason or '课件接口没有返回文件，且课程缺少页面入口。',
      }
    )
    return downloaded_files, skipped_files

  # 直接导航到该课程的课件列表页（课程文件 tab 内容页），等待播放列表加载出文件行。
  try:
    _open_courseware_page_by_url(session, courseware_href, course_name)
    rows = _wait_for_playli_download_icons(session.driver, 15)
  except HTTPException:
    if session.closed:
      return downloaded_files, skipped_files
    rows = []
  except Exception:
    if session.closed:
      return downloaded_files, skipped_files
    rows = []
  if not rows:
    skipped_files.append(
      {
        'courseName': course_name,
        'fileName': '',
        'reason': '该课程课件列表为空或未能加载出文件，已跳过。',
      }
    )
    try:
      session.driver.get(COURSE_HOME_URL)
      _ensure_course_home_ready(session)
    except Exception:
      pass
    return downloaded_files, skipped_files

  for row in rows:
    if session.closed:
      break
    try:
      title_node = row.find_element(By.CSS_SELECTOR, 'a.titlink .spancolor, a.titlink')
      raw_file_name = _normalize_text(title_node.text)
    except Exception:
      if session.closed:
        break
      raw_file_name = ''
    if not raw_file_name:
      # 取不到标题时，用文件类型/大小等属性兜底命名。
      try:
        raw_file_name = _normalize_text(row.get_attribute('kjbt')) or '未命名课件'
      except Exception:
        raw_file_name = '未命名课件'

    try:
      wjid = _normalize_text(row.get_attribute('wjid'))
    except Exception:
      wjid = ''
    if not wjid:
      skipped_files.append(
        {
          'courseName': course_name,
          'fileName': raw_file_name,
          'reason': '未找到课件文件标识，已跳过。',
        }
      )
      continue

    try:
      local_path = _download_courseware_file_via_http(
        session.driver,
        wjid,
        download_dir,
        raw_file_name,
      )
    except HTTPException as exc:
      if session.closed:
        break
      try:
        local_path = _download_courseware_file_via_click(
          session.driver,
          row,
          download_dir,
        )
      except HTTPException as fallback_exc:
        skipped_files.append(
          {
            'courseName': course_name,
            'fileName': raw_file_name,
            'reason': (
              f'{str(exc.detail) if exc.detail else "HTTP 下载失败"}；'
              f'页面点击回退也失败：{str(fallback_exc.detail) if fallback_exc.detail else "未知错误"}'
            ),
          }
        )
        continue

    mime_type = _normalize_text(mimetypes.guess_type(local_path.name)[0] or 'application/octet-stream')
    download_id = _courseware_download_id(course_wlkcid, wjid)
    file_payload = {
      'id': download_id,
      'courseName': course_name,
      'courseCode': _normalize_text(course_entry.get('courseCode')),
      'wlkcid': course_wlkcid,
      'semesterId': _normalize_text(course_entry.get('semesterId')),
      'semesterName': _normalize_text(course_entry.get('semesterName')),
      'fileName': local_path.name,
      'displayName': raw_file_name,
      'byteSize': local_path.stat().st_size,
      'mimeType': mime_type or 'application/octet-stream',
      'kind': _guess_courseware_kind(local_path.name, mime_type),
      'downloadedAt': _utc_now(),
      'batchId': batch_id,
      'path': str(local_path),
    }
    downloaded_files.append(file_payload)
    session.downloaded_courseware.append(file_payload)
    time.sleep(0.4)

  # 回到课程首页，准备处理下一门课。
  try:
    session.driver.get(COURSE_HOME_URL)
    _ensure_course_home_ready(session)
  except Exception:
    pass

  return downloaded_files, skipped_files


def _find_course_entry_in_entries(
  entries: list[dict[str, str]],
  course_name: str,
) -> dict[str, str] | None:
  def _strip_course_suffix(value: str) -> str:
    normalized = _normalize_text(value)
    return re.sub(r'\s*[\(（][^()（）]{2,40}[\)）]\s*$', '', normalized).strip()

  target_name = _normalize_text(course_name)
  target = target_name.casefold()
  target_base = _strip_course_suffix(target_name).casefold()
  target_code_match = re.search(r'[\(（]\s*([A-Za-z0-9-]{4,})\s*[\)）]\s*$', target_name)
  target_code = target_code_match.group(1).casefold() if target_code_match else ''
  if not target:
    return None

  exact_base_match: dict[str, str] | None = None
  fuzzy_match: dict[str, str] | None = None

  for entry in entries:
    entry_name = _normalize_text(entry.get('name'))
    entry_target = entry_name.casefold()
    if entry_target == target:
      return entry

    entry_base = _strip_course_suffix(entry_name).casefold()
    if target_base and entry_base == target_base:
      exact_base_match = exact_base_match or entry

    entry_code = _normalize_text(entry.get('courseCode')).casefold()
    if target_code and entry_code and entry_code == target_code:
      return entry

    if target_base and entry_base and (target_base in entry_base or entry_base in target_base):
      fuzzy_match = fuzzy_match or entry

  if exact_base_match is not None:
    return exact_base_match
  if fuzzy_match is not None:
    return fuzzy_match
  if len(entries) == 1:
    return entries[0]
  return None


def _find_course_entry_by_identity(
  entries: list[dict[str, str]],
  *,
  course_name: str,
  semester_id: str = '',
  course_code: str = '',
  wlkcid: str = '',
  strict_identity: bool = False,
) -> dict[str, str] | None:
  normalized_wlkcid = _normalize_text(wlkcid)
  normalized_course_code = _normalize_text(course_code).casefold()
  normalized_semester_id = _normalize_text(semester_id)
  normalized_course_name = _normalize_text(course_name)

  if normalized_wlkcid:
    for entry in entries:
      if normalized_semester_id and _normalize_text(entry.get('semesterId')) not in {'', normalized_semester_id}:
        continue
      if _normalize_text(entry.get('wlkcid')) == normalized_wlkcid:
        return entry

  # Automatic imports are only allowed to use the immutable remote course id.
  # Falling back to a display-name match can attach another course's files.
  if strict_identity:
    return None

  if normalized_course_code:
    for entry in entries:
      if normalized_semester_id and _normalize_text(entry.get('semesterId')) not in {'', normalized_semester_id}:
        continue
      if _normalize_text(entry.get('courseCode')).casefold() == normalized_course_code:
        return entry

  return _find_course_entry_in_entries(entries, normalized_course_name)


def _pull_courseware_for_one_course_via_api_session(
  session: LearnSyncSession,
  course_entry: dict[str, str],
  download_dir: Path,
  batch_id: str,
  known_file_ids: set[str] | None = None,
  known_file_names: set[str] | None = None,
  requested_file_ids: set[str] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
  course_name = _normalize_text(course_entry.get('name'))
  course_wlkcid = _extract_wlkcid_from_course_entry(course_entry)
  course_code = _normalize_text(course_entry.get('courseCode'))
  semester_id = _normalize_text(course_entry.get('semesterId'))
  semester_name = _normalize_text(course_entry.get('semesterName'))
  downloaded_files: list[dict[str, Any]] = []
  skipped_files: list[dict[str, str]] = []

  if not course_name or not course_wlkcid:
    skipped_files.append(
      {
        'courseName': course_name or '未命名课程',
        'fileName': '',
        'reason': '当前课程缺少 wlkcid，无法拉取课件。',
      }
    )
    return downloaded_files, skipped_files

  referer = _build_courseware_list_referer(course_wlkcid)
  try:
    api_records = _fetch_courseware_entries_via_api_for_session_v2(session, course_entry)
  except HTTPException as exc:
    skipped_files.append(
      {
        'courseName': course_name,
        'fileName': '',
        'reason': str(exc.detail or '课件列表接口请求失败'),
      }
    )
    return downloaded_files, skipped_files

  for record in api_records:
    if session.closed:
      break
    raw_file_name = _normalize_text(str(record.get('fallbackName') or record.get('displayName') or ''))
    display_name = _normalize_text(str(record.get('displayName') or raw_file_name))
    wjid = _normalize_text(str(record.get('wjid') or ''))
    if not raw_file_name or not wjid:
      continue
    download_id = _courseware_download_id(course_wlkcid, wjid)
    if requested_file_ids is not None and download_id not in requested_file_ids:
      continue
    if known_file_ids and download_id in known_file_ids:
      continue
    if known_file_names and {
      _courseware_file_name_key(raw_file_name),
      _courseware_file_name_key(display_name),
    }.intersection(known_file_names):
      skipped_files.append({
        'courseName': course_name,
        'fileName': display_name,
        'reason': '本地已保存同名课件，跳过下载。',
      })
      continue

    listed_mime_type = _normalize_text(
      str(record.get('mimeType') or mimetypes.guess_type(raw_file_name)[0] or 'application/octet-stream')
    )
    listed_kind = _guess_courseware_kind(raw_file_name, listed_mime_type)
    if listed_kind not in {'pdf', 'office'}:
      skipped_files.append({
        'courseName': course_name,
        'fileName': display_name,
        'reason': '该文件不是 PDF 或 Office 文档，暂不支持导入知识库。',
      })
      continue

    try:
      local_path = _download_courseware_file_via_api_for_session(
        session,
        wjid,
        download_dir,
        raw_file_name,
        referer,
      )
    except HTTPException as exc:
      skipped_files.append(
        {
          'courseName': course_name,
          'fileName': raw_file_name,
          'reason': str(exc.detail or '课件下载失败'),
        }
      )
      continue

    mime_type = _normalize_text(mimetypes.guess_type(local_path.name)[0] or 'application/octet-stream')
    file_payload = {
      'id': download_id,
      'courseName': course_name,
      'courseCode': course_code,
      'wlkcid': course_wlkcid,
      'semesterId': semester_id,
      'semesterName': semester_name,
      'fileName': local_path.name,
      'displayName': display_name,
      'byteSize': local_path.stat().st_size,
      'mimeType': mime_type or 'application/octet-stream',
      'kind': _guess_courseware_kind(local_path.name, mime_type),
      'downloadedAt': _utc_now(),
      'batchId': batch_id,
      'path': str(local_path),
    }
    downloaded_files.append(file_payload)
    session.downloaded_courseware.append(file_payload)
    time.sleep(0.15)

  return downloaded_files, skipped_files


def _pull_unread_courseware_from_session(session: LearnSyncSession) -> dict[str, Any]:
  if session.driver is None:
    if session.closed:
      raise HTTPException(status_code=409, detail='同步已关闭，课件拉取已中止。')
    course_entries = session.course_entries
    if not course_entries:
      raise HTTPException(status_code=502, detail='当前同步会话没有课程列表。')
    batch_id = f'courseware-{int(time.time() * 1000)}'
    download_dir = session.runtime_dir / 'downloads' / batch_id
    download_dir.mkdir(parents=True, exist_ok=True)
    downloaded_files: list[dict[str, Any]] = []
    skipped_files: list[dict[str, str]] = []
    for course in course_entries:
      if session.closed:
        break
      course_downloaded, course_skipped = _pull_courseware_for_one_course_via_api_session(
        session, course, download_dir, batch_id
      )
      downloaded_files.extend(course_downloaded)
      skipped_files.extend(course_skipped)
    session.updated_at = _utc_now()
    return {
      'sessionId': session.session_id,
      'batchId': batch_id,
      'files': [{key: value for key, value in item.items() if key != 'path'} for item in downloaded_files],
      'skipped': skipped_files,
      'count': len(downloaded_files),
      'updatedAt': session.updated_at,
    }

  _wait_for_course_page(session)
  _ensure_course_home_ready(session)

  if session.closed:
    raise HTTPException(status_code=409, detail='同步已关闭，课件拉取已中止。')

  course_entries = _extract_current_term_course_material_entries(session.driver)
  if not course_entries:
    raise HTTPException(status_code=502, detail='未能在当前学期课程列表中识别到课程。')

  batch_id = f'courseware-{int(time.time() * 1000)}'
  download_dir = session.runtime_dir / 'downloads' / batch_id
  _configure_download_dir(session.driver, download_dir)

  downloaded_files: list[dict[str, Any]] = []
  skipped_files: list[dict[str, str]] = []

  for course in course_entries:
    if session.closed:
      break
    course_downloaded, course_skipped = _pull_courseware_for_one_course(
      session, course, download_dir, batch_id
    )
    downloaded_files.extend(course_downloaded)
    skipped_files.extend(course_skipped)

  session.updated_at = _utc_now()
  return {
    'sessionId': session.session_id,
    'batchId': batch_id,
    'files': [{key: value for key, value in item.items() if key != 'path'} for item in downloaded_files],
    'skipped': skipped_files,
    'count': len(downloaded_files),
    'updatedAt': session.updated_at,
  }


def _find_course_entry_by_name(driver: webdriver.Chrome, course_name: str) -> dict[str, str] | None:
  target = _normalize_text(course_name).casefold()
  if not target:
    return None
  for entry in _extract_current_term_course_material_entries(driver):
    if _normalize_text(entry.get('name')).casefold() == target:
      return entry
  return None


def _pull_courseware_by_name(session: LearnSyncSession, course_name: str) -> dict[str, Any]:
  if session.driver is None:
    if session.closed:
      raise HTTPException(status_code=409, detail='同步已关闭，课件拉取已中止。')
    entry = _find_course_entry_in_entries(session.course_entries, course_name)
    if entry is None:
      raise HTTPException(status_code=404, detail=f'未在当前同步会话中找到名为“{course_name}”的课程。')
    batch_id = f'courseware-{int(time.time() * 1000)}'
    download_dir = session.runtime_dir / 'downloads' / batch_id
    download_dir.mkdir(parents=True, exist_ok=True)
    downloaded_files, skipped_files = _pull_courseware_for_one_course_via_api_session(
      session, entry, download_dir, batch_id
    )
    session.updated_at = _utc_now()
    return {
      'sessionId': session.session_id,
      'batchId': batch_id,
      'courseName': course_name,
      'files': [{key: value for key, value in item.items() if key != 'path'} for item in downloaded_files],
      'skipped': skipped_files,
      'count': len(downloaded_files),
      'updatedAt': session.updated_at,
    }

  _wait_for_course_page(session)
  _ensure_course_home_ready(session)

  if session.closed:
    raise HTTPException(status_code=409, detail='同步已关闭，课件拉取已中止。')

  entry = _find_course_entry_by_name(session.driver, course_name)
  if entry is None:
    raise HTTPException(
      status_code=404,
      detail=f'未在网络学堂当前学期课程中找到名为“{course_name}”的课程。',
    )

  batch_id = f'courseware-{int(time.time() * 1000)}'
  download_dir = session.runtime_dir / 'downloads' / batch_id
  _configure_download_dir(session.driver, download_dir)

  downloaded_files, skipped_files = _pull_courseware_for_one_course(
    session, entry, download_dir, batch_id
  )

  session.updated_at = _utc_now()
  return {
    'sessionId': session.session_id,
    'batchId': batch_id,
    'courseName': course_name,
    'files': [{key: value for key, value in item.items() if key != 'path'} for item in downloaded_files],
    'skipped': skipped_files,
    'count': len(downloaded_files),
    'updatedAt': session.updated_at,
  }


def _ensure_api_ready_session(session: LearnSyncSession) -> list[dict[str, Any]]:
  if session.closed:
    raise HTTPException(status_code=409, detail='同步会话已关闭，请重新启动网络学堂同步。')

  if session.driver is not None:
    try:
      _persist_cookies(session.driver)
    except Exception:
      pass
    persisted = _load_persisted_cookies()
    if persisted:
      session.cookies = persisted

  if session.cookies:
    return session.cookies

  raise HTTPException(status_code=502, detail='当前同步会话没有可用的网络学堂登录 cookie。')


def _load_semesters_for_session(session: LearnSyncSession) -> list[dict[str, Any]]:
  cookies = _ensure_api_ready_session(session)
  return _fetch_semesters_via_cookie_session(cookies)


def _load_course_entries_for_session(
  session: LearnSyncSession,
  semester_id: str,
) -> tuple[list[dict[str, str]], dict[str, Any] | None]:
  cookies = _ensure_api_ready_session(session)
  semesters = _fetch_semesters_via_cookie_session(cookies)
  target_semester_id = _normalize_text(semester_id)
  matched_semester = next(
    (
      item
      for item in semesters
      if _normalize_text(str(item.get('id') or item.get('semesterId') or '')) == target_semester_id
    ),
    None,
  )
  if target_semester_id and matched_semester is None:
    raise HTTPException(status_code=404, detail=f'未找到学期 {target_semester_id} 对应的网络学堂课程列表。')

  resolved_semester = matched_semester or next((item for item in semesters if item.get('isCurrent')), None)
  resolved_semester_id = _normalize_text(
    str((resolved_semester or {}).get('id') or (resolved_semester or {}).get('semesterId') or '')
  )
  entries = _fetch_course_entries_for_semester_via_cookie_session(cookies, resolved_semester_id)
  # A historical-term pageList response must never be reused for another term.
  # Keep only entries explicitly belonging to the semester selected for this request.
  if resolved_semester_id:
    entries = [
      entry
      for entry in entries
      if _normalize_text(entry.get('semesterId')) == resolved_semester_id
    ]
  if not entries:
    semester_label = _normalize_text(str((resolved_semester or {}).get('semesterName') or resolved_semester_id))
    raise HTTPException(status_code=404, detail=f'未找到学期 {semester_label or "当前学期"} 的网络学堂课程。')
  session.course_entries = entries
  session.updated_at = _utc_now()
  return entries, resolved_semester


def _pull_courseware_by_course_identity(
  session: LearnSyncSession,
  *,
  course_name: str,
  semester_id: str = '',
  course_code: str = '',
  wlkcid: str = '',
  known_file_ids: set[str] | None = None,
  known_file_names: set[str] | None = None,
  requested_file_ids: set[str] | None = None,
  strict_identity: bool = False,
) -> dict[str, Any]:
  entries, matched_semester = _load_course_entries_for_session(session, semester_id)
  entry = _find_course_entry_by_identity(
    entries,
    course_name=course_name,
    semester_id=semester_id,
    course_code=course_code,
    wlkcid=wlkcid,
    strict_identity=strict_identity,
  )
  if entry is None:
    raise HTTPException(
      status_code=404,
      detail=(
        f'未在学期 {semester_id or "当前学期"} 中找到课程“{course_name}”。'
      ),
    )

  batch_id = f'courseware-{int(time.time() * 1000)}'
  download_dir = session.runtime_dir / 'downloads' / batch_id
  download_dir.mkdir(parents=True, exist_ok=True)
  downloaded_files, skipped_files = _pull_courseware_for_one_course_via_api_session(
    session,
    entry,
    download_dir,
    batch_id,
    known_file_ids,
    known_file_names,
    requested_file_ids,
  )

  semester_payload = matched_semester or {
    'id': _normalize_text(entry.get('semesterId')),
    'semesterName': _normalize_text(entry.get('semesterName')),
  }
  session.updated_at = _utc_now()
  return {
    'sessionId': session.session_id,
    'batchId': batch_id,
    'courseName': course_name,
    'semesterId': _normalize_text(str(semester_payload.get('id') or semester_payload.get('semesterId') or '')),
    'semesterName': _normalize_text(str(semester_payload.get('semesterName') or '')),
    'files': [{key: value for key, value in item.items() if key != 'path'} for item in downloaded_files],
    'skipped': skipped_files,
    'count': len(downloaded_files),
    'updatedAt': session.updated_at,
  }


def _list_courseware_by_course_identity(
  session: LearnSyncSession,
  *,
  course_name: str,
  semester_id: str = '',
  course_code: str = '',
  wlkcid: str = '',
  strict_identity: bool = False,
) -> dict[str, Any]:
  """Return remote metadata without downloading files into the runtime folder."""
  entries, matched_semester = _load_course_entries_for_session(session, semester_id)
  entry = _find_course_entry_by_identity(
    entries,
    course_name=course_name,
    semester_id=semester_id,
    course_code=course_code,
    wlkcid=wlkcid,
    strict_identity=strict_identity,
  )
  if entry is None:
    raise HTTPException(status_code=404, detail=f'Unable to find course "{course_name}".')

  course_wlkcid = _extract_wlkcid_from_course_entry(entry)
  if not course_wlkcid:
    raise HTTPException(status_code=422, detail='The selected course has no wlkcid.')
  records = _fetch_courseware_entries_via_api_for_session_v2(session, entry)
  listed_at = _utc_now()
  files: list[dict[str, Any]] = []
  for record in records:
    raw_file_name = _normalize_text(str(record.get('fallbackName') or record.get('displayName') or ''))
    display_name = _normalize_text(str(record.get('displayName') or raw_file_name))
    wjid = _normalize_text(str(record.get('wjid') or ''))
    if not raw_file_name or not wjid:
      continue
    mime_type = _normalize_text(str(record.get('mimeType') or mimetypes.guess_type(raw_file_name)[0] or 'application/octet-stream'))
    try:
      byte_size = int(record.get('byteSize') or record.get('fileSize') or 0)
    except (TypeError, ValueError):
      byte_size = 0
    files.append({
      'id': _courseware_download_id(course_wlkcid, wjid),
      'courseName': _normalize_text(entry.get('name')),
      'courseCode': _normalize_text(entry.get('courseCode')),
      'wlkcid': course_wlkcid,
      'semesterId': _normalize_text(entry.get('semesterId')),
      'semesterName': _normalize_text(entry.get('semesterName')),
      'fileName': raw_file_name,
      'displayName': display_name,
      'byteSize': byte_size,
      'mimeType': mime_type or 'application/octet-stream',
      'kind': _guess_courseware_kind(raw_file_name, mime_type),
      'downloadedAt': listed_at,
      'batchId': '',
    })

  semester_payload = matched_semester or {
    'id': _normalize_text(entry.get('semesterId')),
    'semesterName': _normalize_text(entry.get('semesterName')),
  }
  session.updated_at = listed_at
  return {
    'sessionId': session.session_id,
    'courseName': course_name,
    'semesterId': _normalize_text(str(semester_payload.get('id') or semester_payload.get('semesterId') or '')),
    'semesterName': _normalize_text(str(semester_payload.get('semesterName') or '')),
    'files': files,
    'count': len(files),
    'updatedAt': session.updated_at,
  }


@tsinghua_router.post('/start')
def start_tsinghua_sync() -> dict[str, Any]:
  session = _registry.create()
  payload = _registry.status_payload(session)
  payload['targetUrl'] = COURSE_HOME_URL
  if session.driver is None and session.course_entries:
    payload['message'] = '已复用已登录的网络学堂会话，这次不会再弹出登录窗口。'
    return payload
  auth_config = load_tsinghua_auth_config()
  if auth_config and auth_config.get('username') and auth_config.get('password'):
    payload['message'] = '浏览器已打开。系统会自动填充已保存的网络学堂账号密码，并优先复用上一次的登录会话。'
  else:
    payload['message'] = '浏览器已打开，请在该窗口完成网络学堂登录与二次认证。'
  return payload


@tsinghua_router.get('/config')
def get_tsinghua_sync_config() -> dict[str, Any]:
  return build_tsinghua_auth_public_config(load_tsinghua_auth_config())


@tsinghua_router.put('/config')
def update_tsinghua_sync_config(payload: dict[str, Any]) -> dict[str, Any]:
  config = save_tsinghua_auth_config(payload)
  return build_tsinghua_auth_public_config(config)


@tsinghua_router.get('/courseware/auto-sync-state')
def get_courseware_auto_sync_state() -> dict[str, Any]:
  return {'suppressed': load_suppressed_courseware()}


@tsinghua_router.get('/{session_id}')
def get_tsinghua_sync_status(session_id: str) -> dict[str, Any]:
  session = _registry.get(session_id)
  return _registry.status_payload(session)


@tsinghua_router.get('/{session_id}/semesters')
def get_tsinghua_sync_semesters(session_id: str) -> dict[str, Any]:
  session = _registry.get(session_id)
  semesters = _load_semesters_for_session(session)
  current = next((item for item in semesters if item.get('isCurrent')), None)
  return {
    'sessionId': session.session_id,
    'semesters': semesters,
    'currentSemesterId': _normalize_text(str((current or {}).get('id') or (current or {}).get('semesterId') or '')),
    'updatedAt': _utc_now(),
  }


@tsinghua_router.post('/{session_id}/import')
def import_tsinghua_courses(
  session_id: str,
  payload: dict[str, Any] | None = Body(default=None),
) -> dict[str, Any]:
  session = _registry.get(session_id)
  requested_semester_id = _normalize_text(str((payload or {}).get('semesterId') or ''))
  courses, matched_semester = _load_course_entries_for_session(session, requested_semester_id)
  session.imported_courses = courses
  session.updated_at = _utc_now()
  return {
    'sessionId': session.session_id,
    'stage': 'completed',
    'courses': courses,
    'semesterId': _normalize_text(str((matched_semester or {}).get('id') or (matched_semester or {}).get('semesterId') or '')),
    'semesterName': _normalize_text(str((matched_semester or {}).get('semesterName') or '')),
    'count': len(courses),
    'updatedAt': session.updated_at,
  }


@tsinghua_router.post('/{session_id}/courseware/pull')
def pull_tsinghua_courseware(
  session_id: str,
  payload: dict[str, Any] | None = Body(default=None),
) -> dict[str, Any]:
  session = _registry.get(session_id)
  requested_semester_id = _normalize_text(str((payload or {}).get('semesterId') or ''))
  entries, matched_semester = _load_course_entries_for_session(session, requested_semester_id)
  batch_id = f'courseware-{int(time.time() * 1000)}'
  download_dir = session.runtime_dir / 'downloads' / batch_id
  download_dir.mkdir(parents=True, exist_ok=True)
  downloaded_files: list[dict[str, Any]] = []
  skipped_files: list[dict[str, str]] = []
  for course in entries:
    if session.closed:
      break
    course_downloaded, course_skipped = _pull_courseware_for_one_course_via_api_session(
      session,
      course,
      download_dir,
      batch_id,
    )
    downloaded_files.extend(course_downloaded)
    skipped_files.extend(course_skipped)
  session.updated_at = _utc_now()
  return {
    'sessionId': session.session_id,
    'batchId': batch_id,
    'semesterId': _normalize_text(str((matched_semester or {}).get('id') or (matched_semester or {}).get('semesterId') or '')),
    'semesterName': _normalize_text(str((matched_semester or {}).get('semesterName') or '')),
    'files': [{key: value for key, value in item.items() if key != 'path'} for item in downloaded_files],
    'skipped': skipped_files,
    'count': len(downloaded_files),
    'updatedAt': session.updated_at,
  }


@tsinghua_router.post('/{session_id}/courseware/pull-by-name')
def pull_tsinghua_courseware_by_name(
  session_id: str, payload: dict[str, Any]
) -> dict[str, Any]:
  session = _registry.get(session_id)
  course_name = _normalize_text(payload.get('courseName', ''))
  if not course_name:
    raise HTTPException(status_code=422, detail='courseName is required.')
  return _pull_courseware_by_name(session, course_name)


@tsinghua_router.post('/{session_id}/courseware/pull-by-course')
def pull_tsinghua_courseware_by_course(
  session_id: str,
  payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
  session = _registry.get(session_id)
  course_name = _normalize_text(payload.get('courseName', ''))
  if not course_name:
    raise HTTPException(status_code=422, detail='courseName is required.')
  semester_id = _normalize_text(payload.get('semesterId', ''))
  course_code = _normalize_text(payload.get('courseCode', ''))
  wlkcid = _normalize_text(payload.get('wlkcid', ''))
  strict_identity = bool(payload.get('strictIdentity'))
  if strict_identity and not wlkcid:
    raise HTTPException(status_code=422, detail='strictIdentity requires wlkcid.')
  if strict_identity and not semester_id:
    raise HTTPException(status_code=422, detail='strictIdentity requires the course semesterId.')
  known_file_ids = {
    _normalize_text(item)
    for item in payload.get('knownFileIds') or []
    if isinstance(item, str) and _normalize_text(item)
  }
  known_file_names = {
    _courseware_file_name_key(item)
    for item in payload.get('knownFileNames') or []
    if isinstance(item, str) and _courseware_file_name_key(item)
  }
  requested_file_ids = {
    _normalize_text(item)
    for item in payload.get('requestedFileIds') or []
    if isinstance(item, str) and _normalize_text(item)
  }
  return _pull_courseware_by_course_identity(
    session,
    course_name=course_name,
    semester_id=semester_id,
    course_code=course_code,
    wlkcid=wlkcid,
    known_file_ids=known_file_ids,
    known_file_names=known_file_names,
    requested_file_ids=requested_file_ids or None,
    strict_identity=strict_identity,
  )


@tsinghua_router.post('/{session_id}/courseware/list-by-course')
def list_tsinghua_courseware_by_course(
  session_id: str,
  payload: dict[str, Any] = Body(...),
) -> dict[str, Any]:
  session = _registry.get(session_id)
  course_name = _normalize_text(payload.get('courseName', ''))
  if not course_name:
    raise HTTPException(status_code=422, detail='courseName is required.')
  strict_identity = bool(payload.get('strictIdentity'))
  wlkcid = _normalize_text(payload.get('wlkcid', ''))
  semester_id = _normalize_text(payload.get('semesterId', ''))
  if strict_identity and not wlkcid:
    raise HTTPException(status_code=422, detail='strictIdentity requires wlkcid.')
  if strict_identity and not semester_id:
    raise HTTPException(status_code=422, detail='strictIdentity requires the course semesterId.')
  return _list_courseware_by_course_identity(
    session,
    course_name=course_name,
    semester_id=semester_id,
    course_code=_normalize_text(payload.get('courseCode', '')),
    wlkcid=wlkcid,
    strict_identity=strict_identity,
  )


@tsinghua_router.post('/courseware/restore')
def restore_tsinghua_courseware(payload: dict[str, Any] = Body(...)) -> dict[str, int]:
  source_keys = [
    _normalize_text(item)
    for item in payload.get('sourceKeys') or []
    if isinstance(item, str) and _normalize_text(item).startswith('tsinghua-courseware:')
  ]
  restore_deleted_synced_courseware(source_keys)
  restore_knowledge_file_source_keys(source_keys)
  return {'restored': len(source_keys)}


@tsinghua_router.get('/{session_id}/courseware/{download_id}')
def read_tsinghua_courseware_file(session_id: str, download_id: str) -> FileResponse:
  session = _registry.get(session_id)
  record = next(
    (item for item in session.downloaded_courseware if str(item.get('id')) == download_id),
    None,
  )
  if not record:
    raise HTTPException(status_code=404, detail='未找到指定的课件下载记录。')

  local_path = Path(str(record.get('path') or ''))
  if not local_path.is_file():
    raise HTTPException(status_code=404, detail='课件文件已不存在，请重新拉取。')

  return FileResponse(
    path=local_path,
    filename=str(record.get('fileName') or local_path.name),
    media_type=str(record.get('mimeType') or 'application/octet-stream'),
  )


@tsinghua_router.delete('/{session_id}')
def close_tsinghua_sync(session_id: str) -> dict[str, bool]:
  _registry.close(session_id)
  return {'closed': True}
