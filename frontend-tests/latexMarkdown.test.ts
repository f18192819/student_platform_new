import assert from 'node:assert/strict'
import test from 'node:test'

import { prepareAssessmentMarkdownMath, prepareChatMarkdownMath } from '../src/lib/latexMarkdown'

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

test('chat markdown keeps GFM structure and normalizes TeX delimiters', () => {
  const source = [
    '**结论**',
    '',
    '- 行内公式：\\(x^2 + 1\\)',
    '- 原生公式：$y^2$',
    '',
    '| 变量 | 值 |',
    '| --- | --- |',
    '| x | 1 |',
    '',
    '\\[\\frac{1}{2}\\]',
  ].join('\n')
  const result = prepareChatMarkdownMath(source)

  assert.match(result, /\*\*结论\*\*/)
  assert.match(result, /- 行内公式：\$x\^2 \+ 1\$/)
  assert.match(result, /\$y\^2\$/)
  assert.match(result, /\| 变量 \| 值 \|/)
  assert.match(result, /\$\$\n\\frac\{1\}\{2\}\n\$\$/)
})

test('chat math normalization leaves fenced and inline code untouched', () => {
  const source = [
    '`\\(inline-code\\)`',
    '',
    '```tex',
    '\\[fenced-code\\]',
    '```',
    '',
    '\\(real_math\\)',
  ].join('\n')
  const result = prepareChatMarkdownMath(source)

  assert.match(result, /`\\\(inline-code\\\)`/)
  assert.match(result, /```tex\n\\\[fenced-code\\\]\n```/)
  assert.match(result, /\$real_math\$/)
})
