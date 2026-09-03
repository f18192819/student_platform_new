from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeVar


T = TypeVar('T')


class SerializedBrowserTasks:
  """One browser context is shared, so every page mutation must be serialized."""

  def __init__(self) -> None:
    self._lock = asyncio.Lock()

  async def run(self, operation: Callable[[], Awaitable[T]]) -> T:
    async with self._lock:
      return await operation()


class PersistentBrowser:
  def __init__(self, profile_dir: Path, *, headless: bool = False) -> None:
    self.profile_dir = profile_dir
    self.headless = headless
    self._playwright: Any = None
    self._context: Any = None

  @property
  def running(self) -> bool:
    return self._context is not None

  async def ensure_open(self):
    if self._context is not None:
      return self._context
    try:
      from playwright.async_api import async_playwright
    except ImportError as exc:
      raise RuntimeError(
        'Playwright is not installed. Run: pip install -r tools/deepseek_web_bridge/requirements.txt'
      ) from exc
    self.profile_dir.mkdir(parents=True, exist_ok=True)
    self._playwright = await async_playwright().start()
    try:
      self._context = await self._playwright.chromium.launch_persistent_context(
        str(self.profile_dir),
        headless=self.headless,
        viewport={'width': 1440, 'height': 960},
        accept_downloads=False,
      )
    except Exception:
      await self._playwright.stop()
      self._playwright = None
      raise
    return self._context

  async def page(self):
    context = await self.ensure_open()
    pages = context.pages
    return pages[0] if pages else await context.new_page()

  async def close(self) -> None:
    context, playwright = self._context, self._playwright
    self._context = None
    self._playwright = None
    if context is not None:
      try:
        await context.close()
      except Exception:
        pass
    if playwright is not None:
      try:
        await playwright.stop()
      except Exception:
        pass
