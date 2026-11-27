/**
 * Multi-canvas persistence for the embedded Excalidraw.
 *
 * One localStorage index (`<id, name>`) plus one scene record per canvas.
 * The active canvas id survives tab close/reopen and app restarts; saves are
 * debounced because onChange fires on every pointer move while drawing.
 */
const INDEX_KEY = 'dsh-canvas:excalidraw:index'
const CURRENT_KEY = 'dsh-canvas:excalidraw:current'
const sceneKey = (id) => `dsh-canvas:excalidraw:scene:${id}`

function readIndex() {
  try {
    const list = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writeIndex(list) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list))
}

export function listCanvases() {
  return readIndex()
}

export function createCanvas(name) {
  const list = readIndex()
  const id = `cv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const entry = { id, name, createdAt: Date.now() }
  list.push(entry)
  writeIndex(list)
  localStorage.setItem(sceneKey(id), JSON.stringify({ elements: [], appState: null }))
  setCurrentCanvasId(id)
  return entry
}

/** Remove a canvas from the index and drop its scene; returns the next id. */
export function deleteCanvas(id) {
  const list = readIndex().filter((c) => c.id !== id)
  writeIndex(list)
  localStorage.removeItem(sceneKey(id))
  if (currentCanvasId() === id) {
    if (list[0]) setCurrentCanvasId(list[0].id)
    else localStorage.removeItem(CURRENT_KEY)
  }
  return list[0]?.id ?? null
}

export function currentCanvasId() {
  const id = localStorage.getItem(CURRENT_KEY)
  const list = readIndex()
  if (id && list.some((c) => c.id === id)) return id
  return list[0]?.id ?? null
}

export function setCurrentCanvasId(id) {
  localStorage.setItem(CURRENT_KEY, id)
}

/** The id to mount with: the active one, or a freshly created first canvas. */
export function ensureCanvas() {
  const id = currentCanvasId()
  if (id) return id
  return createCanvas('画布 1').id
}

export function loadScene(id) {
  try {
    const data = JSON.parse(localStorage.getItem(sceneKey(id)) ?? 'null')
    return data && Array.isArray(data.elements) ? data : { elements: [], appState: null }
  } catch {
    return { elements: [], appState: null }
  }
}

/** Persist a scene: drop deleted elements, keep only the small view state. */
export function saveScene(id, elements, appState) {
  const payload = {
    elements: elements.filter((el) => !el.isDeleted),
    appState: appState
      ? {
          viewBackgroundColor: appState.viewBackgroundColor,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom,
        }
      : null,
    savedAt: Date.now(),
  }
  localStorage.setItem(sceneKey(id), JSON.stringify(payload))
  pushScene(id, payload.elements, payload.appState)
}

/**
 * Fire-and-forget push of one scene snapshot to the plugin's host half.
 * Same-origin in web mode; on desktop the dsh-app:// carrier forwards
 * non-static paths to the host webserver, so the relative URL works both
 * ways. Failures are swallowed: pushing is an enhancement of the local
 * localStorage persistence, never a blocker for it.
 */
export function pushScene(id, elements, appState) {
  try {
    const name = readIndex().find((c) => c.id === id)?.name ?? null
    fetch('/dsh-canvas/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canvasId: id, name, elements: elements ?? [], appState: appState ?? null }),
    }).catch(() => {})
  } catch {
    /* fetch unavailable or page tearing down — ignore */
  }
}

let pending = null
let timer = null

/** Debounced save — onChange fires on every drag frame, writes collapse. */
export function scheduleSave(id, elements, appState, delay = 400) {
  pending = { id, elements, appState }
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (pending) saveScene(pending.id, pending.elements, pending.appState)
  }, delay)
}

/** Synchronous flush for tab-body unmount (last change must not be lost). */
export function flushSave() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (pending) {
    saveScene(pending.id, pending.elements, pending.appState)
    pending = null
  }
}
