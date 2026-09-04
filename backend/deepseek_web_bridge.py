from __future__ import annotations

import json
import mimetypes
import re
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests


DEFAULT_DEEPSEEK_WEB_BRIDGE_URL = 'http://127.0.0.1:8765'

_ERROR_MESSAGES = {
  'bridge_not_ready': '未检测到 DeepSeek Web Bridge，请先启动本地调试服务。',
  'not_logged_in': 'DeepSeek 网页登录已失效，请点击“打开 DeepSeek 登录”重新登录。',
  'image_upload_unsupported': '当前 DeepSeek 网页不支持图片上传，无法用于答案识别。',
  'upload_failed': '答案图片上传到 DeepSeek 网页失败，请重新打开登录页面后重试。',
  'generation_timeout': 'DeepSeek 网页生成超时，请确认网页状态后重试。',
  'page_changed': 'DeepSeek 网页结构已变化，本地 Bridge 暂时无法完成操作。',
  'browser_closed': 'DeepSeek 调试浏览器已关闭，请重新打开。',
}


class DeepSeekWebBridgeError(RuntimeError):
  def __init__(self, code: str, message: str | None = None, *, status_code: int | None = None) -> None:
    self.code = code
    self.status_code = status_code
    super().__init__(message or _ERROR_MESSAGES.get(code) or 'DeepSeek Web Bridge 调用失败。')


def extract_web_json_object(content: str) -> dict[str, Any]:
  """Recover JSON whose string whitespace/backslashes were altered by rendered web text."""
  cleaned = str(content or '').strip()
  if cleaned.startswith('```'):
    cleaned = re.sub(r'^```(?:json)?\s*|\s*```$', '', cleaned, flags=re.IGNORECASE).strip()

  repaired: list[str] = []
  in_string = False
  escaped = False
  # Rendered model output commonly contains raw LaTeX commands such as
  # \frac, \begin and \underbrace. Treat only delimiter escapes as JSON;
  # otherwise preserve the backslash as literal mathematical content.
  delimiter_escapes = {'"', '\\', '/'}
  for index, char in enumerate(cleaned):
    if not in_string:
      repaired.append(char)
      if char == '"':
        in_string = True
      continue
    if escaped:
      repaired.append(char)
      escaped = False
      continue
    if char == '"':
      following = cleaned[index + 1:].lstrip()[:1]
      if following in {':', ',', '}', ']'} or not following:
        repaired.append(char)
        in_string = False
      else:
        # Rendered Markdown drops JSON escaping around quotations copied from
        # the answer body. A structural quote can only precede JSON syntax.
        repaired.append('\\"')
      continue
    if char == '\\':
      next_char = cleaned[index + 1] if index + 1 < len(cleaned) else ''
      repaired.append('\\' if next_char in delimiter_escapes else '\\\\')
      escaped = next_char in delimiter_escapes
      continue
    if char == '\n':
      repaired.append('\\n')
    elif char == '\r':
      repaired.append('\\r')
    elif char == '\t':
      repaired.append('\\t')
    elif ord(char) < 0x20:
      repaired.append(json.dumps(char)[1:-1])
    else:
      repaired.append(char)

  source = ''.join(repaired)
  decoder = json.JSONDecoder()
  candidates: list[tuple[int, dict[str, Any]]] = []
  for match in re.finditer(r'\{', source):
    try:
      value, consumed = decoder.raw_decode(source[match.start():])
    except json.JSONDecodeError:
      continue
    if isinstance(value, dict):
      candidates.append((consumed, value))
  if candidates:
    # Prefer the recovered outer response over a valid but incomplete nested block.
    return max(candidates, key=lambda item: item[0])[1]
  raise DeepSeekWebBridgeError('page_changed', 'DeepSeek 网页返回内容无法恢复为结构化结果。')


def normalize_bridge_url(value: str | None) -> str:
  raw = str(value or DEFAULT_DEEPSEEK_WEB_BRIDGE_URL).strip().rstrip('/')
  parsed = urlparse(raw)
  if parsed.scheme not in {'http', 'https'} or parsed.hostname not in {'127.0.0.1', 'localhost', '::1'}:
    raise DeepSeekWebBridgeError(
      'bridge_not_ready',
      'DeepSeek Web Bridge 只允许使用本机 127.0.0.1/localhost 地址。',
    )
  return raw


class DeepSeekWebBridgeClient:
  """Narrow localhost HTTP client; browser and DOM details remain inside the bridge."""

  def __init__(
    self,
    *,
    get: Callable[..., requests.Response] | None = None,
    post: Callable[..., requests.Response] | None = None,
  ) -> None:
    self._get = get or requests.get
    self._post = post or requests.post

  def status(self, base_url: str, *, timeout: float = 5) -> dict[str, Any]:
    response = self._request(self._get, f'{normalize_bridge_url(base_url)}/status', timeout=timeout)
    payload = self._json(response)
    return {
      'browser_running': bool(payload.get('browser_running')),
      'logged_in': bool(payload.get('logged_in')),
      'chat_available': bool(payload.get('chat_available')),
      'image_upload_available': bool(payload.get('image_upload_available')),
    }

  def open_browser(self, base_url: str, *, timeout: float = 15) -> dict[str, Any]:
    response = self._request(
      self._post,
      f'{normalize_bridge_url(base_url)}/browser/open',
      timeout=timeout,
    )
    return self._json(response)

  def chat(self, base_url: str, prompt: str, *, timeout: float = 180) -> str:
    response = self._request(
      self._post,
      f'{normalize_bridge_url(base_url)}/v1/chat',
      json={'prompt': prompt, 'conversation_id': None},
      timeout=timeout,
    )
    text = str(self._json(response).get('text') or '').strip()
    if not text:
      raise DeepSeekWebBridgeError('page_changed', 'DeepSeek 网页没有返回可用回答。')
    return text

  def ocr(
    self,
    base_url: str,
    paths: Sequence[Path],
    *,
    prompt: str = '',
    timeout: float = 300,
  ) -> str:
    handles = []
    files = []
    try:
      for path in paths:
        handle = path.open('rb')
        handles.append(handle)
        content_type = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
        files.append(('files', (path.name, handle, content_type)))
      response = self._request(
        self._post,
        f'{normalize_bridge_url(base_url)}/v1/ocr',
        data={'prompt': prompt},
        files=files,
        timeout=timeout,
      )
      text = str(self._json(response).get('text') or '').strip()
      if not text:
        raise DeepSeekWebBridgeError('page_changed', 'DeepSeek 网页没有返回可用识别文本。')
      return text
    finally:
      for handle in handles:
        handle.close()

  @staticmethod
  def _request(call: Callable[..., requests.Response], url: str, **kwargs: Any) -> requests.Response:
    try:
      response = call(url, **kwargs)
    except requests.RequestException as exc:
      raise DeepSeekWebBridgeError('bridge_not_ready') from exc
    if response.status_code >= 400:
      try:
        payload = response.json()
      except ValueError:
        payload = {}
      detail = payload.get('detail') if isinstance(payload, dict) else None
      if isinstance(detail, dict):
        code = str(detail.get('code') or 'bridge_not_ready')
        message = str(detail.get('message') or '').strip() or None
      else:
        code = str(payload.get('code') or 'bridge_not_ready') if isinstance(payload, dict) else 'bridge_not_ready'
        message = str(payload.get('message') or '').strip() or None if isinstance(payload, dict) else None
      raise DeepSeekWebBridgeError(code, message, status_code=response.status_code)
    return response

  @staticmethod
  def _json(response: requests.Response) -> dict[str, Any]:
    try:
      payload = response.json()
    except ValueError as exc:
      raise DeepSeekWebBridgeError('page_changed', 'DeepSeek Web Bridge 返回了无效响应。') from exc
    if not isinstance(payload, dict):
      raise DeepSeekWebBridgeError('page_changed', 'DeepSeek Web Bridge 返回了无效响应。')
    return payload


__all__ = [
  'DEFAULT_DEEPSEEK_WEB_BRIDGE_URL',
  'DeepSeekWebBridgeClient',
  'DeepSeekWebBridgeError',
  'extract_web_json_object',
  'normalize_bridge_url',
]
