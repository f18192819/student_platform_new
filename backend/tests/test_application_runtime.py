from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

from backend.application_runtime import ApplicationRuntime


class ApplicationRuntimeBridgeLifecycleTest(unittest.TestCase):
  def test_web_provider_auto_starts_bridge_without_touching_api_secrets(self):
    runtime = object.__new__(ApplicationRuntime)
    ensure = Mock(return_value={'started': True, 'ready': True, 'pid': 321})
    with (
      patch('backend.application_runtime.load_api_config', return_value={
        'doubtProvider': 'deepseek-web',
        'ocrProvider': 'api',
        'deepseekWebBridgeUrl': 'http://127.0.0.1:9876',
        'apiKey': 'must-not-be-logged',
      }),
      patch('backend.application_runtime.ensure_deepseek_web_bridge', ensure),
    ):
      runtime._auto_start_deepseek_web_bridge()

    ensure.assert_called_once()
    self.assertEqual('http://127.0.0.1:9876', ensure.call_args.kwargs['config']['deepseekWebBridgeUrl'])

  def test_api_only_configuration_does_not_start_bridge(self):
    runtime = object.__new__(ApplicationRuntime)
    ensure = Mock()
    with (
      patch('backend.application_runtime.load_api_config', return_value={
        'doubtProvider': 'api', 'ocrProvider': 'api',
      }),
      patch('backend.application_runtime.ensure_deepseek_web_bridge', ensure),
    ):
      runtime._auto_start_deepseek_web_bridge()

    ensure.assert_not_called()

  def test_bridge_start_failure_is_logged_and_does_not_raise(self):
    runtime = object.__new__(ApplicationRuntime)
    with (
      patch('backend.application_runtime.load_api_config', return_value={
        'ocrProvider': 'deepseek-web',
      }),
      patch('backend.application_runtime.ensure_deepseek_web_bridge', side_effect=RuntimeError('missing chromium')),
      self.assertLogs('backend.application_runtime', level='ERROR') as logs,
    ):
      runtime._auto_start_deepseek_web_bridge()

    self.assertIn('continuing without it', '\n'.join(logs.output))


if __name__ == '__main__':
  unittest.main()
