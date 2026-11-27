#!/usr/bin/env node
/** Why doesn't ctrl+right-click open the bind menu? (fixed zoom handling) */
import { chromium } from 'playwright-core'

const CDP = process.env.DSH_CDP ?? 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0]
const page = context.pages().find((p) => p.url().startsWith('dsh-app://'))
if (!page) { console.log('FATAL: no dsh-app page'); process.exit(1) }
await page.bringToFront()
await sleep(500)

const blockPoint = () => page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  const st = api.getAppState()
  const z = st.zoom.value
  const box = st.zoom.translation // may not exist
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  const sx = 0 + st.scrollX, sy = 0 + st.scrollY
  return { x: c.left + sx * z, y: c.top + sy * z, z, sx, sy, ok: Number.isFinite(sx * z) }
})
console.log('blockPoint:', JSON.stringify(await blockPoint()))
const pt = await blockPoint()
if (!pt.ok) { console.log('bad point'); process.exit(1) }

await page.keyboard.down('Control')
await page.mouse.click(pt.x, pt.y, { button: 'right' })
await page.keyboard.up('Control')
await sleep(700)
let menu = await page.evaluate(() => ({
  create: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '创建会话并绑定'),
  excMenu: !!document.querySelector('.excalidraw .context-menu'),
}))
console.log('after real ctrl+right-click:', JSON.stringify(menu))
await page.keyboard.press('Escape'); await sleep(400)
await page.mouse.click(10, 500); await sleep(300)

// plain right-click (no ctrl): stock menu expected
await page.mouse.click(pt.x, pt.y, { button: 'right' })
await sleep(700)
console.log('after plain right-click (stock menu?):', JSON.stringify(await page.evaluate(() => !!document.querySelector('.excalidraw .context-menu') || [...document.querySelectorAll('button')].some((b) => /复制|删除|样式/.test(b.textContent ?? '')))))
await page.keyboard.press('Escape'); await sleep(300)
await browser.close()
