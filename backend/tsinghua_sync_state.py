from __future__ import annotations

import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any, Callable

from fastapi import HTTPException
from selenium import webdriver


@dataclass
class LearnSyncSession:
  session_id: str
  driver: webdriver.Chrome | None = None
  runtime_dir: Path = Path('.')
  browser_binary: str = ''
  created_at: str = ''
  updated_at: str = ''
  stage: str = 'navigating'
  current_url: str = ''
  title: str = ''
  cookies: list[dict[str, Any]] = field(default_factory=list)
  course_entries: list[dict[str, str]] = field(default_factory=list)
  imported_courses: list[dict[str, str]] = field(default_factory=list)
  downloaded_courseware: list[dict[str, Any]] = field(default_factory=list)
  last_error: str | None = None
  closed: bool = False

  def status_payload(
    self,
    *,
    course_sample_from_entries: Callable[[list[dict[str, str]]], list[dict[str, str]]],
    guess_stage: Callable[[str, str, str], str],
    extract_current_term_courses_from_dom: Callable[[webdriver.Chrome], list[dict[str, str]]],
    extract_current_term_courses_from_html: Callable[[str], list[dict[str, str]]],
    persist_cookies: Callable[[webdriver.Chrome], None],
  ) -> dict[str, Any]:
    if self.driver is None:
      sample = course_sample_from_entries(self.course_entries)
      stage = self.stage
      if stage not in {'awaiting_login', 'awaiting_2fa', 'closed'} and sample:
        stage = 'ready'
      return {
        'sessionId': self.session_id,
        'stage': stage,
        'currentUrl': self.current_url,
        'title': self.title,
        'courseSample': sample,
        'importedCourses': self.imported_courses,
        'lastError': self.last_error,
        'createdAt': self.created_at,
        'updatedAt': self.updated_at,
      }
    try:
      current_url = self.driver.current_url
      title = self.driver.title
      page_source = self.driver.page_source
      stage = guess_stage(current_url, title, page_source)
      dom_sample = extract_current_term_courses_from_dom(self.driver)
      html_sample = extract_current_term_courses_from_html(page_source)
      sample = (dom_sample or html_sample)[:8]
      if stage not in {'awaiting_login', 'awaiting_2fa'} and sample:
        stage = 'ready'
        persist_cookies(self.driver)
      return {
        'sessionId': self.session_id,
        'stage': stage,
        'currentUrl': current_url,
        'title': title,
        'courseSample': sample,
        'importedCourses': self.imported_courses,
        'lastError': self.last_error,
        'createdAt': self.created_at,
        'updatedAt': self.updated_at,
      }
    except Exception as exc:
      return {
        'sessionId': self.session_id,
        'stage': 'closed',
        'currentUrl': '',
        'title': '',
        'courseSample': [],
        'importedCourses': self.imported_courses,
        'lastError': self.last_error or str(exc),
        'createdAt': self.created_at,
        'updatedAt': self.updated_at,
      }


@dataclass(frozen=True)
class LearnSyncRegistryDeps:
  sync_runtime_dir: Path
  course_home_url: str
  learn_host: str
  load_persisted_cookies: Callable[[], list[dict[str, Any]]]
  fetch_course_entries_via_cookie_session_v2: Callable[[list[dict[str, Any]]], list[dict[str, str]]]
  load_auth_config: Callable[[], dict[str, Any] | None]
  normalize_text: Callable[[Any], str]
  course_sample_from_entries: Callable[[list[dict[str, str]]], list[dict[str, str]]]
  guess_stage: Callable[[str, str, str], str]
  extract_current_term_courses_from_dom: Callable[[webdriver.Chrome], list[dict[str, str]]]
  extract_current_term_courses_from_html: Callable[[str], list[dict[str, str]]]
  persist_cookies: Callable[[webdriver.Chrome], None]
  find_browser_binary: Callable[[], str]
  utc_now: Callable[[], str]
  run_playwright_login: Callable[[Path, str, str, str], dict[str, Any]]
  normalize_course_material_entries: Callable[[Any], list[dict[str, str]]]
  persist_cookie_payload: Callable[[list[dict[str, Any]]], None]


class LearnSyncRegistry:
  def __init__(self, deps: LearnSyncRegistryDeps) -> None:
    self._deps = deps
    self._lock = Lock()
    self._sessions: dict[str, LearnSyncSession] = {}

  def create(self) -> LearnSyncSession:
    with self._lock:
      existing_ids = list(self._sessions.keys())
    for existing_id in existing_ids:
      self.close(existing_id)

    persisted_cookies = self._deps.load_persisted_cookies()
    if persisted_cookies:
      try:
        course_entries = self._deps.fetch_course_entries_via_cookie_session_v2(persisted_cookies)
      except HTTPException:
        course_entries = []
      if course_entries:
        session_id = f'learn-sync-{int(time.time() * 1000)}'
        runtime_dir = self._deps.sync_runtime_dir / session_id
        runtime_dir.mkdir(parents=True, exist_ok=True)
        created_at = self._deps.utc_now()
        session = LearnSyncSession(
          session_id=session_id,
          runtime_dir=runtime_dir,
          browser_binary=self._deps.find_browser_binary(),
          created_at=created_at,
          updated_at=created_at,
          stage='ready',
          current_url=self._deps.course_home_url,
          title='网络学堂',
          cookies=persisted_cookies,
          course_entries=course_entries,
        )
        with self._lock:
          self._sessions[session_id] = session
        return session

    auth_config = self._deps.load_auth_config()
    username = self._deps.normalize_text(str((auth_config or {}).get('username') or ''))
    password = str((auth_config or {}).get('password') or '')
    if not username or not password:
      raise HTTPException(status_code=422, detail='请先在 API 配置中填写网络学堂用户名和密码。')

    session_id = f'learn-sync-{int(time.time() * 1000)}'
    runtime_dir = self._deps.sync_runtime_dir / session_id
    runtime_dir.mkdir(parents=True, exist_ok=True)
    browser_binary = self._deps.find_browser_binary()
    created_at = self._deps.utc_now()
    session = LearnSyncSession(
      session_id=session_id,
      runtime_dir=runtime_dir,
      browser_binary=browser_binary,
      created_at=created_at,
      updated_at=created_at,
      stage='navigating',
      current_url=self._deps.course_home_url,
      title='网络学堂同步中',
    )

    with self._lock:
      self._sessions[session_id] = session

    try:
      payload = self._deps.run_playwright_login(runtime_dir, browser_binary, username, password)
      session.cookies = [item for item in payload.get('cookies', []) if isinstance(item, dict)]
      payload_entries = self._deps.normalize_course_material_entries(payload.get('courseEntries'))
      session.course_entries = payload_entries or self._deps.fetch_course_entries_via_cookie_session_v2(session.cookies)
      session.current_url = self._deps.normalize_text(str(payload.get('currentUrl') or self._deps.course_home_url))
      session.title = self._deps.normalize_text(str(payload.get('title') or '网络学堂'))
      session.stage = 'ready' if session.course_entries else 'awaiting_login'
      session.updated_at = self._deps.utc_now()
      self._deps.persist_cookie_payload(session.cookies)
      if not session.course_entries:
        raise HTTPException(status_code=502, detail='登录成功，但没有拿到课程列表。')
      return session
    except HTTPException as exc:
      session.stage = 'awaiting_login'
      session.last_error = str(exc.detail or '')
      session.updated_at = self._deps.utc_now()
      with self._lock:
        self._sessions.pop(session_id, None)
      shutil.rmtree(runtime_dir, ignore_errors=True)
      raise

  def get(self, session_id: str) -> LearnSyncSession:
    with self._lock:
      session = self._sessions.get(session_id)
    if not session:
      raise HTTPException(status_code=404, detail='网络学堂同步会话不存在或已关闭。')
    return session

  def close(self, session_id: str) -> bool:
    with self._lock:
      session = self._sessions.get(session_id)
    if session is None:
      return True

    session.closed = True

    if session.driver is not None:
      try:
        self._deps.persist_cookies(session.driver)
      except Exception:
        pass

      def _quit_driver() -> None:
        try:
          session.driver.quit()
        except Exception:
          pass

      quit_thread = threading.Thread(target=_quit_driver, daemon=True)
      quit_thread.start()
      quit_thread.join(timeout=5.0)

    shutil.rmtree(session.runtime_dir, ignore_errors=True)
    with self._lock:
      self._sessions.pop(session_id, None)
    return True

  def status_payload(self, session: LearnSyncSession) -> dict[str, Any]:
    return session.status_payload(
      course_sample_from_entries=self._deps.course_sample_from_entries,
      guess_stage=self._deps.guess_stage,
      extract_current_term_courses_from_dom=self._deps.extract_current_term_courses_from_dom,
      extract_current_term_courses_from_html=self._deps.extract_current_term_courses_from_html,
      persist_cookies=self._deps.persist_cookies,
    )
