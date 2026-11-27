#!/usr/bin/env node
/**
 * Live e2e for right-drag arrow (needs debug host + NEW bundle):
 *   right-drag between two probe nodes → a bound arrow is created
 *   right click (no drag) → the stock context menu opens
 *   Ctrl+right click → session-bind menu (existing feature) stays intact
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
const state = (id) =>
  page.evaluate(async (id) => (await fetch(`/dsh-canvas/state?canvasId=${encodeURIComponent(id)}`)).json(), canvasId)

// two probe nodes inside the visible viewport (below the toolbar)
const base = await page.evaluate(() => {
  const st = window.__dshCanvasTest?.excalidraw?.getAppState?.()
  return { x: -st.scrollX + 140, y: -st.scrollY + 260, zoom: st.zoom.value }
})
const r = await post({ canvasId, ops: [
  { op: 'addNode', x: base.x, y: base.y, label: 'R1' },
  { op: 'addNode', x: base.x + 400, y: base.y + 150, label: 'R2' },
] })
if (r.status !== 200 || r.body?.ok !== true) { console.log('FATAL route not live'); process.exit(1) }
const [n1, n2] = r.body.created
await sleep(1500)

const clientAt = (sx, sy) =>
  page.evaluate(({ sx, sy }) => {
    const st = window.__dshCanvasTest?.excalidraw?.getAppState?.()
    const rect = document.querySelector('canvas.interactive').getBoundingClientRect()
    return { x: rect.left + (sx + st.scrollX) * st.zoom.value, y: rect.top + (sy + st.scrollY) * st.zoom.value }
  }, { sx, sy })

// 1. right-drag from R1 center to R2 center → bound arrow
const c1 = await clientAt(base.x + 80, base.y + 42)
const c2 = await clientAt(base.x + 480, base.y + 192)
await page.mouse.move(c1.x, c1.y)
await page.mouse.down({ button: 'right' })
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(c1.x + ((c2.x - c1.x) * i) / 10, c1.y + ((c2.y - c1.y) * i) / 10)
  await sleep(30)
}
await page.mouse.up({ button: 'right' })
await sleep(1500)
{
  const s = await state(canvasId)
  const arrow = (s.arrows ?? []).find((a) => a.from === n1.id && a.to === n2.id)
  check('right-drag creates bound arrow', !!arrow, JSON.stringify(s.arrows?.slice(-3)))
  const tool = await page.evaluate(() => window.__dshCanvasTest?.excalidraw?.getAppState?.().activeTool?.type)
  check('tool restored after draw', tool === 'selection', String(tool))
}

// 2. right click (no drag) → stock context menu opens
await page.mouse.click(c2.x, c2.y, { button: 'right' })
await sleep(500)
const menu = await page.evaluate(() => !!document.querySelector('.context-menu'))
check('right click opens context menu', menu)
if (menu) await page.keyboard.press('Escape')
await sleep(300)

// 3. Ctrl+right click on R1 → session-bind menu (existing feature intact)
await page.evaluate(() => { const s = window.__dshCanvasTest?.excalidraw?.getAppState?.(); if (s.activeTool?.type !== 'selection') window.__dshCanvasTest?.excalidraw?.setActiveTool?.({ type: 'selection' }) })
const bindBefore = await page.evaluate(() => !!document.querySelector('[class*="bind"], [data-bind]'))
await page.keyboard.down('Control')
await page.mouse.click(c1.x, c1.y, { button: 'right' })
await page.keyboard.up('Control')
await sleep(500)
const bindMenu = await page.evaluate(() => {
  // the plugin's own bind menu is a fixed overlay with zIndex 100000
  return [...document.querySelectorAll('div')].some((d) => getComputedStyle(d).zIndex === '100000' && getComputedStyle(d).position === 'fixed')
})
check('Ctrl+right opens bind menu', bindMenu || bindBefore, `bindMenu=${bindMenu}`)
if (bindMenu) await page.keyboard.press('Escape')

// cleanup probes + the arrow
{
  const s = await state(canvasId)
  const arrow = (s.arrows ?? []).find((a) => a.from === n1.id && a.to === n2.id)
  const ids = [n1.id, n2.id, ...(arrow ? [arrow.id] : [])]
  await post({ canvasId, ops: [{ op: 'delete', ids }] })
  await sleep(800)
}

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
