import type { AskStreamHandlers } from '../../types'

export function emitDeltaText(delta: string, handlers?: AskStreamHandlers) {
  for (const char of delta) {
    handlers?.onToken?.(char)
  }
}

function extractJsonArray(text: string) {
  const normalized = text.replace(/```(?:json)?/gi, '').trim()
  const start = normalized.indexOf('[')
  const end = normalized.lastIndexOf(']')
  if (start < 0 || end < start) {
    throw new Error('Model did not return a parsable JSON array.')
  }

  return normalized.slice(start, end + 1)
}

function extractJsonObject(text: string) {
  const normalized = text.replace(/```(?:json)?/gi, '').trim()
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new Error('Model did not return a parsable JSON object.')
  }

  return normalized.slice(start, end + 1)
}

function escapeControlCharsInJsonStrings(text: string) {
  let result = ''
  let inString = false
  let escaped = false

  for (const char of text) {
    if (!inString) {
      if (char === '"') {
        inString = true
      }
      result += char
      continue
    }

    if (escaped) {
      result += char
      escaped = false
      continue
    }

    if (char === '\\') {
      result += char
      escaped = true
      continue
    }

    if (char === '"') {
      inString = false
      result += char
      continue
    }

    if (char === '\n') {
      result += '\\n'
      continue
    }

    if (char === '\r') {
      result += '\\r'
      continue
    }

    if (char === '\t') {
      result += '\\t'
      continue
    }

    if (char === '\b') {
      result += '\\b'
      continue
    }

    if (char === '\f') {
      result += '\\f'
      continue
    }

    if (char.charCodeAt(0) < 0x20) {
      result += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
      continue
    }

    result += char
  }

  return result
}

export function repairJsonText(text: string) {
  return escapeControlCharsInJsonStrings(text)
    .replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
    .replace(/,\s*([}\]])/g, '$1')
}

function tryExtractQuestionsArrayFromObject(text: string) {
  const normalized = text.replace(/```(?:json)?/gi, '').trim()
  const start = normalized.indexOf('{')
  const end = normalized.lastIndexOf('}')
  if (start < 0 || end < start) {
    return null
  }

  try {
    const payload = JSON.parse(repairJsonText(normalized.slice(start, end + 1))) as Record<string, unknown>
    const candidates = [payload.questions, payload.items, payload.data, payload.result]
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate as Array<Record<string, unknown>>
      }
    }
  } catch {
    return null
  }

  return null
}

export function parseJsonArrayFromModel(text: string) {
  try {
    const jsonText = extractJsonArray(text)
    return JSON.parse(jsonText) as Array<Record<string, unknown>>
  } catch (error) {
    try {
      const jsonText = extractJsonArray(text)
      const repaired = repairJsonText(jsonText)
      return JSON.parse(repaired) as Array<Record<string, unknown>>
    } catch {
      const extractedFromObject = tryExtractQuestionsArrayFromObject(text)
      if (extractedFromObject) {
        return extractedFromObject
      }
      const reason = error instanceof Error ? error.message : 'Unknown JSON parse error'
      throw new Error(`Model returned invalid JSON: ${reason}`)
    }
  }
}

export function parseJsonObjectFromModel(text: string) {
  const jsonText = extractJsonObject(text)

  try {
    return JSON.parse(jsonText) as Record<string, unknown>
  } catch (error) {
    const repaired = repairJsonText(jsonText)
    try {
      return JSON.parse(repaired) as Record<string, unknown>
    } catch {
      const reason = error instanceof Error ? error.message : 'Unknown JSON parse error'
      throw new Error(`Model returned invalid JSON object: ${reason}`)
    }
  }
}
