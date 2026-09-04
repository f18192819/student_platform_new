from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import requests
from fastapi.testclient import TestClient

from backend.app_factory import create_app_with_router
from backend.deepseek_web_bridge import (
  DeepSeekWebBridgeClient,
  DeepSeekWebBridgeError,
  extract_web_json_object,
  normalize_bridge_url,
)
from backend.deepseek_web_router import create_deepseek_web_router
from tools.deepseek_web_bridge.browser import SerializedBrowserTasks
from tools.deepseek_web_bridge.app import create_bridge_app
from tools.deepseek_web_bridge.deepseek_client import BridgeOperationError, DeepSeekWebClient


class FakeResponse:
  def __init__(self, status_code: int, payload: dict) -> None:
    self.status_code = status_code
    self._payload = payload

  def json(self):
    return self._payload


class DeepSeekWebBridgeClientTest(unittest.TestCase):
  def test_rendered_markdown_json_recovers_all_questions(self):
    rendered = r'''```json
{"questions":[
  {"question_id":"q1","transcription":"first line
second line with "quoted evidence" and \\frac{1}{2}","confidence":0.9},
  {"question_id":"q2","transcription":"$E=mc^2$","confidence":0.8}
],"unassigned_blocks":[]}
```'''

    payload = extract_web_json_object(rendered)

    self.assertEqual(['q1', 'q2'], [item['question_id'] for item in payload['questions']])
    self.assertIn('first line\nsecond line', payload['questions'][0]['transcription'])
    self.assertIn('"quoted evidence"', payload['questions'][0]['transcription'])
    self.assertIn(r'\frac{1}{2}', payload['questions'][0]['transcription'])

  def test_valid_fenced_json_remains_compatible(self):
    payload = extract_web_json_object('```json\n{"questions": [], "unassigned_blocks": []}\n```')
    self.assertEqual([], payload['questions'])

  def test_only_loopback_bridge_urls_are_allowed(self):
    self.assertEqual('http://127.0.0.1:8765', normalize_bridge_url('http://127.0.0.1:8765/'))
    self.assertEqual('http://localhost:8765', normalize_bridge_url('http://localhost:8765'))
    with self.assertRaises(DeepSeekWebBridgeError):
      normalize_bridge_url('https://remote.example/bridge')

  def test_status_does_not_expose_bridge_payload_secrets(self):
    client = DeepSeekWebBridgeClient(get=lambda *_args, **_kwargs: FakeResponse(200, {
      'browser_running': True,
      'logged_in': True,
      'chat_available': True,
      'image_upload_available': False,
      'cookie': 'must-not-leak',
    }))
    self.assertEqual({
      'browser_running': True,
      'logged_in': True,
      'chat_available': True,
      'image_upload_available': False,
    }, client.status('http://127.0.0.1:8765'))

  def test_network_failure_is_normalized(self):
    def fail(*_args, **_kwargs):
      raise requests.ConnectionError('refused')

    with self.assertRaises(DeepSeekWebBridgeError) as raised:
      DeepSeekWebBridgeClient(get=fail).status('http://127.0.0.1:8765')
    self.assertEqual('bridge_not_ready', raised.exception.code)

  def test_ocr_upload_preserves_file_order(self):
    calls = []

    def post(_url, **kwargs):
      calls.append(kwargs)
      return FakeResponse(200, {'text': 'page one\npage two', 'page_count': 2})

    with tempfile.TemporaryDirectory() as temporary:
      first = Path(temporary) / '01.png'
      second = Path(temporary) / '02.png'
      first.write_bytes(b'one')
      second.write_bytes(b'two')
      text = DeepSeekWebBridgeClient(post=post).ocr(
        'http://127.0.0.1:8765', [first, second],
      )
    self.assertEqual('page one\npage two', text)
    self.assertEqual(['01.png', '02.png'], [item[1][0] for item in calls[0]['files']])


class DeepSeekWebRouterTest(unittest.TestCase):
  class FakeClient:
    def status(self, _url):
      return {
        'browser_running': True,
        'logged_in': True,
        'chat_available': True,
        'image_upload_available': True,
      }

    def open_browser(self, _url):
      return {'opened': True}

    def chat(self, _url, prompt):
      return f'answer:{prompt}'

  @patch('backend.deepseek_web_router.load_api_config', return_value={
    'deepseekWebBridgeUrl': 'http://127.0.0.1:8765',
  })
  def test_proxy_contract(self, _load):
    client = TestClient(create_app_with_router(create_deepseek_web_router(self.FakeClient())))
    self.assertTrue(client.get('/api/deepseek-web/status').json()['logged_in'])
    self.assertEqual('answer:why', client.post('/api/deepseek-web/chat', json={'prompt': 'why'}).json()['text'])

  @patch('backend.deepseek_web_router.load_api_config', return_value={
    'deepseekWebBridgeUrl': 'http://127.0.0.1:8765',
  })
  def test_not_logged_in_has_stable_error(self, _load):
    class NotLoggedIn(self.FakeClient):
      def chat(self, _url, _prompt):
        raise DeepSeekWebBridgeError('not_logged_in')

    client = TestClient(create_app_with_router(create_deepseek_web_router(NotLoggedIn())))
    response = client.post('/api/deepseek-web/chat', json={'prompt': 'why'})
    self.assertEqual(409, response.status_code)
    self.assertEqual('not_logged_in', response.json()['detail']['code'])


class SerializedBrowserTasksTest(unittest.IsolatedAsyncioTestCase):
  async def test_browser_tasks_never_overlap(self):
    runner = SerializedBrowserTasks()
    active = 0
    peak = 0
    order = []

    async def operation(name):
      nonlocal active, peak
      active += 1
      peak = max(peak, active)
      order.append(f'start-{name}')
      await asyncio.sleep(0.01)
      order.append(f'end-{name}')
      active -= 1

    await asyncio.gather(
      runner.run(lambda: operation('chat')),
      runner.run(lambda: operation('ocr')),
    )
    self.assertEqual(1, peak)
    self.assertEqual(['start-chat', 'end-chat', 'start-ocr', 'end-ocr'], order)

  async def test_stable_answer_is_preserved_when_stop_control_stays_visible(self):
    class MissingLocator:
      async def count(self):
        return 0

    class Page:
      def get_by_text(self, *_args, **_kwargs):
        return MissingLocator()

      async def wait_for_timeout(self, _milliseconds):
        await asyncio.sleep(0.002)

    client = DeepSeekWebClient(object(), generation_timeout=0.2)

    async def latest_answer(_page):
      return '{"questions": [], "unassigned_blocks": []}'

    async def stop_visible(_page):
      return True

    client._latest_answer = latest_answer
    client._stop_button_visible = stop_visible

    result = await client._wait_and_extract(Page())

    self.assertEqual('{"questions": [], "unassigned_blocks": []}', result)


class BridgeHttpApiTest(unittest.TestCase):
  class FakeBrowserClient:
    def __init__(self):
      self.ocr_names = []

    async def status(self):
      return {
        'browser_running': True,
        'logged_in': True,
        'chat_available': True,
        'image_upload_available': True,
      }

    async def open_browser(self):
      return {'opened': True}

    async def chat(self, prompt):
      return f'web:{prompt}'

    async def ocr(self, paths, prompt=''):
      self.ocr_names = [path.name for path in paths]
      return f'{prompt}:first\nsecond'

  def test_health_chat_and_ordered_multipart_ocr_contract(self):
    fake = self.FakeBrowserClient()
    with TestClient(create_bridge_app(fake)) as client:
      self.assertEqual({'ok': True}, client.get('/health').json())
      self.assertEqual('web:hello', client.post('/v1/chat', json={'prompt': 'hello'}).json()['text'])
      response = client.post('/v1/ocr', data={'prompt': 'transcribe'}, files=[
        ('files', ('one.png', b'one', 'image/png')),
        ('files', ('two.jpg', b'two', 'image/jpeg')),
      ])
    self.assertEqual(200, response.status_code)
    self.assertEqual(2, response.json()['page_count'])
    self.assertEqual(['001.png', '002.jpg'], fake.ocr_names)

  def test_capability_error_remains_stable(self):
    class Unsupported(self.FakeBrowserClient):
      async def ocr(self, _paths, prompt=''):
        raise BridgeOperationError('image_upload_unsupported', 'No upload control.')

    with TestClient(create_bridge_app(Unsupported())) as client:
      response = client.post('/v1/ocr', files=[
        ('files', ('one.png', b'one', 'image/png')),
      ])
    self.assertEqual(409, response.status_code)
    self.assertEqual('image_upload_unsupported', response.json()['detail']['code'])


if __name__ == '__main__':
  unittest.main()
