from __future__ import annotations

import re


_MATH_DELIMITER = re.compile(r'\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$\n])+\$')
_FIRST_PROSE = re.compile(r'[\u3400-\u9fff]')
_FORMULA_SIGNAL = re.compile(
  r'(?:=|≈|≃|≅|≤|≥|\\(?:frac|sqrt|sum|prod|int|lim|vec|mathbf|mathrm)|'
  r'[A-Za-z][A-Za-z0-9_{}]*\s*[+\-*/^])'
)
_GREEK = {
  'α': r'\alpha',
  'β': r'\beta',
  'γ': r'\gamma',
  'δ': r'\delta',
  'ε': r'\varepsilon',
  'θ': r'\theta',
  'λ': r'\lambda',
  'μ': r'\mu',
  'π': r'\pi',
  'ρ': r'\rho',
  'σ': r'\sigma',
  'φ': r'\varphi',
  'ω': r'\omega',
  'Δ': r'\Delta',
  'Σ': r'\Sigma',
  'Ω': r'\Omega',
}


def _normalize_formula(formula: str) -> str:
  normalized = formula.strip().strip('$').strip()
  for symbol, command in _GREEK.items():
    normalized = normalized.replace(symbol, f'{command} ')
  normalized = re.sub(
    r'(?<!\\)\b(sin|cos|tan|cot|sec|csc|log|ln|exp|lim|max|min|det)\b',
    r'\\\1',
    normalized,
  )
  normalized = re.sub(r'_([A-Za-z0-9]+)(?![A-Za-z0-9}])', r'_{\1}', normalized)
  normalized = re.sub(r'\b([A-Za-z])(\d+)\b', r'\1_{\2}', normalized)
  return re.sub(r'[ \t]{2,}', ' ', normalized).strip()


def normalize_math_markdown(value: str, *, force_expression: bool = False) -> str:
  """Normalize assessment display text without changing its mathematical meaning."""
  source = str(value or '').strip()
  if not source:
    return ''
  source = re.sub(r'\\\[([\s\S]*?)\\\]', lambda match: f'$$\n{match.group(1).strip()}\n$$', source)
  source = re.sub(r'\\\(([^\n]*?)\\\)', lambda match: f'${match.group(1).strip()}$', source)
  if not force_expression or _MATH_DELIMITER.search(source):
    return source

  formula = source
  suffix = ''
  prose = _FIRST_PROSE.search(source)
  punctuation_positions = [
    position for marker in ('，', '。', '；', ';')
    if (position := source.find(marker)) >= 0
  ]
  split_at = min(punctuation_positions) if punctuation_positions else -1
  if prose and prose.start() > 0:
    split_at = prose.start() if split_at < 0 else min(split_at, prose.start())
  if split_at > 0:
    formula, suffix = source[:split_at], source[split_at:]
  if not _FORMULA_SIGNAL.search(formula):
    formula, suffix = source, ''
  normalized = _normalize_formula(formula)
  return f'${normalized}${suffix}' if normalized else source


__all__ = ['normalize_math_markdown']
