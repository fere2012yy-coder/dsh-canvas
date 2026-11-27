#!/usr/bin/env node
/**
 * Live regression for the directional marquee (needs debug host + NEW bundle
 * with the ??-fallback patch):
 *   LTR marquee → only fully-contained elements selected (stock verdict)
 *   RTL marquee → touch is enough
 * Two probe nodes are created, dragged over with real mouse input, checked
 * via getAppState().selectedElementIds, then removed.
 */
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().includes('dsh-app'))
await page.bringToFront()

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await page.evaluate(() => window.__dshCanvasTest?.open?.('canvas'))
await sleep(1200)
const canvasId = await page.evaluate(() => window.__dshCanvasTest?.canvasStore?.currentCanvasId?.())
const post = (body) =>
  page.evaluate(async (b) => {
    const res = await fetch('/dsh-canvas/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }, body)

// compute the VISIBLE scene region first, place probes inside it — below the
// top toolbar (~60px) and clear of existing content
const base = await page.evaluate(() => {
  const st = window.__dshCanvasTest?.excalidraw?.getAppState?.()
  const el = document.querySelector('canvas.interactive') ?? document.querySelector('.excalidraw')
  const rect = el.getBoundingClientRect()
  return {
    x: -st.scrollX + 120,
    y: -st.scrollY + 250,
    scrollX: st.scrollX,
    scrollY: st.scrollY,
    zoom: st.zoom.value,
    left: rect.left,
    top: rect.top,
  }
})
const M2dx = 400, M2dy = 150
const r = await post({ canvasId, ops: [
  { op: 'addNode', x: base.x, y: base.y, label: 'M1' },
  { op: 'addNode', x: base.x + M2dx, y: base.y + M2dy, label: 'M2' },
] })
if (r.status !== 200 || r.body?.ok !== true) {
  console.log('FATAL command route not live — restart the host with the rebuilt lib')
  process.exit(1)
}
const [n1, n2] = r.body.created
await sleep(1500)

// scene→client mapping via the interactive canvas element's own rect
const at = (sx, sy) => {
  const c = base
  return { x: c.left + (sx + c.scrollX) * c.zoom, y: c.top + (sy + c.scrollY) * c.zoom }
}
const selection = () =>
  page.evaluate(() => {
    const api = window.__dshCanvasTest?.excalidraw
    const st = api.getAppState()
    return {
      ids: Object.keys(st.selectedElementIds ?? {}),
      tool: st.activeTool?.type,
      scroll: [st.scrollX, st.scrollY],
    }
  })
// force the selection tool before marqueeing
await page.evaluate(() => window.__dshCanvasTest?.excalidraw?.updateScene?.({ appState: { activeTool: { type: 'selection', customType: null } } }))
await sleep(200)
const marquee = async (x1, y1, x2, y2) => {
  await page.mouse.move(x1, y1)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8)
    await sleep(30)
  }
  const mid = await page.evaluate(() => {
    const st = window.__dshCanvasTest?.excalidraw?.getAppState?.()
    const s = st.selectionElement
    return {
      selEl: s ? { x: s.x, y: s.y, w: s.width, h: s.height } : null,
      dragging: st.draggingElement?.type ?? null,
      selected: Object.keys(st.selectedElementIds ?? {}),
      editing: st.editingTextElement != null,
    }
  })
  await page.mouse.up()
  await sleep(300)
  return mid
}

// probe nodes are 160x84: M1 = (bx..bx+160, by..by+84), M2 = (bx+400..bx+560, by+150..by+234)

// LTR fully around M1 only → M1 selected, M2 not (pointer down on EMPTY area,
// below the toolbar)
const p1a = at(base.x - 15, base.y - 15), p1b = at(base.x + 180, base.y + 110)
const mid1 = await marquee(p1a.x, p1a.y, p1b.x, p1b.y)
console.log('engine state mid-LTR-drag:', JSON.stringify(mid1))
let sel = await selection()
check('LTR contains M1', sel.ids.includes(n1.id), JSON.stringify(sel))
check('LTR excludes M2', !sel.ids.includes(n2.id), JSON.stringify(sel))

// LTR rect that merely intersects M2 (not contains) → M2 NOT selected
const p2a = at(base.x + M2dx - 30, base.y + M2dy - 30), p2b = at(base.x + M2dx + 45, base.y + M2dy + 40)
await marquee(p2a.x, p2a.y, p2b.x, p2b.y)
sel = await selection()
check('LTR touch-only does NOT select M2', !sel.ids.includes(n2.id), JSON.stringify(sel))

// RTL intersecting M2 → M2 selected (touch); starts on empty area below M2
const a = at(base.x + M2dx + 262, base.y + M2dy + 99)
const b = at(base.x + M2dx + 42, base.y + M2dy + 19)
await marquee(a.x, a.y, b.x, b.y)
sel = await selection()
check('RTL touch selects M2', sel.ids.includes(n2.id), JSON.stringify(sel))
check('RTL does not select M1', !sel.ids.includes(n1.id), JSON.stringify(sel))

// cleanup
await post({ canvasId, ops: [{ op: 'delete', ids: [n1.id, n2.id] }] })
await sleep(800)

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
