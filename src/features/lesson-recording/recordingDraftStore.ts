const DATABASE_NAME = 'student-platform-lesson-recordings'
const DATABASE_VERSION = 1
const DRAFT_STORE = 'drafts'
const CHUNK_STORE = 'chunks'
const OWNER_KEY = 'student-platform:lesson-recording-owner'
const LEGACY_OWNER_KEY = OWNER_KEY

export type LessonRecordingDraft = {
  id: string
  ownerId: string
  courseId: string | null
  documentId: string | null
  mimeType: string
  startedAt: number
  updatedAt: number
  state: 'recording' | 'pending'
}

type StoredChunk = {
  key: string
  draftId: string
  order: number
  blob: Blob
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'))
  })
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'))
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'))
  })
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(DRAFT_STORE)) {
        database.createObjectStore(DRAFT_STORE, { keyPath: 'id' })
      }
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const chunks = database.createObjectStore(CHUNK_STORE, { keyPath: 'key' })
        chunks.createIndex('draftId', 'draftId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Unable to open recording storage.'))
  })
}

export function getLessonRecordingOwnerId() {
  const persistent = window.localStorage.getItem(OWNER_KEY)?.trim()
  if (persistent) return persistent

  // Migrate the pre-reliability owner stored in sessionStorage so drafts created
  // before this change remain recoverable after the next refresh.
  const legacy = window.sessionStorage.getItem(LEGACY_OWNER_KEY)?.trim()
  const ownerId = legacy || crypto.randomUUID()
  window.localStorage.setItem(OWNER_KEY, ownerId)
  window.sessionStorage.removeItem(LEGACY_OWNER_KEY)
  return ownerId
}

export async function createLessonRecordingDraft(input: {
  ownerId: string
  courseId: string | null
  documentId: string | null
  mimeType: string
}) {
  const database = await openDatabase()
  try {
    const now = Date.now()
    const draft: LessonRecordingDraft = {
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      courseId: input.courseId,
      documentId: input.documentId,
      mimeType: input.mimeType || 'audio/webm',
      startedAt: now,
      updatedAt: now,
      state: 'recording',
    }
    const transaction = database.transaction(DRAFT_STORE, 'readwrite')
    transaction.objectStore(DRAFT_STORE).put(draft)
    await transactionDone(transaction)
    return draft
  } finally {
    database.close()
  }
}

export async function appendLessonRecordingChunk(draftId: string, order: number, blob: Blob) {
  if (!blob.size) return
  const database = await openDatabase()
  try {
    const transaction = database.transaction([DRAFT_STORE, CHUNK_STORE], 'readwrite')
    const draftStore = transaction.objectStore(DRAFT_STORE)
    const draft = await requestResult(draftStore.get(draftId)) as LessonRecordingDraft | undefined
    if (!draft) {
      transaction.abort()
      throw new Error('Recording draft no longer exists.')
    }
    const chunk: StoredChunk = { key: `${draftId}:${order}`, draftId, order, blob }
    transaction.objectStore(CHUNK_STORE).put(chunk)
    draftStore.put({ ...draft, updatedAt: Date.now() })
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

export async function markLessonRecordingPending(draftId: string) {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(DRAFT_STORE, 'readwrite')
    const store = transaction.objectStore(DRAFT_STORE)
    const draft = await requestResult(store.get(draftId)) as LessonRecordingDraft | undefined
    if (draft) store.put({ ...draft, state: 'pending', updatedAt: Date.now() })
    await transactionDone(transaction)
  } finally {
    database.close()
  }
}

async function chunksForDraft(database: IDBDatabase, draftId: string) {
  const transaction = database.transaction(CHUNK_STORE, 'readonly')
  const chunks = await requestResult(
    transaction.objectStore(CHUNK_STORE).index('draftId').getAll(IDBKeyRange.only(draftId)),
  ) as StoredChunk[]
  await transactionDone(transaction)
  return chunks.sort((left, right) => left.order - right.order)
}

async function readDrafts(ownerId: string | null) {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(DRAFT_STORE, 'readonly')
    const drafts = await requestResult(transaction.objectStore(DRAFT_STORE).getAll()) as LessonRecordingDraft[]
    await transactionDone(transaction)
    const selected = ownerId ? drafts.filter((draft) => draft.ownerId === ownerId) : drafts
    return Promise.all(selected.map(async (draft) => ({
      draft,
      blob: new Blob(
        (await chunksForDraft(database, draft.id)).map((chunk) => chunk.blob),
        { type: draft.mimeType },
      ),
    })))
  } finally {
    database.close()
  }
}

export function readLessonRecordingDrafts(ownerId: string) {
  return readDrafts(ownerId)
}

/**
 * Recovery-only escape hatch for drafts created by older tab-scoped owner ids.
 * This app is local-first/single-user, so a stranded IndexedDB draft is safer
 * to recover than to silently hide forever.
 */
export function readRecoverableLessonRecordingDrafts() {
  return readDrafts(null)
}

export async function removeLessonRecordingDraft(draftId: string) {
  const database = await openDatabase()
  try {
    const chunkTransaction = database.transaction(CHUNK_STORE, 'readwrite')
    const store = chunkTransaction.objectStore(CHUNK_STORE)
    const keys = await requestResult(store.index('draftId').getAllKeys(IDBKeyRange.only(draftId)))
    keys.forEach((key) => store.delete(key))
    await transactionDone(chunkTransaction)
    const draftTransaction = database.transaction(DRAFT_STORE, 'readwrite')
    draftTransaction.objectStore(DRAFT_STORE).delete(draftId)
    await transactionDone(draftTransaction)
  } finally {
    database.close()
  }
}
