from __future__ import annotations

import unittest

from backend.provider_transport import (
  LiteLLMOcrClient,
  ProviderTransportError,
  StructuredChatClient,
  extract_json_object,
  is_ocr_protocol_error,
  normalize_openai_api_root,
)


class FakeResponse:
  def __init__(self, status_code, content='', text='', payload=None):
    self.status_code = status_code
    self._content = content
    self.text = text
    self._payload = payload

  def json(self):
    if self._payload is not None:
      return self._payload
    return {'choices': [{'message': {'content': self._content}}]}


class ProviderTransportTest(unittest.TestCase):
  def test_normalizes_endpoint_urls(self):
    self.assertEqual(
      'https://provider.example/v1',
      normalize_openai_api_root('https://provider.example/v1/chat/completions'),
    )

  def test_falls_back_from_json_schema_to_json_object(self):
    calls = []
    responses = iter([
      FakeResponse(400, text='schema unsupported'),
      FakeResponse(200, '```json\n{"ok": true}\n```'),
    ])

    def post(url, **kwargs):
      calls.append((url, kwargs))
      return next(responses)

    result = StructuredChatClient(post).complete_json(
      base_url='https://provider.example/v1',
      api_key='secret',
      model='model-a',
      messages=[{'role': 'user', 'content': 'test'}],
      schema={'type': 'object'},
      schema_name='test_payload',
    )

    self.assertEqual({'ok': True}, result)
    self.assertEqual('json_schema', calls[0][1]['json']['response_format']['type'])
    self.assertEqual('json_object', calls[1][1]['json']['response_format']['type'])
    self.assertEqual('Bearer secret', calls[0][1]['headers']['Authorization'])

  def test_normalizes_final_http_error(self):
    client = StructuredChatClient(lambda *_args, **_kwargs: FakeResponse(401, text='denied'))

    with self.assertRaises(ProviderTransportError) as raised:
      client.complete_json(
        base_url='https://provider.example/v1',
        api_key='bad',
        model='model-a',
        messages=[],
        schema={'type': 'object'},
      )

    self.assertEqual(401, raised.exception.status_code)
    self.assertIn('denied', str(raised.exception))

  def test_retries_format_when_success_payload_is_not_json(self):
    responses = iter([
      FakeResponse(200, 'not structured'),
      FakeResponse(200, '{"ok": true}'),
    ])
    client = StructuredChatClient(lambda *_args, **_kwargs: next(responses))

    result = client.complete_json(
      base_url='https://provider.example/v1',
      api_key='secret',
      model='model-a',
      messages=[],
      schema={'type': 'object'},
    )

    self.assertEqual({'ok': True}, result)

  def test_extracts_first_json_object(self):
    self.assertEqual({'value': 2}, extract_json_object('answer: {"value": 2}'))

  def test_multimodal_protocol_error_stops_format_retries(self):
    calls = []

    def post(url, **kwargs):
      calls.append((url, kwargs))
      return FakeResponse(500, text='sequence item 1: expected str instance, list found')

    with self.assertRaises(ProviderTransportError) as raised:
      StructuredChatClient(post).complete_json(
        base_url='https://provider.example/v1',
        api_key='secret',
        model='ocr-model',
        messages=[{'role': 'user', 'content': [{'type': 'image_url'}]}],
        schema={'type': 'object'},
      )

    self.assertEqual('multimodal_protocol_error', raised.exception.error_type)
    self.assertEqual(1, len(calls))

  def test_litellm_ocr_posts_document_and_merges_pages(self):
    calls = []

    def post(url, **kwargs):
      calls.append((url, kwargs))
      return FakeResponse(200, payload={
        'pages': [{'markdown': 'first'}, {'markdown': 'second'}],
      })

    result = LiteLLMOcrClient(post).transcribe(
      base_url='https://provider.example/v1/chat/completions',
      api_key='secret',
      model='PaddleOCR-VL-1.5',
      image_url='data:image/png;base64,AAAA',
    )

    self.assertEqual('first\n\nsecond', result)
    self.assertEqual('https://provider.example/v1/ocr', calls[0][0])
    self.assertEqual({
      'model': 'PaddleOCR-VL-1.5',
      'document': {'type': 'image_url', 'image_url': 'data:image/png;base64,AAAA'},
    }, calls[0][1]['json'])

  def test_recognizes_litellm_unsupported_ocr_provider_error(self):
    self.assertTrue(is_ocr_protocol_error('OCR is not supported for provider: custom'))
    self.assertFalse(is_ocr_protocol_error('rate limited'))


if __name__ == '__main__':
  unittest.main()
