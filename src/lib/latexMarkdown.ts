const PROTECTED_MARKDOWN = /```[\s\S]*?```|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$\n])+\$/g
const DISPLAY_ENVIRONMENT = /\\begin\s*\{(array|aligned|alignedat|cases|gathered|matrix|pmatrix|bmatrix|vmatrix|Vmatrix)\}[\s\S]*?\\end\s*\{\1\}/g
const RAW_INLINE_LATEX = /(^|[\u3400-\u9fff\uE000-\uF8FF，。；：！？、“”‘’])([^\u3400-\u9fff\uE000-\uF8FF，。；：！？、“”‘’\n]*\\[A-Za-z]+[^\u3400-\u9fff\uE000-\uF8FF，。；：！？、“”‘’\n]*)/gm
const PLACEHOLDER = '\uE000LATEX_MARKDOWN_'

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

/** Add math delimiters to raw LaTeX emitted by MinerU without touching valid Markdown math. */
export function prepareMineruMarkdownMath(value: string) {
  const protectedParts: string[] = []
  let source = String(value || '').replace(/\r\n?/g, '\n')

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
