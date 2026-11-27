/**
 * FileSystemFileHandle persistence for Ctrl+S "remember the save path".
 *
 * Why IndexedDB: a handle is a live object — JSON.stringify gives `{}`, so
 * localStorage cannot keep it. IndexedDB structured-clones the handle and it
 * survives app restarts (same Chromium partition). One record per canvas id,
 * so each canvas remembers its own .excalidraw file.
 *
 * Only scene (.excalidraw) handles are stored. Image handles (set by PNG/SVG
 * export) are deliberately skipped — they would make Ctrl+S overwrite an
 * image, and only the document path is worth remembering across restarts.
 *
 * Every API fails soft: with IndexedDB unavailable the feature degrades to
 * "remembered for this session only" (the handle still lives in appState).
 */
const DB_NAME = 'dsh-canvas'
const STORE = 'fileHandles'

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(mode, run) {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = run(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(request?.result ?? null)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** A scene handle is any non-image handle Excalidraw saves JSON documents to. */
export function isSceneFileHandle(handle) {
  return !!handle && typeof handle.name === 'string' && handle.name.endsWith('.excalidraw')
}

/** Persist the handle for one canvas. Resolves false when storage fails. */
export async function saveFileHandle(canvasId, handle) {
  try {
    await withStore('readwrite', (store) => store.put(handle, canvasId))
    return true
  } catch {
    return false
  }
}

/** The remembered handle for one canvas, or null (unknown/failed/deleted). */
export async function loadFileHandle(canvasId) {
  try {
    const handle = await withStore('readonly', (store) => store.get(canvasId))
    return isSceneFileHandle(handle) ? handle : null
  } catch {
    return null
  }
}

/** Forget a canvas's handle (canvas deletion). Never throws. */
export async function clearFileHandle(canvasId) {
  try {
    await withStore('readwrite', (store) => store.delete(canvasId))
  } catch {
    /* nothing to forget */
  }
}
