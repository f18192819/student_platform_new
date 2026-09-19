export type ChatStreamFlushMode = 'append' | 'replace'

export type ChatStreamBatcher = {
  append: (chunk: string) => void
  replace: (content: string) => void
  flush: () => void
  dispose: () => void
}

export function createChatStreamBatcher(
  onFlush: (content: string, mode: ChatStreamFlushMode) => void,
  intervalMs = 40,
): ChatStreamBatcher {
  let pending = ''
  let pendingMode: ChatStreamFlushMode = 'append'
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const flush = () => {
    clearTimer()
    if (!pending) return
    const content = pending
    const mode = pendingMode
    pending = ''
    pendingMode = 'append'
    onFlush(content, mode)
  }

  const schedule = () => {
    if (timer === null) timer = setTimeout(flush, intervalMs)
  }

  return {
    append(chunk) {
      if (!chunk) return
      if (pendingMode === 'replace') {
        pending += chunk
      } else {
        pendingMode = 'append'
        pending += chunk
      }
      schedule()
    },
    replace(content) {
      pendingMode = 'replace'
      pending = content
      schedule()
    },
    flush,
    dispose() {
      clearTimer()
      pending = ''
      pendingMode = 'append'
    },
  }
}

