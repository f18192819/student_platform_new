from __future__ import annotations

import unittest

from backend.runtime_config import normalize_api_config


class RuntimeConfigTest(unittest.TestCase):
  def test_legacy_config_populates_independent_ocr_provider(self):
    config = normalize_api_config({
      'baseUrl': 'https://text.example/v1',
      'apiKey': 'text-secret',
      'model': 'text-model',
      'models': ['text-model'],
    })

    self.assertEqual('https://text.example/v1', config['ocrBaseUrl'])
    self.assertEqual('text-secret', config['ocrApiKey'])
    self.assertEqual('GLM-4.6V', config['ocrModel'])
    self.assertEqual(['GLM-4.6V'], config['ocrModels'])

  def test_independent_ocr_provider_is_preserved(self):
    config = normalize_api_config({
      'baseUrl': 'https://text.example/v1',
      'apiKey': 'text-secret',
      'model': 'text-model',
      'models': ['text-model'],
      'ocrBaseUrl': 'https://vision.example/v1',
      'ocrApiKey': 'vision-secret',
      'ocrModel': 'vision-model',
      'ocrModels': ['vision-model', 'vision-model-2'],
    })

    self.assertEqual('https://vision.example/v1', config['ocrBaseUrl'])
    self.assertEqual('vision-secret', config['ocrApiKey'])
    self.assertEqual('vision-model', config['ocrModel'])
    self.assertEqual(['vision-model', 'vision-model-2'], config['ocrModels'])

  def test_legacy_config_defaults_debug_providers_to_api(self):
    config = normalize_api_config({
      'baseUrl': 'https://text.example/v1',
      'apiKey': 'secret',
      'model': 'text-model',
    })

    self.assertEqual('api', config['doubtProvider'])
    self.assertEqual('api', config['ocrProvider'])
    self.assertEqual('http://127.0.0.1:8765', config['deepseekWebBridgeUrl'])

  def test_deepseek_web_provider_fields_are_preserved(self):
    config = normalize_api_config({
      'baseUrl': 'https://text.example/v1',
      'apiKey': 'secret',
      'model': 'text-model',
      'doubtProvider': 'deepseek-web',
      'ocrProvider': 'deepseek-web',
      'deepseekWebBridgeUrl': 'http://localhost:9876',
    })

    self.assertEqual('deepseek-web', config['doubtProvider'])
    self.assertEqual('deepseek-web', config['ocrProvider'])
    self.assertEqual('http://localhost:9876', config['deepseekWebBridgeUrl'])


if __name__ == '__main__':
  unittest.main()
