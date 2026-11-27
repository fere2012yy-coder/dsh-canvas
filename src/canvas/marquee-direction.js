/**
 * Directional marquee selection — like Figma/Illustrator:
 *
 *   left-to-right drag  → fully contained (Excalidraw's stock verdict)
 *   right-to-left drag  → touch is enough (bbox intersect)
 *
 * Pairs with the build-time hook (scripts/build-client.mjs): the bundled
 * `getElementsWithinSelection` consults `window.__dshCanvasMarquee(element,
 * [x1, y1, x2, y2])` in scene coordinates. Returning `undefined` defers to
 * the engine's containment test, so left-to-right (and every non-marquee
 * code path) is 100% stock. The hook degrades to stock behavior if this
 * module is not installed.
 *
 * Direction is tracked in CLIENT coordinates (invariant under zoom/scroll):
 * the horizontal cursor position relative to the drag start decides the mode
 * live, so wiggling back across the start flips the mode mid-drag — same as
 * Figma. The approximated element bounds ignore stroke padding; the engine's
 * own guards (locked / selection / bound-to-container / frame exclusion)
 * are OUTSIDE the hooked comparison and always apply.
 */

let drag = null // { startX } while a left-button drag is down
let curX = 0

/** Rotated AABB of an element in scene coordinates. */
export function elementAabb(el) {
  const w = el.width ?? 0
  const h = el.height ?? 0
  const angle = el.angle ?? 0
  if (!angle) return [el.x, el.y, el.x + w, el.y + h]
  const cx = el.x + w / 2
  const cy = el.y + h / 2
  const cos = Math.abs(Math.cos(angle))
  const sin = Math.abs(Math.sin(angle))
  const hw = (w * cos + h * sin) / 2
  const hh = (w * sin + h * cos) / 2
  return [cx - hw, cy - hh, cx + hw, cy + hh]
}

const overlaps = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]

/**
 * Pure verdict — `view` is { armed, startX, curX }; returns true (select),
 * false (reject), or undefined (defer to the stock containment test).
 */
export function marqueeVerdict(view, element, rect) {
  if (!view?.armed || view.curX >= view.startX) return undefined
  return overlaps(elementAabb(element), rect)
}

/** Install the window hook + pointer tracking; returns a disposer. */
export function installMarqueeDirection() {
  const onPointerDown = (e) => {
    if (e.button !== 0) {
      drag = null
      return
    }
    drag = { startX: e.clientX }
    curX = e.clientX
  }
  const onPointerMove = (e) => {
    if (drag) curX = e.clientX
  }
  const onPointerEnd = () => {
    drag = null
  }
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerEnd, true)
  window.addEventListener('pointercancel', onPointerEnd, true)
  window.__dshCanvasMarquee = (element, rect) =>
    marqueeVerdict({ armed: !!drag, startX: drag?.startX, curX }, element, rect)
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerEnd, true)
    window.removeEventListener('pointercancel', onPointerEnd, true)
    delete window.__dshCanvasMarquee
  }
}
