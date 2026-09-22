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
    self._process_url: str | None = None
    self._last_health_check_at: str | None = None
    self._last_health_url: str | None = None
    self._last_error: str | None = None

  @staticmethod
  def _now_iso() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

  def _healthy(self, base_url: str) -> bool:
    self._last_health_check_at = self._now_iso()
    self._last_health_url = base_url
    try:
      response = self._get(f'{base_url}/health', timeout=1)
      healthy = int(response.status_code) == 200
      if healthy:
        self._last_error = None
      else:
        self._last_error = f'health returned HTTP {response.status_code}'
      return healthy
    except requests.RequestException:
      self._last_error = 'health check connection failed'
      return False

  def status(self, base_url: str, *, probe: bool = True) -> dict[str, Any]:
    """Return process/health state without starting a Bridge process."""
    normalized_url = normalize_bridge_url(base_url)
    if probe:
      ready = self._healthy(normalized_url)
    else:
      ready = False
      if self._last_health_url == normalized_url:
        ready = self._last_error is None and self._last_health_check_at is not None

    process = self._process if self._process_url == normalized_url else None
    process_alive = process is not None and process.poll() is None
    if not ready and not process_alive and self._last_health_url != normalized_url:
      self._last_error = None

    return {
      'alive': bool(ready or process_alive),
      'ready': bool(ready),
      'owned': bool(process_alive),
      'pid': process.pid if process_alive else None,
      'url': normalized_url,
      'last_health_check_at': (
        self._last_health_check_at if self._last_health_url == normalized_url else None
      ),
      'last_error': self._last_error if self._last_health_url == normalized_url else None,
    }

  def ensure_started(self, base_url: str, *, timeout: float = 15) -> dict[str, Any]:
    normalized_url = normalize_bridge_url(base_url)
    parsed = urlparse(normalized_url)
    if parsed.scheme != 'http':
      raise DeepSeekWebStartupError('本地 DeepSeek Bridge 自动启动仅支持 http 地址。')
    if self._healthy(normalized_url):
      return {
        'started': False,
        'ready': True,
        'pid': None,
        'owned': False,
        'url': normalized_url,
        'last_health_check_at': self._last_health_check_at,
      }

    with self._lock:
      if self._healthy(normalized_url):
        return {
          'started': False,
          'ready': True,
          'pid': None,
          'owned': False,
          'url': normalized_url,
          'last_health_check_at': self._last_health_check_at,
        }
      if self._process is not None and self._process.poll() is not None:
        self._process = None
        self._process_url = None
      if (
        self._process is not None
        and self._process_url is not None
        and self._process_url != normalized_url
      ):
        self._stop_owned_process()
      if self._process is None:
        self._process = self._launch(parsed.port or 8765)
        self._process_url = normalized_url
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
            'owned': self._process is not None,
            'url': normalized_url,
            'last_health_check_at': self._last_health_check_at,
          }
        if self._process is not None and self._process.poll() is not None:
          break
        self._sleep(0.2)

      details = self._latest_log_details()
      self._stop_owned_process()
      self._last_error = details or 'health check timed out'
      raise DeepSeekWebStartupError(
        'DeepSeek Web Bridge 启动失败。'
        + (f' {details}' if details else '请检查 Playwright 和 Chromium 是否已安装。')
      )

  def _stop_owned_process(self) -> None:
    process = self._process
    self._process = None
    self._process_url = None
    if process is None:
      return
    try:
      if process.poll() is None:
        process.terminate()
        try:
          process.wait(timeout=3)
        except (subprocess.TimeoutExpired, TimeoutError):
          process.kill()
          process.wait(timeout=3)
    except (OSError, subprocess.SubprocessError):
      pass

  def stop(self) -> None:
    """Stop only a Bridge process launched by this manager instance."""
    with self._lock:
      self._stop_owned_process()

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
