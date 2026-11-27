#!/usr/bin/env node
/** Reproduce: after tab close/reopen, Excalidraw's cached offsetLeft goes
 * stale once the workspace-swap CSS re-applies (child effects run before
 * parent's swap effect). Compare appState.offsetLeft vs live rect.left. */
import { chromium } from 'playwright-core'

const CDP = process.env.DSH_CDP ?? 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0]
const page = context.pages().find((p) => p.url().startsWith('dsh-app://'))
if (!page) { console.log('FATAL: no dsh-app page'); process.exit(1) }
await page.bringToFront()
await sleep(500)

const probe = () => page.evaluate(() => {
  const st = window.__dshCanvasTest?.excalidraw?.getAppState()
  const c = document.querySelector('canvas.excalidraw__canvas.interactive')?.getBoundingClientRect()
  if (!st || !c) return null
  return { offsetLeft: st.offsetLeft, rectLeft: c.left, offsetTop: st.offsetTop, rectTop: c.top, drift: +(st.offsetLeft - c.left).toFixed(1) }
})

// ensure open + settle
await page.evaluate(() => window.__dshCanvasTest.open('canvas'))
for (let i = 0; i < 15; i++) { await sleep(800); if (await page.evaluate(() => !!window.__dshCanvasTest?.excalidraw)) break }
await sleep(2500)
console.log('open #1:', JSON.stringify(await probe()))

// the user flow: Alt+` close (tab close) then reopen
await page.evaluate(() => window.__dshCanvasTest.closeActive())
await sleep(1200)
console.log('closed, swap active?', await page.evaluate(() => document.documentElement.hasAttribute('data-canvas-swap')))
await page.evaluate(() => window.__dshCanvasTest.open('canvas'))
for (let i = 0; i < 15; i++) { await sleep(800); if (await page.evaluate(() => !!window.__dshCanvasTest?.excalidraw)) break }
await sleep(2500)
const after = await probe()
console.log('open #2 (reopened):', JSON.stringify(after))

// does a manual resize event heal it?
await page.evaluate(() => window.dispatchEvent(new Event('resize')))
await sleep(800)
console.log('after resize event:', JSON.stringify(await probe()))
await browser.close()
