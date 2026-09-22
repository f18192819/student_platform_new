from __future__ import annotations

import asyncio
import unittest
from unittest.mock import Mock, patch

from backend.provider_router import update_api_config


class ProviderRouterBridgeSwitchTest(unittest.TestCase):
  def test_switching_to_web_provider_starts_bridge_before_response(self):
    config = {
      'doubtProvider': 'deepseek-web',
      'ocrProvider': 'api',
      'deepseekWebBridgeUrl': 'http://127.0.0.1:8765',
    }
    ensure = Mock()
    with (
      patch('backend.provider_router.save_api_config', return_value=config),
      patch('backend.provider_router.ensure_deepseek_web_bridge', ensure),
    ):
      result = asyncio.run(update_api_config({'doubtProvider': 'deepseek-web'}))

    self.assertEqual(config, result['config'])
    ensure.assert_called_once_with(config=config)

  def test_switching_to_api_only_does_not_start_bridge(self):
    config = {'doubtProvider': 'api', 'ocrProvider': 'api'}
    ensure = Mock()
    with (
      patch('backend.provider_router.save_api_config', return_value=config),
      patch('backend.provider_router.ensure_deepseek_web_bridge', ensure),
    ):
      asyncio.run(update_api_config({'doubtProvider': 'api'}))

    ensure.assert_not_called()


if __name__ == '__main__':
  unittest.main()
