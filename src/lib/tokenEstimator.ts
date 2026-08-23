import type { ChatMessage } from '../types'
import type { TokenizerFamily } from './modelCapabilities'

const CACHE_LIMIT = 256
const tokenCache = new Map<string, number>()

function hashText(text: string) {
  let hash = 2_166_136_261
  const step = Math.max(1, Math.floor(text.length / 4_096))
  for (let index = 0; index < text.length; index += step) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `${text.length}:${hash >>> 0}`
}

function cacheResult(key: string, value: number) {
  tokenCache.delete(key)
  tokenCache.set(key, value)
  while (tokenCache.size > CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) break
    tokenCache.delete(oldest)
  }
  return value
}

function estimateDeepSeekTokens(text: string) {
  let tokens = 0
  let asciiRun = 0
  let whitespaceRun = false

  const flushAscii = () => {
    if (!asciiRun) return
    tokens += Math.ceil(asciiRun / 3.2)
    asciiRun = 0
  }

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    const isCjk =
      (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
    if (isCjk) {
      flushAscii()
      tokens += 0.65
      whitespaceRun = false
    } else if (/\s/u.test(character)) {
      flushAscii()
      if (!whitespaceRun) tokens += 1
      whitespaceRun = true
    } else if (codePoint <= 0x7f) {
      asciiRun += 1
      whitespaceRun = false
    } else {
      flushAscii()
      tokens += 1
      whitespaceRun = false
    }
  }
  flushAscii()
  return Math.max(1, Math.ceil(tokens))
}

function estimateCl100kTokens(text: string) {
  let tokens = 0
  let asciiRun = 0
  let whitespaceRun = false

  const flushAscii = () => {
    if (!asciiRun) return
    tokens += Math.ceil(asciiRun / 3.5)
    asciiRun = 0
  }

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    const isCjk =
      (codePoint >= 0x3400 && codePoint <= 0x9fff) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0x20000 && codePoint <= 0x2fa1f)
    if (isCjk) {
      flushAscii()
      // cl100k varies by character and phrase. A slight overestimate is safer
      // for request budgeting than silently overflowing a provider window.
      tokens += 1.1
      whitespaceRun = false
    } else if (/\s/u.test(character)) {
      flushAscii()
      if (!whitespaceRun) tokens += 1
      whitespaceRun = true
    } else if (/^[A-Za-z0-9_]$/u.test(character)) {
      asciiRun += 1
      whitespaceRun = false
    } else if (codePoint <= 0x7f) {
      flushAscii()
      tokens += 0.5
      whitespaceRun = false
    } else {
      flushAscii()
      tokens += 1
      whitespaceRun = false
    }
  }
  flushAscii()
  return Math.max(1, Math.ceil(tokens))
}

export function estimateTextTokens(text: string, tokenizer: TokenizerFamily = 'cl100k') {
  if (!text) return 0
  const key = `${tokenizer}:${hashText(text)}`
  const cached = tokenCache.get(key)
  if (cached !== undefined) {
    tokenCache.delete(key)
    tokenCache.set(key, cached)
    return cached
  }

  try {
    const count = tokenizer === 'deepseek'
      ? estimateDeepSeekTokens(text)
      : estimateCl100kTokens(text)
    return cacheResult(key, count)
  } catch {
    // Conservative fallback for environments where the tokenizer cannot load.
    return cacheResult(key, Math.max(1, Math.ceil(text.length / 2)))
  }
}

export function estimateChatMessageTokens(
  messages: ChatMessage[],
  tokenizer: TokenizerFamily = 'cl100k',
) {
  return messages.reduce(
    (total, message) => total + 4 + estimateTextTokens(message.content, tokenizer),
    2,
  )
}

export function clearTokenEstimateCache() {
  tokenCache.clear()
}
