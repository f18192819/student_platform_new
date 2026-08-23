export function ensureUint8ArrayToHex() {
  const prototype = Uint8Array.prototype as Uint8Array & {
    toHex?: () => string
  }

  if (typeof prototype.toHex === 'function') {
    return
  }

  Object.defineProperty(prototype, 'toHex', {
    value() {
      return Array.from(this as Uint8Array, (value) => value.toString(16).padStart(2, '0')).join('')
    },
    configurable: true,
    writable: true,
  })
}

export function resolvePublicAssetUrl(relativePath: string) {
  const viteBase =
    typeof import.meta !== 'undefined' && typeof import.meta.env?.BASE_URL === 'string'
      ? import.meta.env.BASE_URL
      : '/'
  const rawBase = String(viteBase || '/').trim() || '/'
  const normalizedBase = rawBase === './' ? '/' : rawBase

  if (typeof window !== 'undefined') {
    return new URL(relativePath, window.location.origin + normalizedBase).toString()
  }

  return normalizedBase.endsWith('/')
    ? `${normalizedBase}${relativePath}`
    : `${normalizedBase}/${relativePath}`
}

export const PDFJS_CMAP_URL = resolvePublicAssetUrl('pdfjs/cmaps/')
export const PDFJS_STANDARD_FONT_DATA_URL = resolvePublicAssetUrl('pdfjs/standard_fonts/')

export function normalizePdfData(buffer: ArrayBuffer) {
  return new Uint8Array(buffer.slice(0))
}
