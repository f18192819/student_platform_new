from __future__ import annotations

# KNOWLEDGE_GRAPH_PAUSED: preserved service manager; app.py no longer starts it.

import os
import socket
import subprocess
import time
from pathlib import Path
from threading import Lock
from typing import Any

from .config import PROJECT_ROOT


class LocalNeo4jService:
  """Starts a locally installed Neo4j server only when this application owns it."""

  def __init__(self) -> None:
    self._process: subprocess.Popen[str] | None = None
    self._lock = Lock()
    self.last_error = ''

  @staticmethod
  def _bolt_endpoint(uri: str) -> tuple[str, int]:
    value = uri.replace('bolt://', '').replace('neo4j://', '').split('/')[0]
    host, _, raw_port = value.partition(':')
    return host or '127.0.0.1', int(raw_port or '7687')

  @staticmethod
  def _is_reachable(uri: str) -> bool:
    try:
      with socket.create_connection(LocalNeo4jService._bolt_endpoint(uri), timeout=0.5):
        return True
    except OSError:
      return False

  @staticmethod
  def _home(config: dict[str, Any]) -> Path | None:
    candidates = [
      str(config.get('neo4jHome') or ''),
      os.environ.get('NEO4J_HOME', ''),
      str(PROJECT_ROOT / '.runtime' / 'neo4j'),
    ]
    program_files = Path(os.environ.get('ProgramFiles', r'C:\Program Files'))
    if program_files.is_dir():
      candidates.extend(str(path) for path in program_files.glob('Neo4j*'))
    for candidate in candidates:
      home = Path(candidate).expanduser()
      if (home / 'bin' / 'neo4j.bat').is_file() or (home / 'bin' / 'neo4j').is_file():
        return home
    return None

  @staticmethod
  def _java_home(home: Path) -> Path | None:
    candidates = [
      os.environ.get('JAVA_HOME', ''),
      str(home / 'jre'),
      str(PROJECT_ROOT / '.runtime' / 'jdk-21'),
      str(Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Eclipse Adoptium' / 'jdk-21.0.11.10-hotspot'),
    ]
    adoptium_root = Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Eclipse Adoptium'
    if adoptium_root.is_dir():
      candidates.extend(str(path) for path in adoptium_root.glob('jdk-*'))
    runtime_root = PROJECT_ROOT / '.runtime'
    if runtime_root.is_dir():
      candidates.extend(str(path) for path in runtime_root.glob('jdk-*'))
    for candidate in candidates:
      java_home = Path(candidate).expanduser()
      executable = java_home / 'bin' / ('java.exe' if os.name == 'nt' else 'java')
      if executable.is_file():
        return java_home
    return None

  def start(self, config: dict[str, Any]) -> dict[str, Any]:
    if not config.get('neo4jEnabled') or not config.get('neo4jAutoStart', True):
      return self.status(config)
    uri = str(config.get('neo4jUri') or 'bolt://127.0.0.1:7687')
    with self._lock:
      if self._is_reachable(uri):
        return self.status(config)
      home = self._home(config)
      if home is None:
        self.last_error = 'Neo4j was not found. Install Neo4j locally or set Neo4j Home in API configuration.'
        return self.status(config)
      java_home = self._java_home(home)
      if java_home is None:
        self.last_error = 'A compatible JDK 21 or 25 was not found for Neo4j.'
        return self.status(config)
      command = home / 'bin' / ('neo4j-admin.bat' if os.name == 'nt' else 'neo4j-admin')
      flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
      environment = os.environ.copy()
      environment['JAVA_HOME'] = str(java_home)
      environment['PATH'] = f"{java_home / 'bin'}{os.pathsep}{environment.get('PATH', '')}"
      try:
        self._process = subprocess.Popen(
          [str(command), 'server', 'console'], cwd=str(home), text=True,
          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags, env=environment,
        )
      except OSError as exc:
        self.last_error = f'Unable to start Neo4j: {exc}'
        return self.status(config)
    for _ in range(60):
      if self._is_reachable(uri):
        self.last_error = ''
        break
      if self._process.poll() is not None:
        self.last_error = 'Neo4j exited before Bolt became ready. Check Neo4j logs.'
        break
      time.sleep(1)
    return self.status(config)

  def stop(self) -> None:
    with self._lock:
      process, self._process = self._process, None
    if process is not None and process.poll() is None:
      process.terminate()
      try:
        process.wait(timeout=15)
      except subprocess.TimeoutExpired:
        process.kill()

  def status(self, config: dict[str, Any]) -> dict[str, Any]:
    uri = str(config.get('neo4jUri') or 'bolt://127.0.0.1:7687')
    return {
      'enabled': bool(config.get('neo4jEnabled')),
      'auto_start': bool(config.get('neo4jAutoStart', True)),
      'uri': uri,
      'reachable': self._is_reachable(uri),
      'managed_process': self._process is not None and self._process.poll() is None,
      'home': str(self._home(config) or ''),
      'java_home': str(self._java_home(self._home(config)) or '') if self._home(config) else '',
      'error': self.last_error,
    }


local_neo4j_service = LocalNeo4jService()
