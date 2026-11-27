/**
 * dsh-canvas browser half.
 *
 * Registers two native right-sidebar tab TYPEs + BODYs, exactly like
 * dsh-better-sidebar does:
 *
 * - `sidebarRightTabs.register({ guide: [...] })` puts the canvas's card
 *   into the native guide (the "开始" panel in the right sidebar):
 *   "DSH Canvas" (Excalidraw);
 * - `sidebar.right.pane.tab` (keyed by the registration id) draws the tab
 *   body shown when a card is clicked;
 * - `sidebar.right.pane.tab.title` draws the tab chip title.
 *
 * Timing rule (learned from dsh-better-sidebar's source): the native seat
 * declares the `sidebar.right.pane.tab` slot BEFORE it provides the
 * `sidebarRightTabs` service, so we must `ctx.inject(['sidebarRightTabs'])`
 * and wait — reading it directly from the declaration callback misses the
 * service permanently.
 *
 * Workspace swap: while the canvas tab holds the column, the center column
 * and the right column trade places. The shell's AppFrame is a 3-track CSS
 * grid whose `grid-template-columns` is inline-written by JS on every
 * recompute, so plain `order` would mismatch the track sizing. Instead the
 * shell's RESOLVED track widths are mirrored — reordered — into a CSS
 * variable and applied with `!important`; the shell keeps owning every
 * number, we only mirror it. The swap lives and dies with the canvas tab
 * body's mount, so every exit path (Alt+`, tab close, tab switch) restores
 * the stock layout. AppFrame's css-module classes are `<hash>_<camel>` names
 * that change with every engine release (0.1.7 = `pI_x6G_`, 0.2.0/0.2.1 =
 * `BynINW_`), so nothing is hardcoded: the frame is located through the
 * stable `[data-rightbar-col]` attribute and the hash prefix is read off the
 * live className to build the stylesheet at mount time. Anything that fails
 * to match degrades to a no-op swap with a console warning.
 */

/** The registration id: unique across plugins, `<package>:<tool>`. */
const TAB_ID = 'dsh-canvas:canvas'

/** The command id shared by the guide entry and the shortcut registration. */
const COMMAND_ID = 'dsh-canvas.open'

const { createElement, useEffect, useState, useRef } = require('react')
const {
  Excalidraw,
  MainMenu,
  convertToExcalidrawElements,
  serializeAsJSON,
  MIME_TYPES,
} = require('@excalidraw/excalidraw')
const { useWorkspaceSwap } = require('./workspace-swap')
const { installCanvasPin, readPinned, writePinned } = require('./pin')
const {
  listCanvases,
  createCanvas,
  deleteCanvas,
  ensureCanvas,
  currentCanvasId,
  setCurrentCanvasId,
  loadScene,
  saveScene,
  pushScene,
  scheduleSave,
  flushSave,
} = require('./canvas/excalidraw-canvas-store')
const { resetFrameEraseTracker, rescueErasedFrames } = require('./canvas/frame-erase-rescue')
const { installMarqueeDirection } = require('./canvas/marquee-direction')
const { installRightDragArrow } = require('./canvas/right-drag-arrow')
const { installSpaceToSelect } = require('./canvas/space-to-select')
const { startCommandExecutor } = require('./canvas/command-executor')
const {
  isSceneFileHandle,
  saveFileHandle,
  loadFileHandle,
  clearFileHandle,
} = require('./canvas/file-handle-store')

/** Session-binding host handles, filled once the client services resolve. */
const host = { sessions: null, uiWorkspace: null, sidebarRight: null }

/**
 * The session currently on screen, read defensively off the shell's
 * `ctx.sidebarRight.mounted` (documented as the observable of the on-screen
 * session; its runtime shape may be a getter function or an observable
 * object — support both, plus id-bearing values).
 */
function readMountedSessionId() {
  const mounted = host.sidebarRight?.mounted
  if (mounted === undefined || mounted === null) return null
  try {
    const value = typeof mounted === 'function' ? mounted() : (mounted.get?.() ?? mounted.getSnapshot?.() ?? mounted)
    if (typeof value === 'string') return value || null
    return value?.sessionId ?? value?.id ?? null
  } catch {
    return null
  }
}
const SESSION_LINK_PREFIX = 'dsh-session://'

/** Blank-dblclick creates a boxed text block instead of plain text. */
const BOXED_TEXT_DBLCLICK = false

/** A bound block stores its session in the official element.link field. */
function linkedSessionId(element) {
  if (!element?.link || !element.link.startsWith(SESSION_LINK_PREFIX)) return null
  return element.link.slice(SESSION_LINK_PREFIX.length)
}

/** Viewport → scene coordinates (Excalidraw: scene = viewport/zoom - scroll). */
function scenePointAt(el, api, clientX, clientY) {
  const rect = el.getBoundingClientRect()
  const { zoom, scrollX, scrollY } = api.getAppState()
  const z = zoom.value
  return { x: (clientX - rect.left) / z - scrollX, y: (clientY - rect.top) / z - scrollY }
}

/** Element whose bbox (±4px slop) contains the scene point. Bound texts
 * resolve to their container so a block is addressed as one unit.
 *
 * Two pick rules:
 * - default (click navigation): prefer the LINKED candidate with the smallest
 *   area — the most specific target. Grouping can reorder z so a big frame
 *   sits above its inner blocks, and a plain topmost scan would always answer
 *   with the frame's session. Falls back to topmost when nothing is linked.
 * - `smallest` (Ctrl+right-click binding): the smallest-area candidate under
 *   the cursor regardless of linkage, so an unbound block inside a bound
 *   group can be bound (and the group itself by clicking its blank area). */
function hitElementAt(api, sceneX, sceneY, { smallest = false } = {}) {
  const elements = api.getSceneElements()
  const contains = (e) => {
    const x1 = Math.min(e.x, e.x + e.width) - 4
    const x2 = Math.max(e.x, e.x + e.width) + 4
    const y1 = Math.min(e.y, e.y + e.height) - 4
    const y2 = Math.max(e.y, e.y + e.height) + 4
    return sceneX >= x1 && sceneX <= x2 && sceneY >= y1 && sceneY <= y2
  }
  const candidates = []
  for (let i = elements.length - 1; i >= 0; i -= 1) {
    const e = elements[i]
    if (e.isDeleted || !contains(e)) continue
    const resolved = e.containerId
      ? (elements.find((x) => x.id === e.containerId) ?? e)
      : e
    candidates.push({
      el: resolved,
      // Most specific target wins: smallest footprint, topmost on ties.
      area: Math.abs((resolved.width ?? 0) * (resolved.height ?? 0)),
      top: i,
      linked: linkedSessionId(resolved) !== null,
    })
  }
  if (candidates.length === 0) return undefined
  let pool = candidates
  if (!smallest) {
    const linked = candidates.filter((c) => c.linked)
    if (linked.length > 0) pool = linked
  }
  pool = [...pool].sort((a, b) => a.area - b.area || b.top - a.top)
  return pool[0].el
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Write an element link straight into the canvas store (module-level
 * localStorage, survives any component unmount) and flush it synchronously.
 * Session navigation unmounts the canvas tab, so a link written through a
 * live Excalidraw API races its own death: the debounced onChange save never
 * fires on a dead instance. The store is the source of truth — a live API is
 * only refreshed best-effort afterwards for immediate visual feedback.
 */
function writeLinkToStore(elementId, link) {
  flushSave()
  const canvasId = currentCanvasId()
  if (!canvasId) return false
  const scene = loadScene(canvasId)
  let found = false
  const elements = scene.elements.map((e) => {
    if (e.id !== elementId) return e
    found = true
    return { ...e, link }
  })
  if (!found) return false
  saveScene(canvasId, elements, scene.appState)
  return true
}

/** Ids of every session row currently in the sidebar. */
function sidebarSessionIds() {
  return [...document.querySelectorAll('[data-row-key^="session:"]')].map((e) =>
    e.getAttribute('data-row-key').slice('session:'.length),
  )
}

/**
 * Make a session row appear and click it, penetrating whatever hides it:
 * clear the search filter (restored in `finally`), then repeatedly expand
 * "展开其余 N 个会话" overflow rows. Bounded rounds; false if never found.
 */
async function penetrateSidebarSession(sessionId, maxRounds = 10) {
  const key = `session:${sessionId}`
  const searchInput = () => document.querySelector('input[placeholder="搜索会话名称"]')
  const setInput = (input, value) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  let savedQuery = null
  let clearedFilter = false
  try {
    for (let round = 0; round < maxRounds; round++) {
      const row = document.querySelector(`[data-row-key="${key}"]`)
      if (row) {
        row.scrollIntoView({ block: 'center' })
        row.click()
        return true
      }
      const input = searchInput()
      if (input && input.value && !clearedFilter) {
        savedQuery = input.value
        clearedFilter = true
        setInput(input, '')
        await sleepMs(400)
        continue
      }
      const overflow = [...document.querySelectorAll('[data-row-key]')].find((e) =>
        e.getAttribute('data-row-key').includes('overflow'),
      )
      if (overflow) {
        overflow.scrollIntoView({ block: 'center' })
        overflow.click()
        await sleepMs(400)
        continue
      }
      return false
    }
    return false
  } finally {
    if (clearedFilter) {
      const input = searchInput()
      if (input && savedQuery != null) setInput(input, savedQuery)
    }
  }
}

// Excalidraw reads this at runtime for its fonts/static assets; the build
// inlines the CDN path (pinned to the installed package version).
if (typeof window !== 'undefined') window.EXCALIDRAW_ASSET_PATH = process.env.EXCALIDRAW_ASSET_PATH

/** The shell toggles dark mode via this attribute on <body>. */
function isDshDark() {
  return document.body.hasAttribute('data-ds-dark-theme')
}

/** Excalidraw's stylesheet + fonts come from the CDN copy of the same version. */
function ensureExcalidrawStyles() {
  if (document.querySelector('link[data-plugin="dsh-canvas-excalidraw"]') !== null) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.dataset.plugin = 'dsh-canvas-excalidraw'
  link.href = process.env.EXCALIDRAW_ASSET_PATH + 'index.css'
  document.head.appendChild(link)
}

/** Subscribe to the shell's dark-mode toggle. */
function useDshDarkTheme() {
  const [dark, setDark] = useState(isDshDark)
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDshDark()))
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** A minimal canvas glyph for the guide card (16px-friendly stroke icon). */
function CanvasIcon({ size = 16 }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
    createElement('rect', { x: 2, y: 2, width: 12, height: 12, rx: 2 }),
    createElement('path', { d: 'M5.5 10.5 8 5.5l2.5 5' }),
  )
}

const menuItemStyle = {
  display: 'block',
  width: '100%',
  padding: '7px 12px',
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 13,
  borderRadius: 6,
  whiteSpace: 'nowrap',
  color: 'inherit',
}

/** The tab body: the Excalidraw canvas inside the right sidebar. */
function CanvasBody() {
  useWorkspaceSwap()
  const dark = useDshDarkTheme()
  useEffect(ensureExcalidrawStyles, [])
  const [canvasId, setCanvasId] = useState(ensureCanvas)
  const [canvases, setCanvases] = useState(listCanvases)
  const apiRef = useRef(null)
  const wrapperRef = useRef(null)
  // Set (with a short arm window) by the pointerup sentinel while the eraser
  // tool is active — onChange reads it to scope the frame-erase rescue to
  // eraser commits only (Delete-key frame deletion stays stock).
  const eraserCommitRef = useRef(false)
  const activeToolRef = useRef(null)
  const executorRef = useRef(null)
  // Ctrl+S silent-overwrite target: mirrors the engine's appState.fileHandle;
  // only scene handles participate in persistence (see file-handle-store.js).
  const fileHandleRef = useRef(null)
  const [bindMenu, setBindMenu] = useState(null) // {x, y, elementId}
  // Bind mode: while set (elementId), the cursor recolors and the next click
  // on a sidebar session row binds it — no picker menu. Esc/other clicks exit.
  const [bindMode, setBindMode] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [toast, setToast] = useState(null) // string; auto-dismisses below
  useEffect(() => () => flushSave(), [])
  // Unmount disposes the L2 command executor (last change flushes via the
  // onChange debounced save above).
  useEffect(
    () => () => {
      executorRef.current?.()
      executorRef.current = null
    },
    [],
  )
  // Directional marquee: LTR = contained (stock), RTL = touch. See
  // src/canvas/marquee-direction.js + the build-time hook.
  useEffect(() => installMarqueeDirection(), [])
  // Right-drag arrow: drag with the RIGHT button to draw an arrow; right
  // click keeps the stock menu, Ctrl+right keeps the session-bind menu.
  useEffect(() => installRightDragArrow({ getApi: () => apiRef.current }), [])
  // Space → selection tool (replaces stock hold-space-to-pan)
  useEffect(() => installSpaceToSelect({ getApi: () => apiRef.current }), [])

  // Ctrl+S: silent overwrite through the remembered file handle. Excalidraw's
  // stock path never RE-REQUESTS handle permission (browser-fs-access treats
  // a 'prompt' handle as absent and falls back to the save-as dialog), which
  // is why saves stopped being silent after restarts. We pre-flight the
  // permission while the keystroke is still a user activation (Electron
  // auto-grants) and write the scene with the stock serializer. On any
  // failure (permission denied, file deleted → NotFoundError) we hand off to
  // the save-as flow, so the user always ends up with a save dialog, never a
  // swallowed key. Runs on window capture: Excalidraw's own handler sits on
  // document bubble phase (index.js: "addEventListener(document, keydown,
  // this.onKeyDown, false)") and only sees the key if we decline it.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey) return
      if (event.key !== 's' && event.key !== 'S') return
      if (!isSceneFileHandle(fileHandleRef.current)) return
      event.preventDefault()
      event.stopPropagation()
      ;(async () => {
        const handle = fileHandleRef.current
        const api = apiRef.current
        try {
          const opts = { mode: 'readwrite' }
          if ((await handle.queryPermission(opts)) !== 'granted') {
            if ((await handle.requestPermission(opts)) !== 'granted') {
              handleSaveToNewLocation()
              return
            }
          }
          if (!api) return
          const serialized = serializeAsJSON(
            api.getSceneElements(),
            api.getAppState(),
            api.getFiles(),
            'local',
          )
          const writable = await handle.createWritable()
          await writable.write(new Blob([serialized], { type: MIME_TYPES.excalidraw }))
          await writable.close()
          setToast(`已保存到「${handle.name}」`)
        } catch (error) {
          console.warn('dsh-canvas: silent save failed, opening save-as', error)
          handleSaveToNewLocation()
        }
      })()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  // Eraser-commit sentinel: pointerup (capture, before Excalidraw commits the
  // erase) arms a 300ms window when the active tool is the eraser. onChange
  // inside the window may rescue frame children; anything else (Delete key,
  // clear canvas, scene switch) stays stock. The window self-expires so a
  // stale arm can never rescue an unrelated later change.
  useEffect(() => {
    let timer = 0
    const onPointerUp = () => {
      if (activeToolRef.current !== 'eraser') return
      eraserCommitRef.current = true
      clearTimeout(timer)
      timer = setTimeout(() => {
        eraserCommitRef.current = false
      }, 300)
    }
    window.addEventListener('pointerup', onPointerUp, true)
    return () => {
      window.removeEventListener('pointerup', onPointerUp, true)
      clearTimeout(timer)
    }
  }, [])
  // Toast auto-dismiss: 4s, cleared early if a new toast replaces it.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  // Bind mode: the next document-level click on a sidebar session row binds
  // it to the pending element; any other click or Escape exits. Capture phase
  // so the shell's own row handler never races us.
  useEffect(() => {
    if (!bindMode) return
    const onPick = (event) => {
      const row = event.target instanceof Element && event.target.closest('[data-row-key^="session:"]')
      if (!row) {
        setBindMode(null)
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const sessionId = row.getAttribute('data-row-key').slice('session:'.length)
      setElementLink(bindMode, SESSION_LINK_PREFIX + sessionId)
      setBindMode(null)
      setToast('已绑定 ✓')
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setBindMode(null)
      }
    }
    document.addEventListener('click', onPick, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('click', onPick, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [bindMode])

  // Wheel swap: plain wheel zooms (cursor-anchored), Ctrl/⌘+wheel scrolls —
  // the reverse of Excalidraw's stock binding. The capture-phase listener
  // swallows the event before Excalidraw sees it; scene↔viewport math follows
  // viewportCoordsToSceneCoords: scene = viewport/zoom - scroll.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onWheel = (event) => {
      const api = apiRef.current
      if (!api || (!event.deltaY && !event.deltaX)) return
      event.preventDefault()
      event.stopPropagation()
      const { zoom, scrollX, scrollY } = api.getAppState()
      const z = zoom.value
      const rect = el.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      if (event.ctrlKey || event.metaKey) {
        const dx = event.shiftKey ? event.deltaY : event.deltaX
        const dy = event.shiftKey ? 0 : event.deltaY
        api.updateScene({ appState: { scrollX: scrollX - dx / z, scrollY: scrollY - dy / z } })
      } else {
        const next = Math.min(30, Math.max(0.1, z * Math.exp(-event.deltaY * 0.0015)))
        const sceneX = px / z - scrollX
        const sceneY = py / z - scrollY
        api.updateScene({
          appState: { zoom: { value: next }, scrollX: px / next - sceneX, scrollY: py / next - sceneY },
        })
      }
    }
    el.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => el.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // Double-click on blank canvas → a boxed text block (rectangle container +
  // bound text, the same mechanism Obsidian's Excalidraw uses), replacing the
  // stock plain-text-on-blank-dblclick. Double-clicks on elements keep stock
  // behavior. Off by default — blank dblclick keeps Excalidraw's plain text.
  useEffect(() => {
    if (!BOXED_TEXT_DBLCLICK) return
    const el = wrapperRef.current
    if (!el) return
    const onDblClick = (event) => {
      const api = apiRef.current
      if (!api) return
      const pt = scenePointAt(el, api, event.clientX, event.clientY)
      if (hitElementAt(api, pt.x, pt.y)) return
      event.preventDefault()
      event.stopPropagation()
      // 0.18.1's convertToExcalidrawElements mangles containerId skeletons
      // (regenerates the box id, leaves the text's stale reference and null
      // coords), so convert the two elements separately and wire the binding
      // by hand against the real ids.
      const [box] = convertToExcalidrawElements([
        { type: 'rectangle', x: pt.x - 80, y: pt.y - 42, width: 160, height: 84, backgroundColor: 'transparent' },
      ])
      const [text] = convertToExcalidrawElements([
        { type: 'text', x: pt.x, y: pt.y, text: '输入文本', fontSize: 20, textAlign: 'center', verticalAlign: 'middle' },
      ])
      text.containerId = box.id
      text.x = box.x + box.width / 2 - text.width / 2
      text.y = box.y + box.height / 2 - text.height / 2
      box.boundElements = [{ id: text.id, type: 'text' }]
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), box, text] })
    }
    el.addEventListener('dblclick', onDblClick, { capture: true })
    return () => el.removeEventListener('dblclick', onDblClick, { capture: true })
  }, [])

  // Ctrl+right-click on a block → session-binding menu (stock context menu is
  // kept for plain right-clicks and blank Ctrl+right-clicks).
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onContextMenu = (event) => {
      if (!event.ctrlKey) return
      const api = apiRef.current
      if (!api) return
      const pt = scenePointAt(el, api, event.clientX, event.clientY)
      // Binding picks the most specific element under the cursor regardless
      // of linkage — this is how an unbound block inside a bound group gets
      // its own session (and the group is bound via its blank area).
      const hit = hitElementAt(api, pt.x, pt.y, { smallest: true })
      if (!hit) return
      event.preventDefault()
      event.stopPropagation()
      setBindMode(null)
      setBindMenu({ x: event.clientX, y: event.clientY, elementId: hit.id })
    }
    el.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => el.removeEventListener('contextmenu', onContextMenu, { capture: true })
  }, [])

  // Plain click on a bound block → select that session in the left sidebar
  // (native row click keeps the canvas tab open, unlike uiWorkspace.openSession
  // which closes it). If the row is hidden by search filter or collapsed into
  // an overflow row, penetrate: clear the filter (restore afterwards) and
  // expand overflow rows until the row renders. Drag/dblclick unaffected.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onClick = (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.button !== 0) return
      const api = apiRef.current
      if (!api) return
      const pt = scenePointAt(el, api, event.clientX, event.clientY)
      const hit = hitElementAt(api, pt.x, pt.y)
      const sessionId = linkedSessionId(hit)
      if (!sessionId) return
      const row = document.querySelector(`[data-row-key="session:${sessionId}"]`)
      if (row) {
        row.scrollIntoView({ block: 'nearest' })
        row.click()
        return
      }
      penetrateSidebarSession(sessionId).then((found) => {
        if (!found) setToast('绑定的会话不存在（可能已删除）')
      })
    }
    el.addEventListener('click', onClick, { capture: true })
    return () => el.removeEventListener('click', onClick, { capture: true })
  }, [])

  const setElementLink = (elementId, link) => {
    const api = apiRef.current
    if (!api) return
    api.updateScene({
      elements: api.getSceneElementsIncludingDeleted().map((e) => (e.id === elementId ? { ...e, link } : e)),
    })
  }
  // Full native Ctrl+N flow: click the shell's own 新建会话 button, then bind
  // whichever session lands on screen — the engine REUSES the first eligible
  // blank session when one exists, so "a new sidebar row appears" is NOT a
  // reliable signal. Two hits are accepted: a brand-new sidebar row, or the
  // on-screen session id changing. Only a timeout (e.g. a workspace picker
  // popped up) falls back to manual binding.
  const bindToNewSession = async (elementId) => {
    const btn = document.querySelector('button[aria-label="新建会话"]')
    if (!btn) {
      setToast('找不到「新建会话」按钮')
      return
    }
    const beforeRows = new Set(sidebarSessionIds())
    const beforeMounted = readMountedSessionId()
    btn.click()
    const t0 = Date.now()
    let newId = null
    while (Date.now() - t0 < 8000 && !newId) {
      await sleepMs(300)
      for (const id of sidebarSessionIds()) {
        if (!beforeRows.has(id)) {
          newId = id
          break
        }
      }
      if (!newId) {
        const mounted = readMountedSessionId()
        if (mounted && mounted !== beforeMounted) newId = mounted
      }
    }
    if (!newId) {
      setToast('未捕捉到新会话（可能弹出了新建选择框），请手动绑定')
      return
    }
    // Persistence is racy around the pin's remount: this closure's apiRef
    // belongs to the canvas instance that session navigation just killed, so
    // writes through it land on a dead Excalidraw while the remounted
    // instance keeps linkless memory — its next debounced onChange then
    // erases the store link (the user-visible "bind failed"). The fix: drive
    // the CURRENT live api (the test bridge is repointed on every mount) and
    // require BOTH the live scene and the store to carry the link.
    const link = SESSION_LINK_PREFIX + newId
    const currentApi = () => {
      try {
        return window.__dshCanvasTest?.excalidraw ?? apiRef.current
      } catch {
        return apiRef.current
      }
    }
    for (let round = 0; round < 10; round += 1) {
      if (!writeLinkToStore(elementId, link)) {
        setToast('绑定失败：画布中找不到该图块')
        return
      }
      const api = currentApi()
      let drove = false
      try {
        if (api?.getSceneElements?.().some((e) => e.id === elementId)) {
          api.updateScene({
            elements: api.getSceneElementsIncludingDeleted().map((e) => (e.id === elementId ? { ...e, link } : e)),
          })
          drove = true
        }
      } catch {
        /* dead instance — the store write above covers the next mount */
      }
      await sleepMs(600)
      try {
        const scene = loadScene(currentCanvasId())
        const element = scene.elements.find((e) => e.id === elementId)
        const storeOk = element?.link === link
        let liveOk = true // no live canvas mounted → store alone is consistent
        try {
          const live = currentApi()?.getSceneElements?.().find((e) => e.id === elementId)
          if (live !== undefined) liveOk = live?.link === link
        } catch {
          /* treat unreadable api as absent */
        }
        if (storeOk && liveOk) return
        void drove
      } catch {
        /* fall through to the next round */
      }
    }
    setToast('绑定未能持久化（画布重载竞争），请重试一次')
  }

  // 分支会话：fork 该图块绑定的会话（继承完整历史），成功后直接打开新
  // 会话（uiWorkspace.openSession 会切走画布标签）；图块保持绑定旧会话。
  // 壳层 ClientSessions.fork 的真实契约（CDP 实证）：成功 resolve 子会话 id
  // 字符串，失败 throw SessionForkError —— 不是 {ok, value} 信封。曾按信封
  // 判断导致「成功被当失败、自动重试 → fork 出两个」的回归，故：
  // try/catch 收敛 + 不做任何自动重试（需要迁移等失败让用户再点一次）。
  const branchingRef = useRef(false)
  const branchSession = async (elementId) => {
    if (branchingRef.current) return
    branchingRef.current = true
    try {
      const element = apiRef.current?.getSceneElements().find((e) => e.id === elementId)
      const sessionId = linkedSessionId(element)
      if (!sessionId) {
        setToast('该图块未绑定会话')
        return
      }
      if (typeof host.sessions?.fork !== 'function') {
        setToast('会话服务不支持分支')
        return
      }
      let childId = null
      let failure = null
      try {
        childId = await host.sessions.fork({ sessionId })
      } catch (error) {
        failure = error
      }
      // 容错：即便未来换成信封形状，也能从两种形状里取出 id。
      if (childId && typeof childId === 'object') {
        childId = childId.ok
          ? childId.value?.sessionId
          : (typeof childId.error?.details?.sessionId === 'string' ? childId.error.details.sessionId : null)
      }
      if (!childId || typeof childId !== 'string') {
        const detail = failure?.message ?? failure?.code ?? (failure ? String(failure) : '未知错误')
        setToast(`分支失败：${detail}`)
        return
      }
      try {
        await host.uiWorkspace?.openSession?.(childId)
      } catch (error) {
        console.warn('dsh-canvas: openSession after fork failed', error)
      }
      setToast('已分支会话')
    } finally {
      branchingRef.current = false
    }
  }

  const refreshCanvases = () => setCanvases(listCanvases())
  const handleCreate = () => {
    flushSave()
    createCanvas(`画布 ${canvases.length + 1}`)
    refreshCanvases()
    setCanvasId(currentCanvasId())
  }
  // Save-as: write through a freshly picked handle (showSaveFilePicker) and
  // let the new handle flow back through onChange, which re-persists it. Used
  // by the「保存到新位置」menu item and as the Ctrl+S silent-save fallback.
  const handleSaveToNewLocation = async () => {
    const api = apiRef.current
    if (!api) return
    const name = canvases.find((c) => c.id === canvasId)?.name ?? '画布'
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: `${name}.excalidraw`,
        types: [{ description: 'Excalidraw file', accept: { 'application/json': ['.excalidraw'] } }],
      })
      const serialized = serializeAsJSON(
        api.getSceneElements(),
        { ...api.getAppState(), fileHandle: null },
        api.getFiles(),
        'local',
      )
      const writable = await handle.createWritable()
      await writable.write(new Blob([serialized], { type: MIME_TYPES.excalidraw }))
      await writable.close()
      api.updateScene({ appState: { fileHandle: handle } })
      setToast(`已保存到「${handle.name}」`)
    } catch (error) {
      if (error?.name !== 'AbortError') console.warn('dsh-canvas: save-as failed', error)
    }
  }
  // Delete confirmation is an in-page dialog, NOT window.confirm: Electron's
  // native confirm/alert does not hand focus back to the renderer after it
  // closes — document.hasFocus() stays false, so Excalidraw's text caret is
  // never painted and keyboard input goes nowhere (blank-dblclick "cannot
  // type" bug after deleting a canvas).
  const handleDeleteCurrent = () => {
    if (canvases.length <= 1) return
    setBindMenu(null)
    setBindMode(null)
    setConfirmDelete(true)
  }
  const confirmDeleteCurrent = () => {
    setConfirmDelete(false)
    flushSave()
    void clearFileHandle(canvasId)
    deleteCanvas(canvasId)
    refreshCanvases()
    setCanvasId(currentCanvasId())
  }
  return createElement(
    'div',
    { ref: wrapperRef, style: {
      width: '100%',
      height: '100%',
      // Bind mode: recolored cursor (violet dot) — CSS cursors can't be
      // recolored natively, so swap in a tiny inline SVG pointer.
      cursor: bindMode
        ? `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="8" fill="%237c5cff" fill-opacity="0.85"/><circle cx="12" cy="12" r="3" fill="white"/></svg>') 12 12, crosshair`
        : undefined,
    } },
    createElement(
      Excalidraw,
      {
        key: canvasId,
        theme: dark ? 'dark' : 'light',
        langCode: 'zh-CN',
        initialData: async () => {
          const scene = loadScene(canvasId)
          // Mount-time push so the host mirror is fresh even without a
          // user edit (covers "canvas just opened" reads).
          pushScene(canvasId, scene.elements, scene.appState)
          // Restore the remembered Ctrl+S target: Excalidraw keeps a supplied
          // fileHandle (part of getDefaultAppState, survives restore), so the
          // first Ctrl+S after a restart overwrites instead of re-prompting.
          const remembered = await loadFileHandle(canvasId)
          const appState = scene.appState ?? (remembered ? {} : undefined)
          if (remembered && appState) appState.fileHandle = remembered
          return { elements: scene.elements, appState }
        },
        excalidrawAPI: (api) => {
          apiRef.current = api
          resetFrameEraseTracker()
          executorRef.current?.()
          executorRef.current = startCommandExecutor(() => apiRef.current, canvasId)
          if (typeof window !== 'undefined' && window.__dshCanvasTest) window.__dshCanvasTest.excalidraw = api
        },
        onChange: (elements, appState) => {
          activeToolRef.current = appState?.activeTool?.type ?? null
          const rescued = rescueErasedFrames(elements, eraserCommitRef.current)
          if (rescued && apiRef.current) apiRef.current.updateScene({ elements: rescued })
          scheduleSave(canvasId, rescued ?? elements, appState)
          // Mirror the engine's fileHandle into the per-canvas IDB record:
          // a scene handle is stored, null clears it, image handles (PNG/SVG
          // export) never touch the stored scene target.
          const handle = appState?.fileHandle ?? null
          if (handle !== fileHandleRef.current) {
            fileHandleRef.current = handle
            if (isSceneFileHandle(handle)) void saveFileHandle(canvasId, handle)
            else if (!handle) void clearFileHandle(canvasId)
          }
        },
      },
      createElement(
        MainMenu,
        { onSelect: refreshCanvases },
        createElement(MainMenu.Item, { onSelect: handleCreate }, '新建画布'),
        canvases.length > 1
          ? createElement(MainMenu.Item, { onSelect: handleDeleteCurrent }, '删除当前画布')
          : null,
        createElement(MainMenu.Separator),
        createElement(
          MainMenu.Group,
          { title: '画布列表' },
          canvases.map((c) =>
            createElement(
              MainMenu.Item,
              { key: c.id, selected: c.id === canvasId, onSelect: () => {
                flushSave()
                setCurrentCanvasId(c.id)
                setCanvasId(c.id)
              } },
              c.name,
            ),
          ),
        ),
        createElement(MainMenu.Separator),
        createElement(MainMenu.DefaultItems.SaveAsImage),
        createElement(MainMenu.Item, { onSelect: handleSaveToNewLocation }, '保存到新位置'),
        createElement(MainMenu.DefaultItems.ClearCanvas),
        createElement(MainMenu.DefaultItems.Help),
        createElement(MainMenu.DefaultItems.ToggleTheme),
        createElement(MainMenu.DefaultItems.ChangeCanvasBackground),
      ),
    ),
    bindMenu &&
      createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 100000 },
        onClick: () => setBindMenu(null),
        onContextMenu: (e) => {
          e.preventDefault()
          setBindMenu(null)
        },
      }),
    bindMenu &&
      createElement(
        'div',
        {
          style: {
            position: 'fixed',
            zIndex: 100001,
            left: Math.min(bindMenu.x, window.innerWidth - 220),
            top: Math.min(bindMenu.y, window.innerHeight - 220),
            minWidth: 200,
            background: dark ? '#2e2d39' : '#ffffff',
            color: dark ? '#e3e5eb' : '#1b1b1f',
            border: `1px solid ${dark ? '#403e4f' : '#e0e0e0'}`,
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,.2)',
            padding: 4,
          },
          onClick: (e) => e.stopPropagation(),
        },
        createElement('div', { style: { padding: '6px 12px 4px', fontSize: 11, opacity: 0.55 } }, '会话绑定'),
        !host.sessions && createElement('div', { style: { padding: '6px 12px', opacity: 0.6 } }, '会话服务未就绪'),
        host.sessions &&
          (linkedSessionId(apiRef.current?.getSceneElements().find((e) => e.id === bindMenu.elementId))
            ? createElement('button', {
                style: menuItemStyle,
                onClick: () => {
                  setElementLink(bindMenu.elementId, null)
                  setBindMenu(null)
                },
              }, '取消绑定')
            : [
                createElement('button', {
                  key: 'new',
                  style: menuItemStyle,
                  onClick: () => {
                    bindToNewSession(bindMenu.elementId).finally(() => setBindMenu(null))
                  },
                }, '创建会话'),
                createElement('button', {
                  key: 'pick',
                  style: menuItemStyle,
                  onClick: () => {
                    // No picker menu: enter bind mode — cursor recolors, next
                    // sidebar session row click binds (Esc/other click exits).
                    setBindMenu(null)
                    setBindMode(bindMenu.elementId)
                  },
                }, '绑定会话'),
              ]),
        host.sessions &&
          createElement('button', {
            key: 'branch',
            style: menuItemStyle,
            onClick: () => {
              // 未绑定的图块也常驻此项：点击时在 branchSession 里 toast 提示，
              // 避免「菜单里少了分支会话」与「bundle 未刷新」混淆难辨。
              branchSession(bindMenu.elementId).finally(() => setBindMenu(null))
            },
          }, '分支会话'),
        createElement('button', {
          key: 'automation',
          style: menuItemStyle,
          onClick: () => {
            setBindMenu(null)
            setToast('自动化任务：交互还在规划中')
          },
        }, '自动化任务'),
      ),
    bindMode &&
      createElement(
        'div',
        {
          style: {
            position: 'fixed',
            zIndex: 100002,
            left: '50%',
            bottom: 32,
            transform: 'translateX(-50%)',
            padding: '9px 16px',
            borderRadius: 8,
            background: dark ? '#2f2a44' : '#f1edff',
            color: dark ? '#cfc4ff' : '#5b3df5',
            border: `1px solid ${dark ? '#4a4070' : '#d8ccff'}`,
            boxShadow: '0 6px 18px rgba(0,0,0,.18)',
            fontSize: 13,
            pointerEvents: 'none',
          },
        },
        '绑定模式：在左侧会话列表点击要绑定的会话（Esc 取消）',
      ),
    confirmDelete &&
      createElement('div', {
        style: { position: 'fixed', inset: 0, zIndex: 100000 },
        onClick: () => setConfirmDelete(false),
      }),
    confirmDelete &&
      createElement(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          onKeyDown: (e) => {
            if (e.key === 'Escape') setConfirmDelete(false)
            if (e.key === 'Enter') confirmDeleteCurrent()
          },
          style: {
            position: 'fixed',
            zIndex: 100001,
            left: '50%',
            top: '40%',
            transform: 'translate(-50%, -50%)',
            minWidth: 280,
            maxWidth: 360,
            background: dark ? '#2e2d39' : '#ffffff',
            color: dark ? '#e3e5eb' : '#1b1b1f',
            border: `1px solid ${dark ? '#403e4f' : '#e0e0e0'}`,
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,.2)',
            padding: 16,
          },
        },
        createElement(
          'div',
          { style: { fontSize: 14, lineHeight: 1.5, marginBottom: 14 } },
          `删除「${canvases.find((c) => c.id === canvasId)?.name}」？内容不可恢复。`,
        ),
        createElement(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          createElement(
            'button',
            {
              autoFocus: true,
              style: {
                ...menuItemStyle,
                display: 'inline-block',
                width: 'auto',
                textAlign: 'center',
                border: `1px solid ${dark ? '#403e4f' : '#e0e0e0'}`,
              },
              onClick: () => setConfirmDelete(false),
            },
            '取消',
          ),
          createElement(
            'button',
            {
              style: {
                ...menuItemStyle,
                display: 'inline-block',
                width: 'auto',
                textAlign: 'center',
                background: '#d13438',
                color: '#fff',
              },
              onClick: confirmDeleteCurrent,
            },
            '删除',
          ),
        ),
      ),
    toast &&
      createElement(
        'div',
        {
          style: {
            position: 'fixed',
            zIndex: 100002,
            left: '50%',
            bottom: 32,
            transform: 'translateX(-50%)',
            maxWidth: 420,
            padding: '9px 16px',
            borderRadius: 8,
            background: dark ? '#3a2f31' : '#fdecec',
            color: dark ? '#f2c4c6' : '#a4262c',
            border: `1px solid ${dark ? '#5c4044' : '#f1bcbf'}`,
            boxShadow: '0 6px 18px rgba(0,0,0,.18)',
            fontSize: 13,
            pointerEvents: 'none',
          },
        },
        toast,
      ),
  )
}

export const inject = ['slots', 'sidebarRightTabs', 'shortcuts']

/** Test hook: lets the shim harness render the tab body without a shell. */
export const __internal = { CanvasBody }

export function apply(ctx) {
  installTestBridge(ctx)
  // Canvas pin sentinel (plugin lifetime, survives tab unmounts): re-opens
  // the canvas tab when a session switch orphans it. See src/pin.js.
  const disposePin = installCanvasPin(() => {
    try {
      return ctx.get('sidebarRight')
    } catch {
      return null
    }
  })
  try {
    ctx.inject(['sidebarRight'], (scope) => {
      host.sidebarRight = scope.get('sidebarRight')
    })
  } catch {
    /* readMountedSessionId is null-safe when the service never appears */
  }
  try {
    ctx.inject(['sessions', 'uiWorkspace'], (scope) => {
      host.sessions = scope.get('sessions')
      host.uiWorkspace = scope.get('uiWorkspace')
    })
  } catch (error) {
    console.warn('dsh-canvas: session services unavailable', error)
  }
  const seat = ctx.inject(['sidebarRightTabs', 'shortcuts'], (injected) => {
    const tabs = injected.get('sidebarRightTabs')
    const shortcuts = injected.get('shortcuts')
    if (tabs === undefined) return

    // One tab TYPE: the guide card ("DSH Canvas") in the 开始 panel.
    const disposeType = tabs.register({
      id: TAB_ID,
      kind: 'canvas',
      priority: 'extension',
      title: () => 'DSH Canvas',
      guide: [
        {
          order: 50,
          title: () => 'DSH Canvas',
          description: () => '打开/关闭画布工作区',
          icon: (props) => CanvasIcon({ size: props?.size ?? 16 }),
          // Matched against the shortcuts registry by id: the shell renders
          // the binding's keys at the right edge of the card.
          commandId: COMMAND_ID,
        },
      ],
    })

    // The Alt+` shortcut toggles the workspace: open the canvas tab (which
    // mounts the swap) or close it (whose unmount restores the layout).
    const disposeShortcut = shortcuts?.register({
      id: COMMAND_ID,
      label: () => '打开/关闭 DSH Canvas',
      aliases: ['canvas', '画布'],
      defaults: {
        'desktop:windows': { code: 'Backquote', modifiers: ['alt'] },
        'desktop:linux': { code: 'Backquote', modifiers: ['alt'] },
        'desktop:macos': { code: 'Backquote', modifiers: ['alt'] },
      },
      regions: ['page'],
      modals: [],
      resolve: () => ({
        status: 'handled',
        run: () => toggleWorkspace(ctx),
      }),
    })

    // One tab BODY + one chip TITLE, dispatched by the registration id.
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          inject: () => ({}),
        },
        CanvasBody,
      ),
    )
    const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () =>
      ctx.slots.register(
        {
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          inject: () => ({}),
        },
        () => 'DSH Canvas',
      ),
    )

    return () => {
      disposeShortcut?.()
      disposeTitle()
      disposeBody()
      disposeType()
    }
  })

  return () => {
    disposePin()
    seat.dispose()
  }
}

/**
 * CDP test bridge (window.__dshCanvasTest): opens/closes sidebar tabs
 * directly. The guide card path breaks once the panel goes empty (the guide
 * unmounts with it), so scripted tests need a handle that survives that.
 * Lazy sidebarRight lookups — the service resolves at call time.
 */
function installTestBridge(ctx) {
  if (typeof window === 'undefined') return
  const sidebarRight = () => ctx.get('sidebarRight')
  window.__dshCanvasTest = {
    open: (id) => sidebarRight()?.openTab?.(id),
    active: () => sidebarRight()?.active?.(),
    exHelpers: { convertToExcalidrawElements },
    canvasStore: { listCanvases, createCanvas, deleteCanvas, currentCanvasId, setCurrentCanvasId },
    closeActive: () => {
      const service = sidebarRight()
      const active = service?.active?.()
      if (active) service.close(active.id)
      return active?.id ?? null
    },
  }
  // Session-binding probe: does the desktop client inject the `sessions`
  // service, and does create/open drive the shell UI? (Canvas×session
  // binding feasibility test; harmless if the service never appears.)
  try {
    ctx.inject(['sessions', 'uiWorkspace'], (scope) => {
      const sessions = scope.get('sessions')
      if (!sessions) return
      const uiWorkspace = scope.get('uiWorkspace')
      window.__dshCanvasTest.sessions = {
        raw: sessions,
        keys: Object.getOwnPropertyNames(Object.getPrototypeOf(sessions) ?? {}),
        create: (opts) => sessions.create?.(opts),
        openSession: (id) => uiWorkspace?.openSession?.(id),
        listSnapshot: () => {
          try {
            return sessions.getListSnapshot?.() ?? null
          } catch (error) {
            return { error: String(error) }
          }
        },
        search: (q) => sessions.search?.(q),
        // Diagnostics: the pin/bind paths read the on-screen session through
        // this handle; expose it so CDP tests can verify the read works.
        mountedSessionId: () => readMountedSessionId(),
        sidebarRightRaw: () => host.sidebarRight,
      }
    })
  } catch (error) {
    console.warn('dsh-canvas: sessions probe unavailable', error)
  }
}

/**
 * Alt+` workspace toggle: the canvas tab being the column's active tab IS the
 * open state (the swap mounts and unmounts with its body). Closing falls back
 * to the sole docked guide, which the shell keeps open.
 */
function toggleWorkspace(ctx) {
  const sidebarRight = ctx.get('sidebarRight')
  try {
    const active = sidebarRight?.active?.()
    if (active?.kind === 'canvas') {
      // Legal exit B: the user is closing the workspace — unpin FIRST so the
      // pin sentinel never sees the disappearance as engine-forced.
      writePinned(false)
      sidebarRight.close(active.id)
    } else {
      sidebarRight?.openTab?.('canvas')
      // Presence itself re-pins via the sentinel; write eagerly anyway so a
      // session switch in the same tick is already covered.
      writePinned(true)
    }
  } catch (error) {
    console.error('dsh-canvas: toggle workspace failed', error)
  }
}
