/**
 * Right-drag arrow — drag with the RIGHT mouse button to draw an arrow
 * (tail at press, head at release), no keyboard shortcut needed.
 *
 * Interaction contract (all three right-button behaviors coexist):
 *   right drag (≥ threshold) → draw an arrow
 *   right click (no drag)    → the stock context menu
 *   Ctrl/⌘/Alt/Shift + right → stock behavior (session-bind menu etc.)
 *
 * Mechanism: the REAL right-button press is captured and withheld from the
 * engine; once the drag passes the threshold we switch to the arrow tool via
 * the public `setActiveTool`, then REPLAY the gesture to the engine as a
 * plain left-button draw (synthetic pointerdown → moves → pointerup) on the
 * interactive canvas. The synthetic events reuse the REAL right pointerId —
 * we call setPointerCapture on that id ourselves first, so the engine's own
 * capture call inside its pointerdown handler is an idempotent no-op instead
 * of the NotFoundError a fake pointerId would throw (known pitfall).
 * Synthetic events carry a marker so the replay never re-triggers itself.
 */

const MARK = '__dshRightDragArrow'

export function installRightDragArrow({ getApi, threshold = 4 } = {}) {
  let state = null // { pointerId, startX, startY, pending, drawing, lastX, lastY, prevTool, api }
  let suppressMenu = false

  const canvasEl = () => document.querySelector('canvas.interactive')

  const synth = (type, e) =>
    new PointerEvent(type, {
      pointerId: state.pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: e.clientX,
      clientY: e.clientY,
      bubbles: true,
      cancelable: true,
      composed: true,
    })

  const replay = (type, e) => {
    const canvas = canvasEl()
    if (!canvas) return
    const ev = synth(type, e)
    ev[MARK] = true
    canvas.dispatchEvent(ev)
  }

  const onPointerDown = (e) => {
    if (e.__dshRightDragArrow) return
    if (e.button !== 2 || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    const api = getApi?.()
    if (!api) return
    const st = api.getAppState?.()
    if (!st || st.editingTextElement || st.viewModeEnabled) return
    // a leftover stock context menu floats over the canvas and swallows every
    // pointer event (the engine can't close it itself because we withhold the
    // right press). Close it and let the engine process this click normally.
    if (st.contextMenu) {
      try {
        api.updateScene({ appState: { contextMenu: null } })
      } catch {
        /* ignore */
      }
      return
    }
    const target = e.target instanceof Element ? e.target.closest('canvas.interactive') : null
    if (!target) return
    // capture the REAL right pointer on the canvas BEFORE withholding the
    // event — the engine's later capture call then becomes a no-op
    try {
      target.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone — abort silently */
      return
    }
    state = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      beganAt: Date.now(),
      drawing: false,
      prevTool: st.activeTool?.type ?? 'selection',
      api,
    }
    // withhold the right press: the engine must not start its context-menu
    // bookkeeping; a right CLICK (no drag) falls through to the native menu
    e.stopImmediatePropagation()
  }

  const onPointerMove = (e) => {
    if (!state) return
    if (e.__dshRightDragArrow) return // our own replay — let the engine have it
    if (!state.drawing) {
      const dx = e.clientX - state.startX
      const dy = e.clientY - state.startY
      if (dx * dx + dy * dy < threshold * threshold) return
      // threshold crossed → become an arrow draw. setActiveTool is ASYNC
      // (React state), so mark pending and wait for the tool to actually
      // land before replaying the left-button gesture.
      state.pending = true
      state.lastX = e.clientX
      state.lastY = e.clientY
      try {
        state.api.setActiveTool?.({ type: 'arrow' })
      } catch (error) {
        console.warn('right-drag-arrow: setActiveTool failed', error)
        state = null
        return
      }
      startWhenToolReady()
      e.stopImmediatePropagation()
      return
    }
    replay('pointermove', e)
    e.stopImmediatePropagation()
  }

  /** Wait until the arrow tool is live (≤600ms) then replay the gesture. */
  const startWhenToolReady = async () => {
    const deadline = performance.now() + 1500
    while (state?.pending) {
      if (state.api.getAppState?.().activeTool?.type === 'arrow') break
      if (performance.now() > deadline) {
        state = null // tool never landed — abort the gesture silently
        return
      }
      await new Promise((r) => setTimeout(r, 16))
    }
    if (!state?.pending) return
    state.pending = false
    state.drawing = true
    // snapshot BEFORE the drawing replay: the arrow element is created on the
    // replayed pointerdown, so a snapshot taken at release would already
    // contain it and the id-diff in wireBindings would find NOTHING
    state.beforeArrowIds = new Set(
      state.api.getSceneElementsIncludingDeleted().filter((x) => x.type === 'arrow').map((x) => x.id),
    )
    replay('pointerdown', { clientX: state.lastX, clientY: state.lastY })
    replay('pointermove', { clientX: state.lastX, clientY: state.lastY })
  }

  const finish = (e, cancel) => {
    if (!state) return
    if (state.pending) {
      // a drag happened but the tool switch never landed in time. Do NOT
      // replay a right click here: that opens the stock context menu, which
      // then floats over the canvas and EATS every following pointer event
      // (observed live — it made the feature look completely dead). Just
      // swallow the menu and restore the tool.
      suppressMenu = true
      setTimeout(() => {
        suppressMenu = false
      }, 100)
      try {
        state.api.setActiveTool?.({ type: state.prevTool })
      } catch {
        /* ignore */
      }
      state = null
      return
    }
    if (state.drawing) {
      if (!cancel) {
        const api = state.api
        // the arrow was born on the replayed pointerdown — its id was already
        // snapshotted there (startWhenToolReady); use THAT snapshot
        const beforeArrowIds = state.beforeArrowIds ?? new Set()
        replay('pointerup', e)
        const { endBlank, blankPoint } = wireBindings(state, e, beforeArrowIds)
        // Release on blank canvas → grow the next node: restore the SELECTION
        // tool (the engine's blank-dblclick handler requires it), clear the
        // auto-selected fresh arrow, then dispatch a double-click at a BLANK
        // point just past the arrow head (the release point itself would hit
        // the fresh arrow). The engine creates a text element there.
        if (endBlank && blankPoint) {
          const api = state.api
          // snapshot: any text born from the dblclick that ends up EMPTY gets
          // swept (editing may never engage on synthetic dblclicks)
          const beforeTexts = new Set(
            api.getSceneElementsIncludingDeleted().filter((x) => x.type === 'text' && !x.isDeleted).map((x) => x.id),
          )
          try {
            api.setActiveTool?.({ type: 'selection' })
            api.updateScene({ appState: { selectedElementIds: {} } })
          } catch {
            /* ignore */
          }
          waitTool(api, 'selection', 400).then(async (ok) => {
            if (!ok) return
            const rect = canvasEl()?.getBoundingClientRect()
            if (!rect) return
            const appSt = api.getAppState()
            const z = appSt.zoom.value
            const cx = rect.left + (blankPoint.x + appSt.scrollX) * z
            const cy = rect.top + (blankPoint.y + appSt.scrollY) * z
            const canvas = canvasEl()
            // a synthetic empty CLICK first: updateScene-clear alone doesn't
            // stick (the engine re-selects the fresh arrow), a click on blank
            // truly clears it; verified live
            const clickEv = (type) => {
              const ev = new PointerEvent(type, {
                pointerId: 7,
                pointerType: 'mouse',
                isPrimary: true,
                button: 0,
                buttons: type === 'pointerdown' ? 1 : 0,
                clientX: cx,
                clientY: cy,
                bubbles: true,
                cancelable: true,
                composed: true,
              })
              ev[MARK] = true
              canvas.dispatchEvent(ev)
            }
            clickEv('pointerdown')
            clickEv('pointerup')
            await new Promise((r) => setTimeout(r, 400))
            // sweep an EMPTY leftover text (dblclick created it but editing
            // never engaged) — only while editing is NOT active, or we would
            // delete the text the user is about to type into
            try {
              if (!api.getAppState?.().editingTextElement) {
                const empty = api
                  .getSceneElementsIncludingDeleted()
                  .find((x) => x.type === 'text' && !x.isDeleted && !beforeTexts.has(x.id) && !(x.text ?? '').trim())
                if (empty) {
                  api.updateScene({
                    elements: api.getSceneElementsIncludingDeleted().map((x) => (x.id === empty.id ? { ...x, isDeleted: true } : x)),
                  })
                }
              }
            } catch {
              /* ignore */
            }
            const ev = new MouseEvent('dblclick', {
              clientX: cx,
              clientY: cy,
              button: 0,
              bubbles: true,
              cancelable: true,
              composed: true,
            })
            ev[MARK] = true
            canvas.dispatchEvent(ev)
            // When text editing finishes: restore the previous tool AND bind
            // the newborn text to the arrow — element-to-element binding, the
            // arrow's end snaps to the text's outline (15px off), exactly like
            // an arrow drawn onto an existing block natively.
            const prevTool = state?.prevTool ?? 'selection'
            const deadline = Date.now() + 120_000
            let sawEditing = false
            const watch = setInterval(() => {
              const editing = api.getAppState?.().editingTextElement
              if (editing) sawEditing = true
              if (sawEditing && !editing && Date.now() <= deadline) {
                clearInterval(watch)
                // bind the arrow → newborn text (deferred: let the engine
                // finish its editing-end commit first)
                setTimeout(() => {
                  try {
                    const elsNow = api.getSceneElementsIncludingDeleted().filter((x) => !x.isDeleted)
                    const arrow = elsNow
                      .filter((x) => x.type === 'arrow' && !(beforeArrowIds?.has(x.id) ?? false))
                      .at(-1)
                    const born = elsNow.find(
                      (x) => x.type === 'text' && !x.isDeleted && !beforeTexts.has(x.id) && !x.containerId && (x.text ?? '').trim(),
                    )
                    if (arrow && born) {
                      api.updateScene({
                        elements: elsNow.map((el) => {
                          if (el.id === arrow.id) {
                            // bindings only — the engine positions the bound
                            // arrow's endpoint on the text itself
                            return { ...el, endBinding: { elementId: born.id, focus: 0, gap: 5 } }
                          }
                          if (el.id === born.id) {
                            const has = (el.boundElements ?? []).some((b) => b.id === arrow.id)
                            return { ...el, boundElements: has ? el.boundElements : [...(el.boundElements ?? []), { id: arrow.id, type: 'arrow' }] }
                          }
                          return el
                        }),
                      })
                    }
                  } catch (error) {
                    console.warn('right-drag-arrow: bind-newborn failed', error)
                  }
                  try {
                    api.setActiveTool?.({ type: prevTool })
                  } catch {
                    /* keep the text tool on restore failure */
                  }
                }, 150)
              }
            }, 200)
          })
        } else {
          // no text growth — restore the previous tool right away
          try {
            state.api.setActiveTool?.({ type: state.prevTool })
          } catch {
            /* keep the arrow tool on restore failure */
          }
        }
      } else {
        try {
          state.api.setActiveTool?.({ type: state.prevTool })
        } catch {
          /* ignore */
        }
      }
      // the REAL right-up still fires a native contextmenu — swallow it
      suppressMenu = true
      setTimeout(() => {
        suppressMenu = false
      }, 100)
    }
    state = null
  }

  /** Poll until appState.activeTool.type === type (≤ timeoutMs). */
  const waitTool = async (api, type, timeoutMs) => {
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      if (api.getAppState?.().activeTool?.type === type) return true
      await new Promise((r) => setTimeout(r, 16))
    }
    return api.getAppState?.().activeTool?.type === type
  }

  /**
   * The engine's binding on synthetic gestures is unreliable — wire the new
   * arrow's start/end bindings DETERMINISTICALLY: hit-test the press/release
   * points against the scene ourselves (smallest containing element wins) and
   * patch the arrow via updateScene (same wiring as command-executor's
   * connect). Geometry stays engine-drawn.
   */
  const wireBindings = (st, upEvent, beforeArrowIds) => {
    try {
      const api = st.api
      const els = api.getSceneElementsIncludingDeleted().filter((x) => !x.isDeleted)
      const rect = canvasEl()?.getBoundingClientRect()
      if (!rect) return
      const appSt = api.getAppState()
      const z = appSt.zoom.value
      const toScene = (cx, cy) => ({
        x: (cx - rect.left) / z - appSt.scrollX,
        y: (cy - rect.top) / z - appSt.scrollY,
      })
      const p1 = toScene(st.startX, st.startY)
      const p2 = toScene(upEvent.clientX, upEvent.clientY)
      // STOCK binding hit: the release/press point falls inside an element's
      // bounds (smallest element wins). No ring zones, no endpoint-snapping
      // geometry — once bound, the engine positions the arrow itself.
      const hit = (p) => {
        // binding zone = bbox interior ∪ outline ring, threshold mirrors the
        // engine's maxBindingGap: max(16, min(0.25 × short side [, ÷√2 for
        // diamonds], 32), 10/zoom + 4) scene px
        const maxBindingGap = (el) => {
          const zoomValue = z < 1 ? z : 1
          const shapeRatio = el.type === 'diamond' ? 1 / Math.sqrt(2) : 1
          const smaller = shapeRatio * Math.min(el.width ?? 0, el.height ?? 0)
          return Math.max(16, Math.min(0.25 * smaller, 32), 10 / zoomValue + 4)
        }
        // distance from p to the element's shape boundary (outside the bbox:
        // distance to the bbox; deep interior always counts as IN the zone)
        const inZone = (el) => {
          const w = el.width ?? 0
          const h = el.height ?? 0
          const gap = maxBindingGap(el)
          if (w <= 0 || h <= 0) return false
          const outsideX = p.x < el.x ? el.x - p.x : Math.max(0, p.x - (el.x + w))
          const outsideY = p.y < el.y ? el.y - p.y : Math.max(0, p.y - (el.y + h))
          // strictly inside → in zone; outside → within the ring margin
          const wasInside = p.x >= el.x && p.x <= el.x + w && p.y >= el.y && p.y <= el.y + h
          return wasInside || Math.hypot(outsideX, outsideY) <= gap
        }
        let best = null
        let bestArea = Infinity
        for (const el of els) {
          if (el.type === 'arrow' || el.type === 'selection') continue
          // a bound LABEL is hit as its container (snap to the block, not the
          // text floating inside it)
          if (el.type === 'text' && el.containerId) continue
          const w = el.width ?? 0
          const h = el.height ?? 0
          if (w <= 0 || h <= 0) continue
          if (inZone(el)) {
            const area = w * h
            if (area < bestArea) {
              best = el
              bestArea = area
            }
          }
        }
        return best
      }
      const from = hit(p1)
      const to = hit(p2)
      if (from || to) {
        // The new arrow may not be in the scene yet at pointerup time (the
        // engine commits via a BATCHED async update). Snapshot the existing
        // arrow ids BEFORE the replay, then find the newborn arrow by id-diff
        // after a short delay and patch it there. Only the BINDINGS are
        // written — the engine positions the bound arrow itself.
        const applyPatch = (attempt = 0) => {
          try {
            const elsNow = api.getSceneElementsIncludingDeleted().filter((x) => !x.isDeleted)
            // find THIS gesture's arrow: not in the pre-draw snapshot, or (as a
            // fallback) an arrow born since the gesture began
            const arrowNow = elsNow
              .filter((x) => x.type === 'arrow' && !(beforeArrowIds?.has(x.id) ?? false))
              .at(-1)
              ?? elsNow
                .filter((x) => x.type === 'arrow' && (x.updated ?? 0) >= (st.beganAt ?? 0) - 500)
                .at(-1)
            if (!arrowNow) {
              if (attempt < 2) setTimeout(() => applyPatch(attempt + 1), 250)
              return
            }
            api.updateScene({
              elements: elsNow.map((el) => {
                if (el.id === arrowNow.id) {
                  return {
                    ...el,
                    ...(from ? { startBinding: { elementId: from.id, focus: 0, gap: 5 } } : {}),
                    ...(to ? { endBinding: { elementId: to.id, focus: 0, gap: 5 } } : {}),
                  }
                }
                if ((from && el.id === from.id) || (to && el.id === to.id)) {
                  const has = (el.boundElements ?? []).some((b) => b.id === arrowNow.id)
                  return { ...el, boundElements: has ? el.boundElements : [...(el.boundElements ?? []), { id: arrowNow.id, type: 'arrow' }] }
                }
                return el
              }),
            })
          } catch (error) {
            console.warn('right-drag-arrow: applyPatch failed', error)
          }
        }
        setTimeout(applyPatch, 150)
      }
      // Release on blank → find a BLANK point just past the arrow head (the
      // release point itself is the arrow's own endpoint, so a dblclick there
      // would hit the fresh arrow instead of the blank-text path).
      if (to) return { endBlank: false, blankPoint: null }
      const dirX = p2.x - p1.x
      const dirY = p2.y - p1.y
      const len = Math.hypot(dirX, dirY) || 1
      const ux = dirX / len
      const uy = dirY / len
      const D = 15 / z // 15 screen px past the arrow head (user preference)
      const perpX = -uy
      const perpY = ux
      const candidates = [
        { x: p2.x + ux * D, y: p2.y + uy * D },
        { x: p2.x + perpX * D, y: p2.y + perpY * D },
        { x: p2.x - perpX * D, y: p2.y - perpY * D },
        { x: p2.x + (ux + perpX) * D, y: p2.y + (uy + perpY) * D },
        p2,
      ]
      const blankPoint = candidates.find((c) => !hit(c)) ?? null
      return { endBlank: !!blankPoint, blankPoint }
    } catch (error) {
      console.warn('right-drag-arrow: wireBindings failed', error)
      return { endBlank: false, blankPoint: null }
    }
  }

  const onPointerUp = (e) => {
    if (e.__dshRightDragArrow) return
    if (!state) return
    const drawing = state.drawing
    finish(e, false)
    if (drawing) e.stopImmediatePropagation()
  }

  const onPointerCancel = (e) => {
    if (e.__dshRightDragArrow) return
    finish(e, true)
  }

  const onContextMenu = (e) => {
    if (suppressMenu) {
      e.preventDefault()
      e.stopImmediatePropagation()
    }
  }

  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointermove', onPointerMove, true)
  window.addEventListener('pointerup', onPointerUp, true)
  window.addEventListener('pointercancel', onPointerCancel, true)
  window.addEventListener('contextmenu', onContextMenu, true)

  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('contextmenu', onContextMenu, true)
  }
}
