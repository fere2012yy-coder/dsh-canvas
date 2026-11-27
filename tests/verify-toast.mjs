#!/usr/bin/env node
/** Verify: dead-link Ctrl+click shows the in-page toast (no native alert). */
import { chromium } from 'playwright-core'

const CDP = process.env.DSH_CDP ?? 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0]
const page = context.pages().find((p) => p.url().startsWith('dsh-app://'))
if (!page) { console.log('FATAL: no dsh-app page'); process.exit(1) }
await page.bringToFront()
await sleep(500)

const check = (name, ok, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
const originalId = await page.evaluate(() => window.__dshCanvasTest.canvasStore.currentCanvasId())
const tmpId = await page.evaluate(() => window.__dshCanvasTest.canvasStore.createCanvas('验收临时 ' + Date.now().toString(36)).id)
await page.evaluate(() => window.__dshCanvasTest.closeActive())
await sleep(900)
await page.evaluate(() => window.__dshCanvasTest.open('canvas'))
for (let i = 0; i < 15; i++) { await sleep(800); if (await page.evaluate(() => !!window.__dshCanvasTest?.excalidraw)) break }
await sleep(3000)

// dead-link block at scene origin
await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  api.updateScene({
    appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 },
    elements: [
      ...api.getSceneElementsIncludingDeleted(),
      ...window.__dshCanvasTest.exHelpers.convertToExcalidrawElements([
        { type: 'rectangle', x: -80, y: -42, width: 160, height: 84, link: 'dsh-session://does-not-exist' },
      ]),
    ],
  })
})
await sleep(600)
const pt = await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  const { scrollX, scrollY } = api.getAppState()
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  return { x: c.x + (0 + scrollX) * 1, y: c.y + (0 + scrollY) * 1 }
})

let nativeDialogSeen = false
page.once('dialog', (d) => { nativeDialogSeen = true; d.dismiss() })
await page.keyboard.down('Control')
await page.mouse.click(pt.x, pt.y)
await page.keyboard.up('Control')
await sleep(1200)

const toast = await page.evaluate(() => {
  const els = [...document.querySelectorAll('div')].filter((d) => d.textContent?.trim() === '打开绑定的会话失败（可能已被删除）' && d.children.length === 0 && d.offsetParent !== null)
  return els.length > 0
})
check('in-page toast shown (no native alert)', toast && !nativeDialogSeen, `toast=${toast} native=${nativeDialogSeen}`)
check('focus intact after toast', await page.evaluate(() => document.hasFocus()))
await page.keyboard.press('Escape')
await sleep(300)
await page.evaluate((id) => window.__dshCanvasTest.canvasStore.setCurrentCanvasId(id), originalId)
await browser.close()
