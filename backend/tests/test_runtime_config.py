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


if __name__ == '__main__':
  unittest.main()
