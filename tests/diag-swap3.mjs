#!/usr/bin/env node
/** Diagnostic 3: sidebar-right registration model + reopen + drag persistence. */
import { chromium } from 'playwright-core'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'tests', 'out'), { recursive: true })

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page
for (const p of ctx.pages()) {
  if (p.isClosed()) continue
  const ok = await p.evaluate(() => !!document.querySelector('[data-rightbar-col]')).catch(() => false)
  if (ok) {
    page = p
    break
  }
}
if (!page) process.exit(1)

page.on('console', (msg) => {
  const t = msg.type()
  if (t === 'error' || t === 'warning' || /dsh-canvas/.test(msg.text())) {
    console.log(`[console:${t}]`, msg.text().slice(0, 300))
  }
})

// 1. Extract the shell's SidebarRightController source around the error
const src = await page.evaluate(async () => {
  const res = await fetch(location.href.replace(/\/app\/$/, '/app/plugins/') +
    '??' + encodeURIComponent([
      '@deepseek-ai/dsh-client-ui-sidebar-right',
    ]).replace(/%2F/gi, '/').replace(/%40/gi, '@') + '/client.js').catch(() => null)
  if (!res || !res.ok) return { error: 'fetch failed ' + (res?.status ?? 'null') }
  const text = await res.text()
  const idx = text.indexOf('no tab type is registered')
  return {
    total: text.length,
    around: idx >= 0 ? text.slice(Math.max(0, idx - 3000), idx + 1500) : 'marker not found',
  }
})
console.log('[diag] sidebar-right controller source:')
console.log(typeof src === 'string' ? src : JSON.stringify(src.around ?? src, null, 1))

// 2. Guide card present? (types registered ⇒ guide should list them)
const guide = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-sidebar-right-panel] *')]
    .filter((n) => n.childElementCount === 0 && /DSH Canvas|画布/.test(n.textContent ?? ''))
  return {
    panelEl: !!document.querySelector('[data-sidebar-right-panel]'),
    canvasCards: cards.map((n) => n.textContent.trim()).slice(0, 5),
    active: window.__dshCanvasTest?.active?.() ?? null,
  }
})
console.log('[diag] guide state:', JSON.stringify(guide))

// 3. Reopen — first the real Alt+` argument ('canvas'), then full TAB_ID
const openRes = await page.evaluate(async () => {
  const bridge = window.__dshCanvasTest
  const attempts = []
  for (const arg of ['canvas', 'dsh-canvas:canvas']) {
    try {
      bridge.open(arg)
      await new Promise((r) => setTimeout(r, 1200))
      attempts.push({ arg, ok: true, active: bridge.active() })
      if (bridge.active()) break
    } catch (e) {
      attempts.push({ arg, error: String(e).slice(0, 160) })
    }
  }
  return { attempts, active: bridge.active(), swapAttr: document.documentElement.hasAttribute('data-canvas-swap') }
})
console.log('[diag] open attempts:', JSON.stringify(openRes, null, 1))
await page.waitForTimeout(3000)

// 4. In swapped state: hit-test + viewport sanity
const state = await page.evaluate(() => {
  const rb = document.querySelector('[data-rightbar-col]')
  const frame = rb?.parentElement
  return {
    active: window.__dshCanvasTest?.active?.() ?? null,
    swapAttr: document.documentElement.hasAttribute('data-canvas-swap'),
    inner: { w: innerWidth, h: innerHeight },
    outer: { w: outerWidth, h: outerHeight },
    inlineCols: frame?.style.gridTemplateColumns ?? null,
  }
})
console.log('[diag] state after open:', JSON.stringify(state))

// 5. Divider drag via real CDP mouse (canvas wider by ~300px), watch persistence
const lsDump = () =>
  page.evaluate(() => {
    const out = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      const v = localStorage.getItem(k)
      if (/width|size|panel|layout|rightbar|sidebar|dock|split|resize|col/i.test(k) || v.length < 120) {
        out[k] = v.length > 200 ? `<${v.length} chars>` : v
      }
    }
    return out
  })
const before = await lsDump()
const drag = await page.evaluate(() => {
  const handle = document.querySelector("[class*='handle'][data-side='rightbar']")
  if (!handle) return { error: 'no handle' }
  const r = handle.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
if (drag.x) {
  await page.mouse.move(drag.x, drag.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(drag.x + i * 30, drag.y)
  await page.mouse.up()
  await page.waitForTimeout(1500)
}
const afterDrag = await page.evaluate(() => {
  const frame = document.querySelector('[data-rightbar-col]')?.parentElement
  return {
    inlineCols: frame?.style.gridTemplateColumns ?? null,
    inner: { w: innerWidth, h: innerHeight },
  }
})
console.log('[diag] drag:', JSON.stringify(drag), '→ afterDrag:', JSON.stringify(afterDrag))
const after = await lsDump()
const changed = {}
for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (before[k] !== after[k]) changed[k] = { before: before[k], after: after[k] }
}
console.log('[diag] localStorage keys changed by drag:', JSON.stringify(changed, null, 1))
writeFileSync(join(root, 'tests', 'out', 'diag-before.json'), JSON.stringify({ inlineCols: afterDrag.inlineCols, ls: after }, null, 1))
console.log('[diag] saved tests/out/diag-before.json')
await browser.close()
