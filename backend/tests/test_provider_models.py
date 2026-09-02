from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from backend.provider_models import fetch_provider_models


class ProviderModelsTest(unittest.TestCase):
  @patch('backend.provider_models.requests.get')
  def test_preserves_safe_capability_metadata(self, request_get: Mock):
    response = Mock(ok=True)
    response.json.return_value = {
      'data': [
        {
          'id': 'vision-model',
          'capabilities': ['chat'],
          'modalities': {'input': ['text', 'image'], 'output': ['text']},
          'owned_by': 'must-not-leak',
        },
        {
          'id': 'embedding-model',
          'supported_endpoints': ['/v1/embeddings'],
          'type': 'embedding',
        },
        'legacy-model',
      ],
    }
    request_get.return_value = response

    result = fetch_provider_models(base_url='https://provider.example/v1', api_key='secret')

    self.assertEqual(3, result['count'])
    self.assertEqual(
      {
        'id': 'vision-model',
        'capabilities': ['chat'],
        'input_modalities': ['image', 'text'],
        'output_modalities': ['text'],
      },
      next(model for model in result['discovered_models'] if model['id'] == 'vision-model'),
    )
    self.assertEqual(['embedding-model', 'legacy-model', 'vision-model'], result['models'])
    self.assertNotIn('owned_by', result['discovered_models'][0])
    request_get.assert_called_once_with(
      'https://provider.example/v1/models',
      headers={'Accept': 'application/json', 'Authorization': 'Bearer secret'},
      timeout=30,
    )

  @patch('backend.provider_models.requests.get')
  def test_merges_duplicate_model_metadata(self, request_get: Mock):
    response = Mock(ok=True)
    response.json.return_value = {
      'models': [
        {'id': 'same-model', 'mode': 'chat'},
        {'id': 'same-model', 'supported_modalities': ['image']},
      ],
    }
    request_get.return_value = response

    result = fetch_provider_models(base_url='https://provider.example/v1/models')

    self.assertEqual(
      [{'id': 'same-model', 'capabilities': ['chat'], 'input_modalities': ['image']}],
      result['discovered_models'],
    )


if __name__ == '__main__':
  unittest.main()
