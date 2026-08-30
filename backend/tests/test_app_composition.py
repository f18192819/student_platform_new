from __future__ import annotations

import unittest

import app


class AppCompositionTest(unittest.TestCase):
  def test_api_operations_are_registered_once(self):
    operations = [
      (route.path, method)
      for route in app.app.routes
      if route.path.startswith('/api/')
      for method in route.methods
    ]

    self.assertEqual(len(operations), len(set(operations)))

  def test_compatibility_exports_remain_available(self):
    self.assertTrue(callable(app.transcribe_audio_file_with_chunking))
    self.assertTrue(callable(app.build_classroom_session_from_text_api))


if __name__ == '__main__':
  unittest.main()
