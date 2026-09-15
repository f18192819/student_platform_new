from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests

from .config import PROJECT_ROOT
from .deepseek_web_bridge import normalize_bridge_url


class DeepSeekWebStartupError(RuntimeError):
  pass


class DeepSeekWebProcessManager:
  """Starts only the bundled loopback Bridge and coalesces concurrent requests."""

  def __init__(
    self,
    *,
    get: Callable[..., Any] | None = None,
    popen: Callable[..., subprocess.Popen] | None = None,
    sleep: Callable[[float], None] = time.sleep,
  ) -> None:
    self._get = get or requests.get
    self._popen = popen or subprocess.Popen
    self._sleep = sleep
    self._lock = threading.Lock()
    self._process: subprocess.Popen | None = None

  def _healthy(self, base_url: str) -> bool:
    try:
      response = self._get(f'{base_url}/health', timeout=1)
      return int(response.status_code) == 200
    except requests.RequestException:
      return False

  def ensure_started(self, base_url: str, *, timeout: float = 15) -> dict[str, Any]:
    normalized_url = normalize_bridge_url(base_url)
    parsed = urlparse(normalized_url)
    if parsed.scheme != 'http':
      raise DeepSeekWebStartupError('本地 DeepSeek Bridge 自动启动仅支持 http 地址。')
    if self._healthy(normalized_url):
      return {'started': False, 'ready': True, 'pid': None}

    with self._lock:
      if self._healthy(normalized_url):
        return {'started': False, 'ready': True, 'pid': None}
      if self._process is None or self._process.poll() is not None:
        self._process = self._launch(parsed.port or 8765)
        started = True
      else:
        started = False

      deadline = time.monotonic() + max(1, timeout)
      while time.monotonic() < deadline:
        if self._healthy(normalized_url):
          return {
            'started': started,
            'ready': True,
            'pid': self._process.pid if self._process else None,
          }
        if self._process is not None and self._process.poll() is not None:
          break
        self._sleep(0.2)

      details = self._latest_log_details()
      raise DeepSeekWebStartupError(
        'DeepSeek Web Bridge 启动失败。'
        + (f' {details}' if details else '请检查 Playwright 和 Chromium 是否已安装。')
      )

  def _launch(self, port: int) -> subprocess.Popen:
    log_path = PROJECT_ROOT / '.runtime' / 'logs' / 'deepseek-web-bridge.log'
    log_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
      sys.executable,
      '-m',
      'uvicorn',
      'tools.deepseek_web_bridge.app:app',
      '--host',
      '127.0.0.1',
      '--port',
      str(port),
    ]
    environment = {**os.environ, 'PYTHONUNBUFFERED': '1'}
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    try:
      with log_path.open('ab') as log_file:
        return self._popen(
          command,
          cwd=str(PROJECT_ROOT),
          env=environment,
          stdin=subprocess.DEVNULL,
          stdout=log_file,
          stderr=subprocess.STDOUT,
          creationflags=creation_flags,
        )
    except (OSError, subprocess.SubprocessError) as exc:
      raise DeepSeekWebStartupError(f'无法启动 DeepSeek Web Bridge：{exc}') from exc

  @staticmethod
  def _latest_log_details() -> str:
    log_path = PROJECT_ROOT / '.runtime' / 'logs' / 'deepseek-web-bridge.log'
    if not log_path.is_file():
      return ''
    try:
      lines = log_path.read_text(encoding='utf-8', errors='replace').splitlines()
    except OSError:
      return ''
    return ' '.join(lines[-3:])[-600:]


deepseek_web_process_manager = DeepSeekWebProcessManager()


__all__ = [
  'DeepSeekWebProcessManager',
  'DeepSeekWebStartupError',
  'deepseek_web_process_manager',
]
