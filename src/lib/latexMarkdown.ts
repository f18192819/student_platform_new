const PROTECTED_MARKDOWN = /```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$\n])+\$/g
const DISPLAY_ENVIRONMENT = /\\begin\s*\{(array|aligned|alignedat|cases|gathered|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}[\s\S]*?\\end\s*\{\1\}/g
const RAW_INLINE_LATEX = /(^|[\u3400-\u9fff\uE000-\uF8FF，。；：！？、“”‘’])([^\u3400-\u9fff\uE000-\uF8FF，。；：！？、“”‘’\n]*\\[A-Za-z]+[^\u3400-\u9fff\uE000-\uF8FF，。；：！？、“”‘’\n]*)/gm
const PLACEHOLDER = '\uE000LATEX_MARKDOWN_'
const RAW_ASSESSMENT_EQUATION = /(^|[\s(（,，:：])((?:[A-Za-z][A-Za-z0-9_{}]*|\\[A-Za-z]+)[^$\n\u3400-\u9fff，。；;]*?(?:=|≈|≃|≅|≤|≥)[^$\n\u3400-\u9fff，。；;]*)/gm

const GREEK_LATEX: Record<string, string> = {
  'α': '\\alpha',
  'β': '\\beta',
  'γ': '\\gamma',
  'δ': '\\delta',
  'ε': '\\varepsilon',
  'θ': '\\theta',
  'λ': '\\lambda',
  'μ': '\\mu',
  'π': '\\pi',
  'ρ': '\\rho',
  'σ': '\\sigma',
  'φ': '\\varphi',
  'ω': '\\omega',
  'Δ': '\\Delta',
  'Σ': '\\Sigma',
  'Ω': '\\Omega',
}

function stripEquationAnnotations(value: string) {
  // MinerU and model outputs sometimes retain textbook equation numbers. KaTeX
  // only accepts \tag in display mode, while most extracted formulas are inline.
  return value
    .replace(/\\tag\*?\s*\{[^{}]*\}/g, '')
    .replace(/\\label\s*\{[^{}]*\}/g, '')
}

function normalizeTexDelimiters(value: string) {
  // AI responses frequently use TeX delimiters, but remark-math accepts
  // Markdown's $...$ / $$...$$ forms only.
  return value
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, formula: string) => (
      `\n\n$$\n${formula.trim()}\n$$\n\n`
    ))
    .replace(/\\\(([^\n]*?)\\\)/g, (_match, formula: string) => `$${formula.trim()}$`)
}

function protect(
  source: string,
  pattern: RegExp,
  protectedParts: string[],
  transform: (value: string) => string = (value) => value,
) {
  return source.replace(pattern, (value) => {
    const index = protectedParts.push(transform(value)) - 1
    return `${PLACEHOLDER}${index}\uE001`
  })
}

function restore(source: string, protectedParts: string[]) {
  return source.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)\\uE001`, 'g'),
    (_value, index: string) => protectedParts[Number(index)] ?? '',
  )
}

function wrapInlineLatex(source: string) {
  return source.replace(RAW_INLINE_LATEX, (_value, boundary: string, candidate: string) => {
    const leadingWhitespace = candidate.match(/^\s*/)?.[0] ?? ''
    const trailingWhitespace = candidate.match(/\s*$/)?.[0] ?? ''
    let formula = candidate.trim()
    let trailingPunctuation = ''

    const punctuation = formula.match(/([,.;:!?]+)$/)?.[0]
    if (punctuation) {
      formula = formula.slice(0, -punctuation.length).trimEnd()
      trailingPunctuation = punctuation
    }
    if (!formula || !/\\[A-Za-z]+/.test(formula)) {
      return `${boundary}${candidate}`
    }
    return `${boundary}${leadingWhitespace}$${formula}$${trailingPunctuation}${trailingWhitespace}`
  })
}

function normalizePlainFormula(value: string) {
  let formula = value.trim()
  for (const [symbol, command] of Object.entries(GREEK_LATEX)) {
    formula = formula.replaceAll(symbol, `${command} `)
  }
  return formula
    .replace(/(?<!\\)\b(sin|cos|tan|cot|sec|csc|log|ln|exp|lim|max|min|det)\b/g, '\\$1')
    .replace(/_([A-Za-z0-9]+)(?![A-Za-z0-9}])/g, '_{$1}')
    .replace(/\b([A-Za-z])(\d+)\b/g, '$1_{$2}')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function wrapPlainAssessmentEquations(source: string) {
  const protectedParts: string[] = []
  const unprotected = protect(source, PROTECTED_MARKDOWN, protectedParts)
  const wrapped = unprotected.replace(
    RAW_ASSESSMENT_EQUATION,
    (_value, boundary: string, formula: string) => (
      `${boundary}$${normalizePlainFormula(formula)}$`
    ),
  )
  return restore(wrapped, protectedParts)
}

/** Add math delimiters to raw LaTeX emitted by MinerU without touching valid Markdown math. */
export function prepareMineruMarkdownMath(value: string) {
  const protectedParts: string[] = []
  let source = normalizeTexDelimiters(
    stripEquationAnnotations(String(value || '').replace(/\r\n?/g, '\n')),
  )

  source = protect(source, PROTECTED_MARKDOWN, protectedParts)
  source = protect(
    source,
    DISPLAY_ENVIRONMENT,
    protectedParts,
    (environment) => `\n\n$$\n${environment.trim()}\n$$\n\n`,
  )
  source = wrapInlineLatex(source)
  return restore(source, protectedParts).replace(/\n{4,}/g, '\n\n\n').trim()
}

/** Normalize legacy assessment pseudo-math before passing it to remark-math. */
export function prepareAssessmentMarkdownMath(value: string) {
  return wrapPlainAssessmentEquations(prepareMineruMarkdownMath(value))
}
