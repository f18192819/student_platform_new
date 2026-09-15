from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.deepseek_web_process import DeepSeekWebProcessManager, DeepSeekWebStartupError


class Response:
  def __init__(self, status_code: int) -> None:
    self.status_code = status_code


class Process:
  pid = 321

  def poll(self):
    return None


class DeepSeekWebProcessManagerTest(unittest.TestCase):
  def test_ready_bridge_is_not_started_twice(self):
    launches = []
    manager = DeepSeekWebProcessManager(
      get=lambda *_args, **_kwargs: Response(200),
      popen=lambda *args, **kwargs: launches.append((args, kwargs)),
    )

    result = manager.ensure_started('http://127.0.0.1:8765')

    self.assertFalse(result['started'])
    self.assertTrue(result['ready'])
    self.assertEqual([], launches)

  def test_starts_bundled_uvicorn_and_waits_until_healthy(self):
    responses = iter([Response(503), Response(503), Response(200)])
    launches = []

    def popen(command, **kwargs):
      launches.append((command, kwargs))
      return Process()

    with tempfile.TemporaryDirectory() as temporary, patch(
      'backend.deepseek_web_process.PROJECT_ROOT', Path(temporary),
    ):
      manager = DeepSeekWebProcessManager(
        get=lambda *_args, **_kwargs: next(responses),
        popen=popen,
        sleep=lambda _seconds: None,
      )
      result = manager.ensure_started('http://localhost:9876')

    self.assertTrue(result['started'])
    self.assertEqual(321, result['pid'])
    self.assertIn('tools.deepseek_web_bridge.app:app', launches[0][0])
    self.assertEqual('9876', launches[0][0][-1])
    self.assertEqual(str(Path(temporary)), launches[0][1]['cwd'])

  def test_auto_start_rejects_https_even_on_loopback(self):
    manager = DeepSeekWebProcessManager(get=lambda *_args, **_kwargs: Response(503))
    with self.assertRaises(DeepSeekWebStartupError):
      manager.ensure_started('https://127.0.0.1:8765')


if __name__ == '__main__':
  unittest.main()
