from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from backend.deepseek_web_runtime import (
  ensure_deepseek_web_bridge,
  get_deepseek_web_bridge_status,
  resolve_deepseek_web_bridge_url,
  should_auto_start_deepseek_web_bridge,
)


class DeepSeekWebRuntimeTest(unittest.TestCase):
  def test_resolves_configured_and_default_urls(self):
    self.assertEqual(
      'http://localhost:9876',
      resolve_deepseek_web_bridge_url({'deepseekWebBridgeUrl': 'http://localhost:9876'}),
    )
    self.assertEqual(
      'http://127.0.0.1:8765',
      resolve_deepseek_web_bridge_url({'deepseekWebBridgeUrl': ''}),
    )

  def test_ensure_uses_injected_manager_and_config_url(self):
    manager = Mock()
    manager.ensure_started.return_value = {'started': True, 'ready': True, 'pid': 42}

    result = ensure_deepseek_web_bridge(
      config={'deepseekWebBridgeUrl': 'http://127.0.0.1:9876'},
      process_manager=manager,
    )

    self.assertEqual({'started': True, 'ready': True, 'pid': 42}, result)
    manager.ensure_started.assert_called_once_with('http://127.0.0.1:9876')

  def test_ensure_loads_config_only_when_no_arguments_are_given(self):
    manager = Mock()
    manager.ensure_started.return_value = {'started': False, 'ready': True, 'pid': None}
    with patch(
      'backend.deepseek_web_runtime.load_api_config',
      return_value={'deepseekWebBridgeUrl': 'http://127.0.0.1:9000'},
    ):
      ensure_deepseek_web_bridge(process_manager=manager)
    manager.ensure_started.assert_called_once_with('http://127.0.0.1:9000')

  def test_auto_start_is_enabled_for_either_web_provider_only(self):
    self.assertTrue(should_auto_start_deepseek_web_bridge({'doubtProvider': 'deepseek-web'}))
    self.assertTrue(should_auto_start_deepseek_web_bridge({'ocrProvider': 'deepseek-web'}))
    self.assertFalse(should_auto_start_deepseek_web_bridge({
      'doubtProvider': 'api', 'ocrProvider': 'api',
    }))

  def test_status_keeps_bridge_health_separate_from_login_state(self):
    manager = Mock()
    manager.status.return_value = {
      'alive': True,
      'ready': True,
      'owned': True,
      'pid': 42,
      'url': 'http://127.0.0.1:8765',
      'last_health_check_at': '2026-09-22T00:00:00Z',
      'last_error': None,
    }
    bridge = Mock()
    bridge.status.return_value = {
      'browser_running': True,
      'logged_in': False,
      'chat_available': False,
      'image_upload_available': False,
    }

    result = get_deepseek_web_bridge_status(
      {'deepseekWebBridgeUrl': 'http://127.0.0.1:8765'},
      bridge=bridge,
      process_manager=manager,
    )

    self.assertTrue(result['bridge']['ready'])
    self.assertTrue(result['bridge']['owned'])
    self.assertFalse(result['browser']['logged_in'])
    self.assertFalse(result['logged_in'])


if __name__ == '__main__':
  unittest.main()
