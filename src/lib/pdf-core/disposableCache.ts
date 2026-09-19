import type { PdfController } from '../../types'

type PdfPreviewWithController = {
  controller?: PdfController | null
}

const disposedControllers = new WeakSet<PdfController>()

export function disposePdfController(controller: PdfController | null | undefined) {
  if (!controller?.dispose || disposedControllers.has(controller)) {
    return Promise.resolve()
  }

  disposedControllers.add(controller)
  return Promise.resolve(controller.dispose()).catch((error) => {
    console.warn('PDF controller disposal failed:', error)
  })
}

export function disposePdfPreviews<T extends PdfPreviewWithController>(previews: Iterable<T>) {
  const controllers = new Set<PdfController>()
  for (const preview of previews) {
    if (preview.controller) controllers.add(preview.controller)
  }
  return Promise.all([...controllers].map(disposePdfController)).then(() => undefined)
}

export function setBoundedPdfPreview<TKey, TPreview extends PdfPreviewWithController>(
  cache: Map<TKey, TPreview>,
  key: TKey,
  preview: TPreview,
  limit: number,
) {
  const replaced = cache.get(key)
  cache.delete(key)
  cache.set(key, preview)
  if (replaced && replaced !== preview && replaced.controller !== preview.controller) {
    void disposePdfController(replaced.controller)
  }

  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value as TKey | undefined
    if (oldestKey === undefined) break
    const evicted = cache.get(oldestKey)
    cache.delete(oldestKey)
    void disposePdfController(evicted?.controller)
  }
}

export function clearPdfPreviewCache<TPreview extends PdfPreviewWithController>(
  cache: Map<unknown, TPreview>,
) {
  const previews = [...cache.values()]
  cache.clear()
  void disposePdfPreviews(previews)
}

export class DisposablePdfPreviewPromiseCache<TPreview extends PdfPreviewWithController> {
  readonly #entries = new Map<string, Promise<TPreview>>()
  readonly #disposedTasks = new WeakSet<Promise<TPreview>>()
  readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  get size() {
    return this.#entries.size
  }

  has(key: string) {
    return this.#entries.has(key)
  }

  get(key: string) {
    const task = this.#entries.get(key)
    if (!task) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, task)
    return task
  }

  set(key: string, task: Promise<TPreview>) {
    const replaced = this.#entries.get(key)
    this.#entries.delete(key)
    this.#entries.set(key, task)
    if (replaced && replaced !== task) this.#disposeWhenSettled(replaced)

    while (this.#entries.size > this.limit) {
      const oldestKey = this.#entries.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const evicted = this.#entries.get(oldestKey)
      this.#entries.delete(oldestKey)
      if (evicted) this.#disposeWhenSettled(evicted)
    }
    return this
  }

  delete(key: string) {
    const task = this.#entries.get(key)
    const deleted = this.#entries.delete(key)
    if (task) this.#disposeWhenSettled(task)
    return deleted
  }

  clear() {
    const tasks = [...this.#entries.values()]
    this.#entries.clear()
    tasks.forEach((task) => this.#disposeWhenSettled(task))
  }

  #disposeWhenSettled(task: Promise<TPreview>) {
    if (this.#disposedTasks.has(task)) return
    this.#disposedTasks.add(task)
    void task.then(
      (preview) => disposePdfController(preview.controller),
      () => undefined,
    )
  }
}
