#!/usr/bin/env node
/** Diagnostic 2: viewport-vs-window size check + bridge-driven toggle repro. */
import { chromium } from 'playwright-core'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(root, 'tests', 'out'), { recursive: true })

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
console.log('[diag] targets:', ctx.pages().map((p) => p.url()).join(' | '))
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

const sizeInfo = () =>
  page.evaluate(() => ({
    inner: { w: innerWidth, h: innerHeight },
    outer: { w: outerWidth, h: outerHeight },
    screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight },
    dpr: devicePixelRatio,
    vv: { scale: visualViewport.scale, w: visualViewport.width, h: visualViewport.height, x: visualViewport.offsetLeft, y: visualViewport.offsetTop },
    docClient: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
    bodyRect: document.body.getBoundingClientRect().toJSON(),
  }))

console.log('[diag] BEFORE toggle:', JSON.stringify(await sizeInfo(), null, 1))

// Bridge-driven toggle = Alt+` path (toggleWorkspace uses the same service)
await page.evaluate(() => window.__dshCanvasTest.closeActive())
await page.waitForTimeout(2500)
const afterOut = await page.evaluate(() => ({
  active: window.__dshCanvasTest.active(),
  swapAttr: document.documentElement.hasAttribute('data-canvas-swap'),
  styleTags: document.querySelectorAll('style[data-plugin="dsh-canvas"]').length,
  colsVar: document.documentElement.style.getPropertyValue('--dsh-canvas-swap-cols') || null,
}))
console.log('[diag] AFTER OUT:', JSON.stringify(afterOut))
console.log('[diag] size after OUT:', JSON.stringify(await sizeInfo()))

await page.evaluate(() => window.__dshCanvasTest.open('dsh-canvas:canvas'))
await page.waitForTimeout(5000)
const afterIn = await page.evaluate(() => ({
  active: window.__dshCanvasTest.active(),
  swapAttr: document.documentElement.hasAttribute('data-canvas-swap'),
  styleTags: document.querySelectorAll('style[data-plugin="dsh-canvas"]').length,
}))
console.log('[diag] AFTER IN:', JSON.stringify(afterIn))
console.log('[diag] size after IN:', JSON.stringify(await sizeInfo(), null, 1))

const cdp = await ctx.newCDPSession(page)
const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: false })
writeFileSync(join(root, 'tests', 'out', 'diag2-in.png'), Buffer.from(shot.data, 'base64'))
console.log('[diag] screenshot -> tests/out/diag2-in.png')
await browser.close()
