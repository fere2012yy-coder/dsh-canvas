#!/usr/bin/env node
/**
 * End-to-end adaptation verification for DSH 0.2.1-rc.1.
 *
 * Injects the NEW swapCss (imported from src/workspace-swap.js — the exact
 * string the rebuilt bundle emits) and drives the real app over CDP:
 *   bridge open · guide-card open · tab-× close · right-sidebar collapse /
 *   expand · fullscreen · divider drag · session switch (pin) · restore.
 * Each state is measured (grid rows/cols, column rects, swap attr, pin) and
 * screenshotted. Cleanup restores the stock layout and unpins.
 *
 * NOTE: configurable shortcuts (Alt+`) are dispatched from NATIVE keyboard
 * input on Windows Desktop in 0.2.x (trusted preload bridge), so CDP key
 * events can never trigger them — the tab is opened via the plugin's own test
 * bridge here. The shortcut itself is verified via its catalog entry (the
 * guide card prints its keys), not via synthetic input.
 */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

globalThis.require = () => ({ useEffect: () => {} })
const { swapCss } = await import('../src/workspace-swap.js')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests', 'out', 'adapt')
mkdirSync(outDir, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('dsh-app'))
if (!page) { console.log('FATAL no dsh page'); process.exit(1) }
await page.bringToFront()

const consoleLogs = []
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') consoleLogs.push(`[${m.type()}] ${m.text().slice(0, 240)}`) })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const measure = () => page.evaluate(() => {
  const rect = (el) => (el ? (({ x, y, width, height }) => ({ x: Math.round(x), y: Math.round(y), w: Math.round(width), h: Math.round(height) }))(el.getBoundingClientRect()) : null)
  const rb = document.querySelector('[data-rightbar-col]')
  const frame = rb.parentElement
  const cs = getComputedStyle(frame)
  const panel = document.querySelector('[data-sidebar-right-panel]')
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    active: window.__dshCanvasTest?.active?.() ?? null,
    pin: localStorage.getItem('dsh-canvas.pinned'),
    swap: document.documentElement.getAttribute('data-canvas-swap'),
    cols: cs.gridTemplateColumns,
    rows: cs.gridTemplateRows,
    inline: frame.getAttribute('style'),
    sidebar: rect(document.querySelector("[class*='_sidebarCol']")),
    center: rect(document.querySelector("[class*='_centerCol']")),
    rightbar: rect(rb),
    panel: rect(panel),
    panelHidden: panel?.getAttribute('aria-hidden') ?? null,
    panelMode: panel?.getAttribute('data-sidebar-right-panel') ?? null,
    excal: rect(document.querySelector('.excalidraw')),
    handle: rect(document.querySelector("[class*='_handle'][data-side='rightbar']")),
    session: panel?.getAttribute('data-sidebar-right-session') ?? null,
    fixStyle: !!document.getElementById('dsh-canvas-fix-style'),
  }
})

const injectNewCss = () => page.evaluate((css) => {
  const frame = document.querySelector('[data-rightbar-col]')?.parentElement
  if (!frame) return null
  const prefix = /([\w-]+)_frame\b/.exec(frame.className)?.[1]
  let st = document.getElementById('dsh-canvas-fix-style')
  if (!st) { st = document.createElement('style'); st.id = 'dsh-canvas-fix-style'; document.head.append(st) }
  st.textContent = css.replace(/__PREFIX__/g, prefix)
  return prefix
}, swapCss('__PREFIX__'))

const clickByAria = async (aria) => {
  const r = await page.evaluate((label) => {
    const els = [...document.querySelectorAll('button,[role="button"]')].filter((b) => b.getAttribute('aria-label') === label)
    const el = els.find((e) => e.offsetParent !== null) ?? els[0]
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }, aria)
  if (!r) return false
  await page.mouse.click(r.x, r.y)
  return true
}

/** Click a control, then poll until `predicate` holds (animations lag). */
const clickUntil = async (aria, predicate, timeoutMs = 6000) => {
  if (!(await clickByAria(aria))) return false
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await measure()
    if (predicate(last)) return true
    await sleep(300)
  }
  return predicate(last ?? (await measure()))
}

/** Poll (no click) until `predicate` holds — for geometry that settles after an animation. */
const waitForState = async (predicate, timeoutMs = 8000) => {
  const t0 = Date.now()
  let last = await measure()
  while (Date.now() - t0 < timeoutMs) {
    if (predicate(last)) return true
    await sleep(300)
    last = await measure()
  }
  return predicate(last)
}

const clickTabClose = async () => {
  const r = await page.evaluate(() => {
    const close = document.querySelector('[data-dockkit-tab-close]')
    if (!close) return null
    const b = close.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  if (!r) return false
  await page.mouse.click(r.x, r.y)
  await sleep(1400)
  return true
}

const bridgeOpen = async () => {
  await page.evaluate(async () => {
    try { window.__dshCanvasTest.open('canvas') } catch (e) { return String(e) }
    await new Promise((r) => setTimeout(r, 1800))
  })
  await sleep(400)
}

const rowsCount = (rows) => rows.trim().split(/\s+/).filter(Boolean).length
const isStock = (m) => rowsCount(m.rows) === 2 && m.swap === null && (m.center?.x ?? -1) === 280 && m.rightbar?.w === 0
const isSwapped = (m) => m.swap === '1' && rowsCount(m.rows) === 2 && (m.sidebar?.w ?? 0) >= 264 &&
  Math.abs((m.center?.x ?? 0) - ((m.panel?.x ?? 0) + (m.panel?.w ?? 0))) <= 2 &&
  Math.abs((m.rightbar?.x ?? 0) - 280) <= 2 &&
  Math.abs((m.panel?.x ?? 0) - (m.rightbar?.x ?? 1)) <= 2 &&
  Math.abs((m.panel?.w ?? 0) - (m.rightbar?.w ?? -1)) <= 2

// ---------- 0. clean slate ----------
await page.evaluate(async () => {
  localStorage.removeItem('dsh-canvas.pinned')
  const s = window.__dshCanvasTest
  const a = s?.active?.()
  if (a) s.closeActive()
})
await sleep(1500)
await page.evaluate(() => document.getElementById('dsh-canvas-fix-style')?.remove())
const prefix = await injectNewCss()
check('inject new swap css (prefix from live frame)', !!prefix, `prefix=${prefix}`)
let m = await measure()
check('baseline: stock layout, no swap', isStock(m), `rows=${m.rows} cols=${m.cols} hidden=${m.panelHidden}`)

// ---------- 1. open the canvas (bridge = same path the shell uses) ----------
await bridgeOpen()
m = await measure()
check('canvas tab opens & mounts Excalidraw', m.active?.kind === 'canvas' && !!m.excal, JSON.stringify(m.active))
check('swap: two rows, canvas in the middle, chat on the right', isSwapped(m), `cols=${m.cols} rows=${m.rows} panelX=${m.panel?.x} centerX=${m.center?.x}`)
check('Excalidraw fills the canvas column', Math.abs((m.excal?.w ?? 0) - (m.rightbar?.w ?? -1)) <= 3 && (m.excal?.x ?? -1) >= 280, JSON.stringify(m.excal))
check('divider handle on the canvas/chat boundary', Math.abs((m.handle?.x ?? 0) + 4 - (m.center?.x ?? -1)) <= 3, `handleX=${m.handle?.x} centerX=${m.center?.x}`)
check('native sidebar keeps its full height', (m.sidebar?.h ?? 0) > m.vh * 0.9, `sidebar=${JSON.stringify(m.sidebar)} vh=${m.vh}`)
await page.screenshot({ path: join(outDir, '1-open.png') })

// ---------- 2. guide card opens; tab × closes (user gesture → unpin) ----------
await clickTabClose()
m = await measure()
check('tab × closes the canvas tab', m.active === null, JSON.stringify(m.active))
check('× close restores the stock layout', isStock(m), `rows=${m.rows} cols=${m.cols}`)
check('× close unpins (user gesture)', m.pin === null, `pin=${m.pin}`)
const guide = await page.evaluate(async () => {
  try { window.__dshCanvasTest.open('guide') } catch { }
  await new Promise((r) => setTimeout(r, 900))
  const panel = document.querySelector('[data-sidebar-right-panel]')
  const card = [...panel.querySelectorAll('button')].find((b) => /DSH Canvas/.test(b.innerText || ''))
  if (!card) return { found: false }
  const txt = card.innerText
  card.click()
  await new Promise((r) => setTimeout(r, 2000))
  return { found: true, txt, active: window.__dshCanvasTest.active?.() ?? null }
})
check('guide card lists the Alt+` binding', guide.found && /Alt/.test(guide.txt), JSON.stringify(guide.txt))
check('guide card opens the canvas tab', guide.found && guide.active?.kind === 'canvas', JSON.stringify(guide.active))
m = await measure()
check('guide-open layout swapped & sane', isSwapped(m), `cols=${m.cols}`)
await page.screenshot({ path: join(outDir, '2-guide-open.png') })

// ---------- 3. collapse / expand the right sidebar while swapped ----------
const collapsed = (await clickByAria('收起右侧边栏')) &&
  (await waitForState((s) => s.panelHidden === 'true' && isStock(s)))
m = await measure()
check('collapse hides the panel', collapsed && m.panelHidden === 'true', `hidden=${m.panelHidden}`)
check('collapse steps the swap aside', m.swap === null && rowsCount(m.rows) === 2 && isStock(m), `swap=${m.swap} rows=${m.rows}`)
await page.screenshot({ path: join(outDir, '3-collapsed.png') })
const expanded = (await clickByAria('打开右侧边栏')) &&
  (await waitForState((s) => s.panelHidden !== 'true' && isSwapped(s)))
m = await measure()
check('expand restores the panel & the swap', expanded && m.panelHidden !== 'true' && isSwapped(m), `hidden=${m.panelHidden} swap=${m.swap} cols=${m.cols}`)

// ---------- 4. fullscreen ----------
const fsOn = await clickUntil('全屏', (s) => s.panelMode === 'fullscreen')
m = await measure()
check('fullscreen panel covers the content area', fsOn && m.panelMode === 'fullscreen' && m.panel?.x === 280 && (m.panel?.w ?? 0) > m.vw * 0.7, `panel=${JSON.stringify(m.panel)} vw=${m.vw}`)
await page.screenshot({ path: join(outDir, '4-fullscreen.png') })
const fsOff = await clickUntil('退出全屏', (s) => s.panelMode === 'push')
m = await measure()
check('exit fullscreen returns to the swapped layout', fsOff && m.panelMode === 'push' && isSwapped(m), `mode=${m.panelMode} cols=${m.cols}`)

// ---------- 5. divider drag: natural direction, then restore width ----------
const before = await measure()
const h = before.handle
if (h) {
  const y = h.y + Math.round(h.h / 2)
  await page.mouse.move(h.x + 4, y); await page.mouse.down()
  for (let i = 1; i <= 6; i++) { await page.mouse.move(h.x + 4 - i * 20, y); await sleep(40) }
  await page.mouse.up()
  await sleep(900)
}
const after = await measure()
check('drag left shrinks the canvas panel', (after.rightbar?.w ?? 0) <= (before.rightbar?.w ?? 0) - Math.min(60, (before.rightbar?.w ?? 0) * 0.05), `before=${before.rightbar?.w} after=${after.rightbar?.w}`)
check('panel stays glued to its track while dragged', Math.abs((after.panel?.x ?? 0) - (after.rightbar?.x ?? 1)) <= 2 && Math.abs((after.panel?.w ?? 0) - (after.rightbar?.w ?? -1)) <= 2, JSON.stringify({ panel: after.panel, track: after.rightbar }))
await page.screenshot({ path: join(outDir, '5-drag.png') })
// restore the pre-test width by dragging back right
const h2 = after.handle
if (h2) {
  const y = h2.y + Math.round(h2.h / 2)
  await page.mouse.move(h2.x + 4, y); await page.mouse.down()
  for (let i = 1; i <= 6; i++) { await page.mouse.move(h2.x + 4 + i * 20, y); await sleep(40) }
  await page.mouse.up()
  await sleep(900)
}

// ---------- 6. session switch: the pin re-opens the canvas on the other session ----------
const ourSession = (await measure()).session
let switched = false
let switchDiag = []
for (let attempt = 0; attempt < 3 && !switched; attempt++) {
  const otherRow = await page.evaluate((cur) => {
    // panel attr is `session-<uuid>`; sidebar rows are `session:session-<uuid>`
    const ownKey = `session:${cur}`
    const rows = [...document.querySelectorAll('[data-row-key^="session:"]')].filter((r) => r.offsetParent !== null)
    const target = rows.find((r) => r.getAttribute('data-row-key') !== ownKey)
    if (!target) return null
    target.scrollIntoView({ block: 'center' })
    const b = target.getBoundingClientRect()
    const x = b.x + 100, y = b.y + b.height / 2
    const under = document.elementFromPoint(x, y)
    return { key: target.getAttribute('data-row-key'), x, y, under: under?.closest('[data-row-key]')?.getAttribute('data-row-key') ?? null }
  }, ourSession)
  switchDiag.push(otherRow)
  if (!otherRow) break
  await page.mouse.click(otherRow.x, otherRow.y)
  for (let i = 0; i < 12 && !switched; i++) {
    await sleep(500)
    const s = await measure()
    switched = s.session !== null && s.session !== ourSession
  }
}
m = await measure()
check('session switch actually changed the on-screen session', switched, `before=${ourSession} after=${m.session} diag=${JSON.stringify(switchDiag)}`)
check('canvas tab survives the switch (pin restore)', m.active?.kind === 'canvas' && !!m.excal, JSON.stringify(m.active))
check('swap layout sane after session switch', isSwapped(m), `cols=${m.cols} rows=${m.rows}`)
await page.screenshot({ path: join(outDir, '6-session-switch.png') })

// cleanup the other session: close its canvas tab (unpins), then return home
await clickTabClose()
await sleep(800)
const backHome = await page.evaluate(async (sid) => {
  const row = document.querySelector(`[data-row-key="session:${sid}"]`)
  if (!row) return null
  row.scrollIntoView({ block: 'center' })
  const b = row.getBoundingClientRect()
  return { x: b.x + 100, y: b.y + b.height / 2 }
}, ourSession)
if (backHome) { await page.mouse.click(backHome.x, backHome.y) }
let homeAgain = false
for (let i = 0; i < 20 && !homeAgain; i++) {
  await sleep(500)
  homeAgain = (await measure()).session === ourSession
}
await sleep(1500)
m = await measure()
check('returning home restores the saved canvas tab', homeAgain && m.active?.kind === 'canvas', `session=${m.session} active=${JSON.stringify(m.active)}`)

// ---------- 7. final cleanup: close via ×, stock layout, unpinned ----------
await clickTabClose()
m = await measure()
check('cleanup: closed, stock layout, unpinned', m.active === null && isStock(m) && m.pin === null, `active=${JSON.stringify(m.active)} rows=${m.rows} pin=${m.pin}`)
await page.evaluate(() => document.getElementById('dsh-canvas-fix-style')?.remove())
await page.screenshot({ path: join(outDir, '7-final-stock.png') })

const guardWarnings = consoleLogs.filter((l) => /swapped frame grew rows|AppFrame not recognized/.test(l))
check('no swap guard/fallback warnings', guardWarnings.length === 0, guardWarnings.join(' | '))

writeFileSync(join(outDir, 'adapt-verify.json'), JSON.stringify({ results, final: m, consoleLogs: consoleLogs.slice(-20) }, null, 1))
const failed = results.filter((r) => !r.ok)
console.log(`\n========== ${results.length - failed.length}/${results.length} checks passed ==========`)
if (failed.length) { console.log('FAILED:', failed.map((f) => f.name).join(' | ')); process.exit(1) }
await browser.close()
