from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.tsinghua_courseware_state import (
  load_suppressed_courseware,
  mark_deleted_synced_homework,
  restore_deleted_synced_courseware,
)
from backend.tsinghua_sync_state import LearnSyncRegistry, LearnSyncRegistryDeps


class TsinghuaSyncStateTest(unittest.TestCase):
  def setUp(self):
    self.temporary_directory = tempfile.TemporaryDirectory()
    self.login_calls = 0
    self.cookies = [{'name': 'session', 'value': 'valid'}]
    self.registry = LearnSyncRegistry(LearnSyncRegistryDeps(
      sync_runtime_dir=Path(self.temporary_directory.name),
      course_home_url='https://learn.example/courses',
      learn_host='learn.example',
      load_persisted_cookies=lambda: list(self.cookies),
      fetch_course_entries_via_cookie_session_v2=lambda _cookies: [
        {'courseId': 'course-1', 'name': 'Course 1'},
      ],
      load_auth_config=lambda: {'username': 'user', 'password': 'password'},
      normalize_text=lambda value: str(value or '').strip(),
      course_sample_from_entries=lambda entries: entries[:8],
      guess_stage=lambda *_args: 'ready',
      extract_current_term_courses_from_dom=lambda _driver: [],
      extract_current_term_courses_from_html=lambda _html: [],
      persist_cookies=lambda _driver: None,
      find_browser_binary=lambda: 'chrome',
      utc_now=lambda: '2026-08-30T00:00:00',
      run_playwright_login=self.run_login,
      normalize_course_material_entries=lambda value: list(value or []),
      persist_cookie_payload=lambda _cookies: None,
    ))

  def tearDown(self):
    self.temporary_directory.cleanup()

  def run_login(self, *_args):
    self.login_calls += 1
    return {'cookies': self.cookies, 'courseEntries': []}

  def test_valid_cookie_session_skips_browser_login(self):
    session = self.registry.create()

    self.assertEqual('ready', session.stage)
    self.assertEqual(0, self.login_calls)
    self.assertEqual('course-1', session.course_entries[0]['courseId'])

  def test_close_is_idempotent_and_removes_runtime_directory(self):
    session = self.registry.create()

    self.assertTrue(self.registry.close(session.session_id))
    self.assertTrue(self.registry.close(session.session_id))
    self.assertFalse(session.runtime_dir.exists())

  def test_synced_homework_uses_same_suppression_and_restore_policy(self):
    state_path = Path(self.temporary_directory.name) / 'auto-sync-state.json'
    with patch('backend.tsinghua_courseware_state.STATE_PATH', state_path):
      mark_deleted_synced_homework({
        'sourceKey': 'tsinghua-homework:homework-1',
        'courseId': 'course-1',
        'fileName': '第一次作业.pdf',
      })
      suppressed = load_suppressed_courseware()
      self.assertEqual('tsinghua-homework:homework-1', suppressed[0]['sourceKey'])
      self.assertEqual('course-1', suppressed[0]['courseId'])

      restore_deleted_synced_courseware({'tsinghua-homework:homework-1'})
      self.assertEqual([], load_suppressed_courseware())


if __name__ == '__main__':
  unittest.main()
