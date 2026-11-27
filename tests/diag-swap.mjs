#!/usr/bin/env node
/**
 * Diagnostic (untracked, delete after use): workspace-swap bugs.
 *   part1  — Alt+` out→in reproduction: state snapshots, cleanup-leak check,
 *            DOM hit-test probe, Excalidraw scene-mapping probe + screenshots
 *   part2  — record column widths + localStorage before a restart
 *   after  — same recording after the restart (compare with part2 output)
 * Run against live DSH with CDP 9222 (DSH-debug.bat). 🔴 no cache clearing.
 */
import { chromium } from 'playwright-core'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'tests', 'out'), { recursive: true })
const mode = process.argv[2] ?? 'part1'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
let page
for (const p of ctx.pages()) {
  if (p.isClosed()) continue
  const ok = await p
    .evaluate(() => !!document.querySelector('[data-rightbar-col]'))
    .catch(() => false)
  if (ok) {
    page = p
    break
  }
}
if (!page) {
  console.log('[diag] no DSH page with AppFrame found; pages:', ctx.pages().map((p) => p.url()))
  process.exit(1)
}
console.log('[diag] page:', page.url())

const snap = (label) =>
  page
    .evaluate(() => {
      const root = document.documentElement
      const rb = document.querySelector('[data-rightbar-col]')
      const frame = rb?.parentElement
      const center = frame?.querySelector('[class*="centerCol"]')
      const handle = frame?.querySelector('[class*="handle"][data-side="rightbar"]')
      const fin = (n) => (Number.isFinite(n) ? n : 0)
      const r = (el) => {
        if (!el) return null
        const b = el.getBoundingClientRect()
        return { x: Math.round(fin(b.x)), y: Math.round(fin(b.y)), w: Math.round(fin(b.width)), h: Math.round(fin(b.height)) }
      }
      const pick = (x, y) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return 'nonfinite'
        const el = document.elementFromPoint(x, y)
        if (!el) return 'none'
        if (el.closest('[data-rightbar-col]')) return 'rightbar'
        if (el.closest('[class*="centerCol"]')) return 'center'
        return 'other:' + String(el.className).slice(0, 40)
      }
      const rbRect = r(rb)
      const cRect = r(center)
      return {
        swapAttr: root.hasAttribute('data-canvas-swap'),
        colsVar: root.style.getPropertyValue('--dsh-canvas-swap-cols') || null,
        handleVar: root.style.getPropertyValue('--dsh-canvas-swap-handle') || null,
        styleTags: document.querySelectorAll('style[data-plugin="dsh-canvas"]').length,
        inlineCols: frame?.style.gridTemplateColumns ?? null,
        computedCols: frame ? getComputedStyle(frame).gridTemplateColumns : null,
        rbRect,
        cRect,
        handleRect: r(handle),
        hitAtRbCenter: rbRect ? pick(rbRect.x + rbRect.w / 2, rbRect.y + rbRect.h / 2) : null,
        hitAtCenterCenter: cRect ? pick(cRect.x + cRect.w / 2, cRect.y + cRect.h / 2) : null,
        activeTab: window.__dshCanvasTest?.active?.() ?? null,
        hasExcalidraw: !!window.__dshCanvasTest?.excalidraw,
        dpr: window.devicePixelRatio,
        vvScale: visualViewport.scale,
        inner: { w: innerWidth, h: innerHeight },
      }
    })
    .then((s) => {
      console.log(`[diag] ===== ${label} =====`)
      console.log(JSON.stringify(s, null, 1))
      return s
    })

const altBackquote = async () => {
  await page.keyboard.down('Alt')
  await page.keyboard.press('`')
  await page.keyboard.up('Alt')
}

const cdp = await ctx.newCDPSession(page)
const screenshot = async (name) => {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false })
  const file = join(root, 'tests', 'out', name)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log('[diag] screenshot ->', file)
}

/** Drop a 40×30 probe rectangle at the scene point under the canvas center. */
const addProbe = async () => {
  return page.evaluate(() => {
    const api = window.__dshCanvasTest?.excalidraw
    if (!api) return null
    const el = document.querySelector('.excalidraw')
    const rect = el.getBoundingClientRect()
    const { zoom, scrollX, scrollY } = api.getAppState()
    const z = zoom.value
    const px = rect.left + rect.width / 2
    const py = rect.top + rect.height / 2
    const sx = (px - rect.left) / z - scrollX
    const sy = (py - rect.top) / z - scrollY
    window.__diagProbe = { px, py, sx, sy, z }
    api.updateScene({
      elements: [
        ...api.getSceneElements(),
        {
          id: 'diag-probe',
          type: 'rectangle',
          x: sx - 20,
          y: sy - 15,
          width: 40,
          height: 30,
          strokeColor: '#e03131',
          backgroundColor: 'transparent',
          fillStyle: 'solid',
          strokeWidth: 4,
          roughness: 1,
          seed: 1,
          version: 1,
          versionNonce: 1,
          isDeleted: false,
          boundElements: null,
          updated: 1,
          link: null,
          locked: false,
          groupIds: [],
          frameId: null,
          roundness: null,
          angle: 0,
        },
      ],
    })
    return { px: Math.round(px), py: Math.round(py) }
  })
}
const removeProbe = () =>
  page.evaluate(() => {
    const api = window.__dshCanvasTest?.excalidraw
    if (!api) return
    api.updateScene({ elements: api.getSceneElements().filter((e) => e.id !== 'diag-probe') })
  })

if (mode === 'part1') {
  // Make sure the window is restored & frontmost — a minimized/background
  // window drops frames (blank captures) and may swallow shortcut keys.
  await page.bringToFront()
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  } catch (e) {
    console.log('[diag] window restore skipped:', String(e).slice(0, 120))
  }
  await page.waitForTimeout(1500)

  // Entry 1 (fresh)
  await altBackquote()
  await page.waitForTimeout(4500)
  const s1 = await snap('IN-1 (first entry)')
  await screenshot('diag-IN1.png')

  // Exit — verify cleanup completeness
  await altBackquote()
  await page.waitForTimeout(2500)
  await snap('OUT (after exit)')

  // Entry 2 — the user's bug path
  await altBackquote()
  await page.waitForTimeout(4500)
  const s2 = await snap('IN-2 (second entry, bug state)')
  await screenshot('diag-IN2.png')

  const probe = await addProbe()
  await page.waitForTimeout(800)
  await screenshot('diag-IN2-probe.png')
  console.log('[diag] probe screen point expected:', JSON.stringify(probe))
  await removeProbe()
  await page.waitForTimeout(600)
} else if (mode === 'part2') {
  const data = await page.evaluate(() => {
    const frame = document.querySelector('[data-rightbar-col]')?.parentElement
    const ls = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      const v = localStorage.getItem(k)
      ls[k] = v.length > 300 ? `<${v.length} chars>` : v
    }
    return {
      inlineCols: frame?.style.gridTemplateColumns ?? null,
      swapAttr: document.documentElement.hasAttribute('data-canvas-swap'),
      inner: { w: innerWidth, h: innerHeight },
      localStorage: ls,
    }
  })
  writeFileSync(join(root, 'tests', 'out', 'diag-before.json'), JSON.stringify(data, null, 1))
  console.log('[diag] saved tests/out/diag-before.json')
  console.log('[diag] inlineCols:', data.inlineCols)
} else if (mode === 'after') {
  const data = await page.evaluate(() => {
    const frame = document.querySelector('[data-rightbar-col]')?.parentElement
    const ls = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      const v = localStorage.getItem(k)
      ls[k] = v.length > 300 ? `<${v.length} chars>` : v
    }
    return {
      inlineCols: frame?.style.gridTemplateColumns ?? null,
      swapAttr: document.documentElement.hasAttribute('data-canvas-swap'),
      inner: { w: innerWidth, h: innerHeight },
      localStorage: ls,
    }
  })
  writeFileSync(join(root, 'tests', 'out', 'diag-after.json'), JSON.stringify(data, null, 1))
  console.log('[diag] saved tests/out/diag-after.json')
  console.log('[diag] inlineCols:', data.inlineCols)
}

await browser.close()
