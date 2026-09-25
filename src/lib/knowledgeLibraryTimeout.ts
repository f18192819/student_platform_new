export const KNOWLEDGE_LIBRARY_TIMEOUT_MS = 7_000

export async function withKnowledgeLibraryTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = KNOWLEDGE_LIBRARY_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await operation(controller.signal)
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('本地后端暂时不可用', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
