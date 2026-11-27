/**
 * Canvas pin — keeps the DSH Canvas tab in the foreground across session
 * switches.
 *
 * Engine fact (ui-sidebar-right): every session owns its own dock surface,
 * and a brand-new session starts with an EMPTY, COLLAPSED surface. So any
 * "新会话" (or any other session navigation) makes the canvas tab vanish and
 * the shell layout snap back to stock. We cannot change the engine, so we
 * correct it: a plugin-level sentinel (it deliberately does NOT live inside
 * the tab body — a dead component cannot resurrect itself) watches for the
 * canvas chip disappearing and re-opens the tab, which drags the workspace
 * swap back with it.
 *
 * The rules, agreed with the user:
 * - `pinned` (localStorage) means "the canvas SHOULD be in the foreground".
 *   It is set whenever the chip is seen, and survives page reloads.
 * - Three legal ways to interrupt the canvas, all user gestures:
 *     A. clicking the chip's ×       → chip gone + recent rightbar pointerdown
 *     B. Alt+` toggle                → handled in client.jsx (writes pinned
 *                                      directly, sentinel stays out of the way)
 *     C. activating another tab      → chip STAYS (canvas backgrounded), the
 *                                      sentinel only acts on disappearance
 * - The same outcome (chip gone) is judged by its cause: a recent pointer
 *   event inside the right column means the user closed it (A) → unpin;
 *   no gesture means the engine moved the session out from under us → restore.
 */

const PIN_KEY = 'dsh-canvas.pinned'
const POLL_MS = 300
/** A close click and the resulting chip removal land within this window. */
const USER_GESTURE_MS = 600
/** Restore attempts per disappearance: 40 × 250ms ≈ 10s, enough to ride out
 * both engine startup (plugin apply runs before the shell UI exists) and
 * session-navigation churn. */
const RESTORE_ATTEMPTS = 40
const RESTORE_INTERVAL_MS = 250

export function readPinned() {
  try {
    return localStorage.getItem(PIN_KEY) === '1'
  } catch {
    return false
  }
}

export function writePinned(value) {
  try {
    if (value) localStorage.setItem(PIN_KEY, '1')
    else localStorage.removeItem(PIN_KEY)
  } catch {
    /* storage unavailable (private mode etc.) — pin degrades to in-memory */
  }
}

/**
 * The canvas tab chip lives in the right sidebar's tab strip. Tab chips are
 * real tab widgets (role="tab") whose text starts with our title; guide cards
 * in the 开始 panel are plain buttons and do not match.
 */
function canvasChip() {
  for (const tab of document.querySelectorAll('[role="tab"]')) {
    if ((tab.textContent || '').trim().startsWith('DSH Canvas')) return tab
  }
  return null
}

/**
 * Install the sentinel. `getSidebarRight` must return the shell's
 * `ctx.sidebarRight` service at call time (it resolves after plugin apply).
 * Returns a dispose function.
 */
export function installCanvasPin(getSidebarRight) {
  let seen = false // canvas chip existed as of the previous tick
  let lastRightbarGesture = 0
  let restoring = false

  const onPointerDown = (event) => {
    // Only gestures ON the tab strip count as "the user closed the tab".
    // The right column as a whole is too broad: canvas interactions (e.g. the
    // bind menu's 创建会话 button, which lives inside the canvas body) also
    // land in the right column and are immediately followed by session
    // navigation — marking those mistakes an engine-forced removal for a
    // user close and unpins wrongly.
    if (
      event.target instanceof Element &&
      event.target.closest('[role="tab"]') !== null
    ) {
      lastRightbarGesture = Date.now()
    }
  }
  window.addEventListener('pointerdown', onPointerDown, true)

  const restore = () => {
    if (restoring) return
    restoring = true
    let attempts = 0
    const tryOnce = () => {
      attempts += 1
      try {
        getSidebarRight()?.openTab?.('canvas')
      } catch {
        // No session on screen (hero page) or runtime not ready — retry until
        // the budget runs out, then wait for the next disappearance.
      }
      if (canvasChip()) {
        restoring = false
        return
      }
      if (attempts >= RESTORE_ATTEMPTS) {
        restoring = false
        return
      }
      setTimeout(tryOnce, RESTORE_INTERVAL_MS)
    }
    tryOnce()
  }

  const tick = () => {
    const chip = canvasChip()
    if (chip) {
      seen = true
      // Any presence means the canvas is (or was just) open through SOME path
      // (Alt+`, guide card, restore) — that is the user's intent to keep it.
      if (!readPinned()) writePinned(true)
      return
    }
    if (!seen) {
      // Startup (page refresh) with the pin set: bring the canvas back.
      if (!restoring && readPinned()) restore()
      return
    }
    seen = false
    if (!readPinned()) return
    if (Date.now() - lastRightbarGesture < USER_GESTURE_MS) {
      // A gesture in the right column immediately preceded the disappearance:
      // the user closed the tab themselves (×) — respect it and unpin.
      writePinned(false)
      return
    }
    // No gesture: the engine removed the tab (new session / session switch) —
    // put the canvas back. This is the "auto Alt+` open half".
    restore()
  }

  const timer = setInterval(tick, POLL_MS)

  return () => {
    clearInterval(timer)
    window.removeEventListener('pointerdown', onPointerDown, true)
  }
}
