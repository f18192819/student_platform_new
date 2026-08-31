from __future__ import annotations

import unittest

from backend.assessment_planner import AssessmentPlanner
from backend.math_markdown import normalize_math_markdown


class MathMarkdownTest(unittest.TestCase):
  def test_normalizes_plain_expression_to_markdown_latex(self):
    result = normalize_math_markdown(
      'E_P = V0 cos(ωt)/(2d)，方向垂直于极板',
      force_expression=True,
    )

    self.assertEqual(
      r'$E_{P} = V_{0} \cos(\omega t)/(2d)$，方向垂直于极板',
      result,
    )

  def test_preserves_existing_markdown_latex(self):
    source = r'$E_P = \frac{V_0}{d}$，方向垂直于极板'

    self.assertEqual(source, normalize_math_markdown(source, force_expression=True))

  def test_expression_choice_persists_every_option_as_latex(self):
    part = AssessmentPlanner._choice_part(
      'part-1',
      '请选择正确表达式。',
      1.0,
      'E_P = V0 cos(ωt)/(2d)',
      [
        'E_P = V0 sin(ωt)/(2d)',
        'E_P = V0 cos(ωt)/d',
        'E_P = V0 cos(ωt)/(4d)',
      ],
      expression=True,
    )

    self.assertIsNotNone(part)
    assert part is not None
    self.assertTrue(all(option.content.startswith('$') for option in part.options))
    correct = next(option for option in part.options if option.id == part.correct_option_id)
    self.assertEqual(r'$E_{P} = V_{0} \cos(\omega t)/(2d)$', correct.content)


if __name__ == '__main__':
  unittest.main()
