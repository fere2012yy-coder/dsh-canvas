#!/usr/bin/env node
/** Verify: delete-canvas now uses the in-page confirm dialog, and
 * blank-dblclick text editing still starts on the remaining canvas. */
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
check('tmp canvas mounted', (await page.evaluate(() => window.__dshCanvasTest.canvasStore.currentCanvasId())) === tmpId)

const center = () => page.evaluate(() => {
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  return { x: c.x + c.width / 2, y: c.y + c.height / 2 }
})
const probeEditing = () => page.evaluate(() => ({
  editing: window.__dshCanvasTest.excalidraw.getAppState().editingTextElement?.id ?? null,
  textarea: !!document.querySelector('.excalidraw textarea'),
  hasFocus: document.hasFocus(),
}))

// baseline dblclick
await page.mouse.dblclick((await center()).x, (await center()).y)
await sleep(900)
const base = await probeEditing()
check('A baseline dblclick starts editing', !!base.editing && base.textarea, JSON.stringify(base))
await page.keyboard.press('Escape'); await sleep(400)

// delete via real menu → in-page dialog (no native dialog anymore)
let nativeDialogSeen = false
page.once('dialog', (d) => { nativeDialogSeen = true; d.accept() })
const btn = await page.evaluate(() => {
  const b = document.querySelector('[data-testid="main-menu-trigger"]')
  const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
await page.mouse.click(btn.x, btn.y); await sleep(700)
await page.evaluate(() => {
  const b = [...document.querySelectorAll('[role="menuitem"], button')].find((e) => e.textContent?.trim() === '删除当前画布' && e.offsetParent !== null)
  b?.click()
})
await sleep(700)
check('B no native dialog (in-page confirm used)', !nativeDialogSeen)
const dlgText = await page.evaluate(() => {
  const d = document.querySelector('[role="dialog"]')
  return d ? d.textContent : null
})
check('C in-page confirm dialog visible', !!dlgText && dlgText.includes('内容不可恢复'), JSON.stringify(dlgText))
if (!dlgText) { console.log('abort'); process.exit(1) }
await page.evaluate(() => {
  const b = [...document.querySelectorAll('[role="dialog"] button')].find((e) => e.textContent?.trim() === '删除')
  b?.click()
})
await sleep(2000)
const afterDelete = await page.evaluate((o) => window.__dshCanvasTest.canvasStore.currentCanvasId() === o, originalId)
check('D current fell back to original canvas', afterDelete)
await sleep(2000)

// dblclick on remaining canvas
await page.mouse.dblclick((await center()).x, (await center()).y)
await sleep(900)
const res = await probeEditing()
check('E dblclick on remaining canvas starts editing', !!res.editing && res.textarea, JSON.stringify(res))
await page.keyboard.press('Escape'); await sleep(300)
await page.evaluate((id) => window.__dshCanvasTest.canvasStore.setCurrentCanvasId(id), originalId)
await browser.close()
