/**
 * shell-column-swap — framework-free utility that trades the DSH shell's
 * center (conversation) column and right sidebar column while a host-provided
 * surface is mounted. Extracted from dsh-canvas's workspace-swap so any right
 * sidebar plugin can reuse it:
 *
 *   import { installShellColumnSwap } from './shell-column-swap.js'
 *   const dispose = installShellColumnSwap({ attribute: 'data-myplugin-swap' })
 *   // call dispose() when your surface unmounts
 *
 * Engine facts (verified on desktop 0.2.0 / 0.2.1-rc.1):
 * - AppFrame is a 3-track grid with inline JS-computed
 *   `grid-template-columns`; css-module class hashes change every engine
 *   release (0.1.7 `pI_x6G_`, 0.2.0/0.2.1 `BynINW_`), so the frame is located
 *   via the stable `[data-rightbar-col]` attribute and the hash prefix is
 *   derived from the live className. Anything that fails to match degrades to
 *   a no-op.
 * - Since 0.2.1 the frame has a SECOND grid row holding `[data-shell-bottom]`
 *   (`grid-template-rows: minmax(0,1fr) auto`). CSS `order` re-sequences
 *   AUTO-PLACEMENT, so an order-based swap pushes the two swapped half-columns
 *   past that row into an implicit third row (measured: rows `0px 0px 992px`,
 *   sidebar height 0, panel at x=-584). The swap therefore uses explicit
 *   `grid-area` placement: the three columns are pinned to row 1 / tracks
 *   1-2-3 and the bottom row to row 2 / all tracks. On 0.2.0 (single row) the
 *   row-2 rule simply matches nothing.
 * - The panel itself is `position:absolute; right:0` inside the rightbar
 *   column, so it still lands correctly while swapped (the column's right
 *   edge IS the divider). Fullscreen widens it to 100vw, which must escape
 *   the column box — only then is `position:fixed` required.
 * - Configurable shortcuts aside, nothing here touches engine JS: the shell
 *   keeps owning every number (see `sync` below). Column widths are the
 *   engine's own — transient by design, restored to stock defaults on
 *   restart. The swap moves the flexible track WITH the canvas: after the
 *   swap the canvas column is `minmax(400px,1fr)` (adaptive, fills the
 *   viewport) and the conversation column carries the engine's rightbar
 *   track verbatim, so no size is "inherited" across columns. (A localStorage-based width persistence was tried here and
 *   removed: pinning the column while the panel followed the engine's
 *   preference left a phantom gap that read as a second sidebar.)
 */

/**
 * Locate the shell's AppFrame grid and derive its css-module hash prefix.
 * Returns null when the running engine doesn't match the known shape.
 */
export function locateFrame() {
  const rightbarCol = document.querySelector('[data-rightbar-col]')
  const frame = rightbarCol?.parentElement
  if (!frame) return null
  const prefix = /([\w-]+)_frame\b/.exec(frame.className)?.[1]
  if (!prefix || getComputedStyle(frame).display !== 'grid') return null
  return { frame, prefix }
}

/**
 * Split a grid-template-columns declaration into top-level segments
 * ("280px minmax(400px, 1fr) minmax(0px, 648px)" → 3 parts), honoring parens.
 */
export function splitTracks(value) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ' ' && depth === 0) {
      if (cur !== '') parts.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur !== '') parts.push(cur)
  return parts
}

/** Last "Npx" in a track segment: "minmax(0px, 648px)" → 648. */
export function trackPx(segment) {
  return Number(/(\d+(?:\.\d+)?)px\s*\)?\s*$/.exec(segment)?.[1] ?? 0)
}

/**
 * Build the swap stylesheet from the engine's live class prefix. Everything
 * NOT class-bound uses stable data attributes (`[data-rightbar-col]`,
 * `[data-sidebar-right-panel]`, dockkit hosts), which have survived engine
 * upgrades so far. Names of the root attribute and CSS variables come from
 * the same options object that `installShellColumnSwap` receives.
 */
export function swapCss(prefix, { attribute = 'data-shell-swap', varPrefix = 'shell-swap' } = {}) {
  const cols = `--${varPrefix}-cols`
  const handle = `--${varPrefix}-handle`
  return `
[${attribute}] .${prefix}_frame {
  grid-template-columns: var(${cols}) !important;
}
/* Explicit placement, NOT \`order\` (0.2.1: order would push these behind the
   new [data-shell-bottom] row into an implicit row — see the module header). */
[${attribute}] .${prefix}_frame > .${prefix}_sidebarCol {
  grid-area: 1 / 1 / 2 / 2;
}
[${attribute}] .${prefix}_frame > [data-rightbar-col] {
  grid-area: 1 / 2 / 2 / 3;
}
[${attribute}] .${prefix}_frame > .${prefix}_centerCol {
  grid-area: 1 / 3 / 2 / 4;
}
/* 0.2.1's new second row spans all three tracks; pin it so auto-placement can
   never hand it (or the columns) a different row. No-op on 0.2.0. */
[${attribute}] .${prefix}_frame > [data-shell-bottom] {
  grid-area: 2 / 1 / 3 / -1;
}
[${attribute}] .${prefix}_frame .${prefix}_handle[data-side='rightbar'] {
  left: var(${handle}) !important;
}
/* The rightbar panel sizes itself from the engine's rightbar PREFERENCE (an
   inline width), while this module sizes the COLUMN (CSS variable). Whenever
   the two disagree the panel leaves an empty strip on the column's left that
   reads as part of the nav sidebar — dragging the divider then looks like
   "the left boundary moves while the canvas stays the same". The panel must
   always fill its column — except in fullscreen, where the engine's own
   width must stand (it spans the content area, excluding the nav sidebar). */
[${attribute}] [data-sidebar-right-panel]:not([data-sidebar-right-panel='fullscreen']) {
  width: 100% !important;
  min-width: 0 !important;
  max-width: none !important;
}
[${attribute}] .${prefix}_frame .${prefix}_centerCol {
  border-left: .5px solid var(--dsw-alias-border-l3);
}
[${attribute}] [data-sidebar-right-panel] [data-dockkit-host='dock'],
[${attribute}] [data-sidebar-right-panel] [data-dockkit-empty],
[${attribute}] [data-sidebar-right-panel] [data-dockkit-divider] {
  transition: none;
}
/* The engine's own panel positioning is \`position:absolute; right:0\` in the
   rightbar column. That still lands correctly while swapped (the column's
   right edge IS the divider), but fullscreen widens the panel to 100vw, which
   must escape the column box — only then is \`fixed\` required. */
[${attribute}] [data-sidebar-right-panel='fullscreen'] {
  position: fixed;
  top: var(--dsh-windows-titlebar-height, 0px);
  bottom: 0;
  right: 0;
}
[${attribute}][data-windows-titlebar] .${prefix}_centerCol {
  border-radius: 0 var(--dsh-windows-content-radius) 0 0;
}
`
}

/**
 * Install the swap for one mounted surface. Idempotent per call site: each
 * call owns its own style tag, observers and listeners; call the returned
 * disposer exactly once when the surface unmounts (every exit path — tab
 * close, shortcut, tab switch — should dispose so the stock layout returns).
 *
 * @param options
 *   attribute  — root <html> attribute toggling the swap (default 'data-shell-swap')
 *   varPrefix  — prefix of the two CSS variables (default 'shell-swap' →
 *                `--shell-swap-cols` / `--shell-swap-handle`)
 *   tagId      — `data-plugin` value of the injected <style> tag (default 'shell-column-swap')
 *   logPrefix  — console.warn prefix (default 'shell-column-swap')
 * @returns a disposer.
 */
export function installShellColumnSwap({
  attribute = 'data-shell-swap',
  varPrefix = 'shell-swap',
  tagId = 'shell-column-swap',
  logPrefix = 'shell-column-swap',
} = {}) {
  const root = document.documentElement
  const located = locateFrame()
  if (located === null) {
    console.warn(`${logPrefix}: AppFrame not recognized; column swap disabled`)
    return () => {}
  }
  const { frame, prefix } = located
  const tag = document.createElement('style')
  tag.dataset.plugin = tagId
  tag.textContent = swapCss(prefix, { attribute, varPrefix })
  document.head.appendChild(tag)
  const colsVar = `--${varPrefix}-cols`
  const handleVar = `--${varPrefix}-handle`

  let active = false
  let verified = false
  // Sticky: once the guard trips, stay in the stock layout for this mount —
  // re-activating would just fail the same check on every resize tick.
  let disabled = false

  /**
   * Write the two CSS variables from parsed tracks — segments 2/3 swapped
   * WITH their full track specs, so the flexible track follows the canvas:
   * the canvas column (middle after the swap) becomes `minmax(400px, 1fr)`
   * and adapts to the viewport, while the conversation column keeps the
   * engine's rightbar segment (its own min/max protections carry over
   * verbatim). Sizes are still 100% engine-owned — only their assignment to
   * columns is swapped.
   */
  const applyVars = (tracks) => {
    const [sidebar, center, rightbar] = tracks
    const width = trackPx(rightbar)
    root.style.setProperty(colsVar, `${sidebar} ${center} ${rightbar}`)
    // The divider sits between canvas (flexible) and chat (fixed-ish). With
    // the flexible track in the middle its width is only known at layout
    // time: chat = min(rightbar max, leftover after canvas minimum), so the
    // handle anchors to the frame's right minus the chat width.
    const minCanvas = Number(/minmax\((\d+(?:\.\d+)?)px/.exec(center)?.[1] ?? 0)
    const W = frame.clientWidth
    const sidebarPx = parseFloat(sidebar) || 0
    const chat = Math.max(0, Math.min(width, W - sidebarPx - minCanvas))
    root.style.setProperty(handleVar, `${W - chat}px`)
  }

  // Safety net: the frame has exactly two rows (content + bottom). If a future
  // engine (or an unrelated plugin) adds row structure, the explicit placement
  // above would leave the columns smeared across implicit rows — degrade to
  // the stock, usable layout instead of a broken one ("fail to a no-op").
  const verifySwap = () => {
    if (!active || verified) return
    const rows = splitTracks(getComputedStyle(frame).gridTemplateRows)
    if (rows.length <= 2) {
      verified = true
      return
    }
    console.warn(`${logPrefix}: swapped frame grew rows; column swap disabled`, rows)
    disabled = true
    active = false
    root.removeAttribute(attribute)
    window.dispatchEvent(new Event('resize'))
  }

  /**
   * Mirror the frame's inline `grid-template-columns` into the swap variables
   * — segments 2 and 3 swapped textually, so the shell's own min/max
   * protections carry over verbatim. The DECLARATION is mirrored, not the
   * computed grid: React always rewrites it in stock order, while the computed
   * value under our own `!important` override would read back our mirror and
   * freeze it. A zero-width right track (column collapsed / overlay mode)
   * would anchor the panel over the nav sidebar, so the swap steps aside until
   * the track returns.
   */
  const sync = () => {
    if (disabled) return
    const tracks = splitTracks(frame.style.gridTemplateColumns)
    if (tracks.length !== 3) return
    const shellRight = trackPx(tracks[2])
    const shouldSwap = shellRight > 0
    if (shouldSwap !== active) {
      active = shouldSwap
      verified = false
      if (active) {
        root.setAttribute(attribute, '1')
        // Placement applies synchronously, but read it back a frame later so
        // the check never races the style tag insertion.
        requestAnimationFrame(verifySwap)
      } else {
        root.removeAttribute(attribute)
      }
      // The swap MOVES columns without resizing them, so nothing fires a resize
      // — canvas-style surfaces keep their stale cached offsetLeft/offsetTop and
      // the cursor no longer matches where strokes land. A resize event forces a
      // re-read of getBoundingClientRect (heals drift to exactly 0).
      window.dispatchEvent(new Event('resize'))
      // Grid changes may animate; re-fire once the transition settles.
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    }

    applyVars(tracks)
  }
  sync()
  const observer = new ResizeObserver(sync)
  observer.observe(frame)
  const styleWatcher = new MutationObserver(sync)
  styleWatcher.observe(frame, { attributes: true, attributeFilter: ['style'] })

  // Divider drags need NO interception: the canvas column is the COMPLEMENT
  // of the engine's rightbar preference (W − sidebar − chat), so the shell's
  // stock drag direction already feels natural — drag left widens the chat
  // column, which narrows the canvas exactly like a right-anchored divider.
  const onSettle = (event) => {
    if (event.target === frame && event.propertyName === 'grid-template-columns') {
      sync()
      // sync() no-ops once the swap state matches, so fire the offset-healing
      // resize here unconditionally: a surface may have initialized from a
      // mid-transition layout and cached a stale offsetLeft/offsetTop.
      window.dispatchEvent(new Event('resize'))
    }
  }
  frame.addEventListener('transitionend', onSettle)
  return () => {
    observer.disconnect()
    styleWatcher.disconnect()
    frame.removeEventListener('transitionend', onSettle)
    tag.remove()
    root.removeAttribute(attribute)
    root.style.removeProperty(colsVar)
    root.style.removeProperty(handleVar)
    window.dispatchEvent(new Event('resize'))
  }
}
