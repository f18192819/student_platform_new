from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.app_factory import create_app_with_router
from backend.provider_router import provider_router


class ProviderRouterTest(unittest.TestCase):
  def setUp(self):
    self.client = TestClient(create_app_with_router(provider_router))

  @patch('backend.provider_router.load_api_config', return_value={'text_model': 'model-a'})
  def test_get_config_keeps_legacy_response_shape(self, _load):
    response = self.client.get('/api/config')

    self.assertEqual(200, response.status_code)
    self.assertEqual(
      {'configured': True, 'config': {'text_model': 'model-a'}},
      response.json(),
    )

  @patch('backend.provider_router.save_api_config', return_value={'text_model': 'model-b'})
  def test_update_config_keeps_legacy_path_and_shape(self, _save):
    response = self.client.put('/api/config', json={'text_model': 'model-b'})

    self.assertEqual(200, response.status_code)
    self.assertEqual('model-b', response.json()['config']['text_model'])


if __name__ == '__main__':
  unittest.main()
