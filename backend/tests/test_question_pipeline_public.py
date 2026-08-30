from __future__ import annotations

import unittest

from backend.question_pipeline import extract_json_object


class QuestionPipelinePublicInterfaceTest(unittest.TestCase):
  def test_extract_json_object_handles_fenced_provider_response(self):
    payload = extract_json_object('```json\n{"score": 0.8, "ok": true}\n```')

    self.assertEqual({'score': 0.8, 'ok': True}, payload)

  def test_extract_json_object_ignores_leading_provider_commentary(self):
    payload = extract_json_object('Result follows: {"questions": [1, 2]}')

    self.assertEqual([1, 2], payload['questions'])


if __name__ == '__main__':
  unittest.main()
