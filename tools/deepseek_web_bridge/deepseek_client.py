from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Sequence

from .browser import PersistentBrowser, SerializedBrowserTasks


DEEPSEEK_URL = 'https://chat.deepseek.com/'
DEFAULT_OCR_PROMPT = '''请忠实转写这些图片中的学生手写答案。

要求：
- 保留原有步骤和顺序
- 数学公式尽量使用 LaTeX
- 不要解题
- 不要纠正学生答案
- 不要补全不存在的内容
- 看不清的位置写 [无法辨认]
- 只输出转写内容'''

logger = logging.getLogger(__name__)


class BridgeOperationError(RuntimeError):
  def __init__(self, code: str, message: str) -> None:
    self.code = code
    super().__init__(message)


class DeepSeekWebClient:
  """All DeepSeek DOM knowledge is intentionally contained in this class."""

  def __init__(self, browser: PersistentBrowser, generation_timeout: float | None = None) -> None:
    self.browser = browser
    self.tasks = SerializedBrowserTasks()
    self.generation_timeout = generation_timeout or float(
      os.environ.get('DEEPSEEK_WEB_GENERATION_TIMEOUT_SECONDS', '180')
    )

  async def open_browser(self) -> dict[str, bool]:
    async def operation() -> dict[str, bool]:
      page = await self.browser.page()
      if 'deepseek.com' not in page.url:
        await page.goto(DEEPSEEK_URL, wait_until='domcontentloaded', timeout=60_000)
      await page.bring_to_front()
      return {'opened': True}

    return await self.tasks.run(operation)

  async def status(self) -> dict[str, bool]:
    if not self.browser.running:
      return {
        'browser_running': False,
        'logged_in': False,
        'chat_available': False,
        'image_upload_available': False,
      }

    async def operation() -> dict[str, bool]:
      try:
        page = await self.browser.page()
        logged_in = await self._find_composer(page) is not None
        return {
          'browser_running': True,
          'logged_in': logged_in,
          'chat_available': logged_in,
          'image_upload_available': logged_in and await self._supports_upload(page),
        }
      except Exception:
        return {
          'browser_running': False,
          'logged_in': False,
          'chat_available': False,
          'image_upload_available': False,
        }

    return await self.tasks.run(operation)

  async def chat(self, prompt: str) -> str:
    async def operation() -> str:
      page = await self._ready_page()
      await self._new_chat(page)
      await self._send_prompt(page, prompt)
      return await self._wait_and_extract(page)

    return await self.tasks.run(operation)

  async def ocr(self, files: Sequence[Path], prompt: str = '') -> str:
    async def operation() -> str:
      page = await self._ready_page()
      await self._new_chat(page)
      if not await self._supports_upload(page):
        raise BridgeOperationError(
          'image_upload_unsupported',
          '当前 DeepSeek 网页没有可用的图片上传入口。',
        )
      try:
        chooser = page.locator('input[type="file"]')
        if await chooser.count() == 0:
          upload_button = page.get_by_role('button', name=re.compile(r'上传|附件|添加文件|Upload|Attach', re.I))
          if await upload_button.count() == 0:
            raise BridgeOperationError('image_upload_unsupported', '当前页面没有图片上传入口。')
          async with page.expect_file_chooser(timeout=10_000) as event:
            await upload_button.first.click()
          await (await event.value).set_files([str(path) for path in files])
        else:
          await chooser.first.set_input_files([str(path) for path in files])
        await page.wait_for_timeout(250)
      except BridgeOperationError:
        raise
      except Exception as exc:
        raise BridgeOperationError('upload_failed', '图片上传失败。') from exc
      await self._send_prompt(page, prompt.strip() or DEFAULT_OCR_PROMPT)
      return await self._wait_and_extract(page)

    return await self.tasks.run(operation)

  async def _ready_page(self):
    if not self.browser.running:
      raise BridgeOperationError('bridge_not_ready', '调试浏览器尚未启动。')
    try:
      page = await self.browser.page()
    except Exception as exc:
      raise BridgeOperationError('browser_closed', '调试浏览器已关闭。') from exc
    if 'deepseek.com' not in page.url:
      await page.goto(DEEPSEEK_URL, wait_until='domcontentloaded', timeout=60_000)
    if await self._find_composer(page) is None:
      raise BridgeOperationError('not_logged_in', 'DeepSeek 网页尚未登录。')
    return page

  async def _new_chat(self, page) -> None:
    candidates = (
      page.get_by_role('button', name=re.compile(r'新建对话|开启新对话|New chat', re.I)),
      page.get_by_role('link', name=re.compile(r'新建对话|开启新对话|New chat', re.I)),
      page.locator('[aria-label*="新建"], [title*="新建"], [aria-label*="New chat"]'),
    )
    for locator in candidates:
      if await locator.count():
        try:
          await locator.first.click(timeout=5_000)
          await page.wait_for_timeout(150)
          return
        except Exception:
          continue
    # Navigating to the public chat root is the least brittle way to obtain a clean session.
    await page.goto(DEEPSEEK_URL, wait_until='domcontentloaded', timeout=60_000)

  async def _find_composer(self, page):
    candidates = (
      page.get_by_role('textbox'),
      page.locator('textarea'),
      page.locator('[contenteditable="true"]'),
    )
    for locator in candidates:
      try:
        if await locator.count() and await locator.first.is_visible():
          return locator.first
      except Exception:
        continue
    return None

  async def _send_prompt(self, page, prompt: str) -> None:
    composer = await self._find_composer(page)
    if composer is None:
      raise BridgeOperationError('not_logged_in', 'DeepSeek 网页尚未登录。')
    try:
      await composer.fill(prompt)
    except Exception:
      try:
        await composer.click()
        await page.keyboard.insert_text(prompt)
      except Exception as exc:
        raise BridgeOperationError('page_changed', '无法定位 DeepSeek 输入框。') from exc
    try:
      send = await self._find_send_button(page, composer)
      if send is not None:
        deadline = asyncio.get_running_loop().time() + 30
        while not await send.is_enabled() and asyncio.get_running_loop().time() < deadline:
          await page.wait_for_timeout(250)
        if not await send.is_enabled():
          raise BridgeOperationError('upload_failed', '图片仍在处理，发送按钮不可用。')
        await send.click()
      else:
        await composer.press('Enter')
    except Exception as exc:
      raise BridgeOperationError('page_changed', '无法发送 DeepSeek 网页消息。') from exc

  @staticmethod
  async def _find_send_button(page, composer):
    semantic = (
      page.get_by_role('button', name=re.compile(r'发送|Send', re.I)),
      page.locator('button[type="submit"]'),
      page.locator('[data-testid*="send" i]'),
      page.locator('[aria-label*="send" i], [aria-label*="发送"]'),
    )
    for locator in semantic:
      if await locator.count():
        for candidate in await locator.all():
          if await candidate.is_visible():
            return candidate

    composer_box = await composer.bounding_box()
    if composer_box is None:
      return None
    nearby = []
    for candidate in await page.locator('button').all():
      if not await candidate.is_visible():
        continue
      box = await candidate.bounding_box()
      if box is None:
        continue
      vertical_center = box['y'] + box['height'] / 2
      composer_bottom = composer_box['y'] + composer_box['height']
      if (
        box['x'] >= composer_box['x'] + composer_box['width'] * 0.65
        and composer_box['y'] <= vertical_center <= composer_bottom + 20
      ):
        nearby.append((box['x'], candidate))
    return max(nearby, key=lambda item: item[0])[1] if nearby else None

  async def _wait_and_extract(self, page, timeout_seconds: float | None = None) -> str:
    timeout_seconds = timeout_seconds or self.generation_timeout
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    stable_text = ''
    stable_rounds = 0
    generation_started = False
    image_mode_retried = False
    while asyncio.get_running_loop().time() < deadline:
      if not image_mode_retried:
        image_retry = page.get_by_text('发送至识图模式', exact=True)
        if await image_retry.count() == 1 and await image_retry.is_visible():
          await image_retry.click()
          image_mode_retried = True
          generation_started = True
          await page.wait_for_timeout(250)
          continue
      stop_visible = await self._stop_button_visible(page)
      generation_started = generation_started or stop_visible
      answer = await self._latest_answer(page)
      if answer and answer == stable_text:
        stable_rounds += 1
      else:
        stable_text = answer
        stable_rounds = 0
      if stable_text and stable_rounds >= 3 and generation_started and not stop_visible:
        return stable_text
      if stable_text and stable_rounds >= 5 and not stop_visible:
        return stable_text
      await page.wait_for_timeout(500)
    raise BridgeOperationError('generation_timeout', 'DeepSeek 网页生成超时。')

  async def _latest_answer(self, page) -> str:
    selectors = (
      '[data-message-author-role="assistant"]',
      '[data-role="assistant"]',
      '.ds-markdown',
      '.markdown-body',
    )
    for selector in selectors:
      locator = page.locator(selector)
      if await locator.count():
        text = (await locator.last.inner_text()).strip()
        if text:
          return text
    return ''

  @staticmethod
  async def _stop_button_visible(page) -> bool:
    locator = page.get_by_role('button', name=re.compile(r'停止生成|停止|Stop generating|Stop', re.I))
    try:
      return bool(await locator.count() and await locator.first.is_visible())
    except Exception:
      return False

  @staticmethod
  async def _supports_upload(page) -> bool:
    try:
      if await page.locator('input[type="file"]').count():
        return True
      return bool(await page.get_by_role(
        'button', name=re.compile(r'上传|附件|添加文件|Upload|Attach', re.I),
      ).count())
    except Exception:
      return False
