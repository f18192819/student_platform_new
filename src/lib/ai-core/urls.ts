type OctopusRuntimeService = {
  apiBase?: string
  serviceId?: string
  uuid?: string
}

function readRuntimeService(): OctopusRuntimeService | null {
  if (typeof window === 'undefined') {
    return null
  }

  const runtime = (window as typeof window & {
    __OCTOPUS_SERVICE__?: OctopusRuntimeService
  }).__OCTOPUS_SERVICE__

  return runtime ?? null
}

function resolveServiceApiPath(pathname: string, fallback: string) {
  const runtime = readRuntimeService()
  const apiBase = typeof runtime?.apiBase === 'string' ? runtime.apiBase.trim() : ''
  if (apiBase.startsWith('/')) {
    return `${apiBase.replace(/\/+$/, '')}${pathname}`
  }

  const serviceKey =
    (typeof runtime?.uuid === 'string' && runtime.uuid.trim()) ||
    (typeof runtime?.serviceId === 'string' && runtime.serviceId.trim()) ||
    ''
  if (serviceKey) {
    return `/api/v1/service/${serviceKey}${pathname}`
  }

  return fallback
}

export function normalizeBaseUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`
  }
  return `${trimmed}/chat/completions`
}

export function normalizeApiRoot(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  for (const suffix of ['/chat/completions', '/embeddings', '/rerank']) {
    if (trimmed.endsWith(suffix)) {
      return trimmed.slice(0, -suffix.length)
    }
  }
  return trimmed
}

export function buildEmbeddingApiUrl(baseUrl: string) {
  return `${normalizeApiRoot(baseUrl)}/embeddings`
}

export function resolveAudioDebugApiUrl() {
  return resolveServiceApiPath('/api/audio/transcribe', '/api/audio/transcribe')
}

export function resolveAudioDebugMappingApiUrl() {
  return resolveServiceApiPath('/api/audio/debug-mapping', '/api/audio/debug-mapping')
}
