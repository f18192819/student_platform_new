import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareAssessmentMarkdownMath } from '../src/lib/latexMarkdown'

test('normalizes legacy assessment pseudo-math for KaTeX', () => {
  assert.equal(
    prepareAssessmentMarkdownMath('E_P = V0 cos(ωt)/(2d)，方向垂直于极板'),
    '$E_{P} = V_{0} \\cos(\\omega t)/(2d)$，方向垂直于极板',
  )
})

test('keeps existing markdown latex unchanged', () => {
  const source = '$E_P = \\frac{V_0}{d}$，方向垂直于极板'
  assert.equal(prepareAssessmentMarkdownMath(source), source)
})
