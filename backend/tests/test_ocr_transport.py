from __future__ import annotations

import unittest

from backend.ocr_transport import (
  cache_ocr_transport,
  clear_ocr_transport_cache,
  resolve_ocr_transport,
)


class OcrTransportResolverTest(unittest.TestCase):
  def setUp(self):
    clear_ocr_transport_cache()

  def tearDown(self):
    clear_ocr_transport_cache()

  def test_obvious_ocr_model_uses_ocr_endpoint(self):
    self.assertEqual('litellm_ocr', resolve_ocr_transport('PaddleOCR-VL-1.5'))
    self.assertEqual('litellm_ocr', resolve_ocr_transport('mistral-ocr-latest'))

  def test_regular_vision_model_uses_chat_completions(self):
    self.assertEqual('openai_chat_vision', resolve_ocr_transport('GLM-4.6V'))

  def test_provider_metadata_has_priority(self):
    self.assertEqual(
      'litellm_ocr',
      resolve_ocr_transport('custom-model', {'mode': 'ocr'}),
    )
    self.assertEqual(
      'litellm_ocr',
      resolve_ocr_transport('custom-model', {'supported_endpoints': ['/v1/ocr']}),
    )

  def test_learned_transport_is_cached_by_provider_and_model(self):
    cache_ocr_transport('https://provider.example/v1', 'ambiguous-model', 'litellm_ocr')

    self.assertEqual(
      'litellm_ocr',
      resolve_ocr_transport(
        'ambiguous-model',
        base_url='https://provider.example/v1/chat/completions',
      ),
    )
    self.assertEqual(
      'openai_chat_vision',
      resolve_ocr_transport('ambiguous-model', base_url='https://other.example/v1'),
    )


if __name__ == '__main__':
  unittest.main()
