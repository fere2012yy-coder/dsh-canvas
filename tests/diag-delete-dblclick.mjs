#!/usr/bin/env node
/**
 * Diagnostic: does "删除当前画布" (window.confirm path) break blank-dblclick
 * text editing on the remaining canvas?
 *
 * A. baseline dblclick on a throwaway canvas → editing starts?
 * B. delete that canvas via the real menu (confirm accepted) → dblclick again.
 * Throwaway canvases only; empty text is discarded by Excalidraw on Escape.
 */
import { chromium } from 'playwright-core'

const CDP = process.env.DSH_CDP ?? 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0]
const page = context.pages().find((p) => p.url().startsWith('dsh-app://'))
if (!page) { console.log('FATAL: no dsh-app page'); process.exit(1) }
await page.bringToFront()
await sleep(500)

page.on('dialog', (d) => { console.log('  [dialog]', d.type(), JSON.stringify(d.message())); d.accept() })

const store = () => page.evaluate(() => window.__dshCanvasTest?.canvasStore ?? null)
if (!(await store())) { console.log('FATAL: canvasStore bridge missing'); process.exit(1) }

const originalId = await page.evaluate(() => window.__dshCanvasTest.canvasStore.currentCanvasId())
console.log('original current canvas:', originalId)

// throwaway canvas, reopen tab so it mounts
const tmpId = await page.evaluate(() => window.__dshCanvasTest.canvasStore.createCanvas('诊断临时 ' + Date.now().toString(36)).id)
await page.evaluate(() => window.__dshCanvasTest.closeActive())
await sleep(900)
await page.evaluate(() => window.__dshCanvasTest.open('canvas'))
for (let i = 0; i < 15; i++) { await sleep(800); if (await page.evaluate(() => !!window.__dshCanvasTest?.excalidraw)) break }
await sleep(3000)
const mountedId = await page.evaluate(() => window.__dshCanvasTest.canvasStore.currentCanvasId())
console.log('mounted canvas:', mountedId, mountedId === tmpId ? '(tmp OK)' : '(UNEXPECTED)')

const center = () => page.evaluate(() => {
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  return { x: c.x + c.width / 2, y: c.y + c.height / 2 }
})
const probeEditing = () => page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  const st = api.getAppState()
  return {
    editing: st.editingTextElement?.id ?? null,
    textarea: !!document.querySelector('.excalidraw textarea'),
    taFocus: document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement?.classList.contains('excalidraw-textEditor'),
    taClass: document.querySelector('.excalidraw textarea')?.className ?? null,
    hasFocus: document.hasFocus(),
    activeEl: document.activeElement?.tagName ?? null,
  }
})

console.log('\n--- A. baseline dblclick on tmp canvas ---')
await page.mouse.dblclick((await center()).x, (await center()).y)
await sleep(900)
console.log('after dblclick:', JSON.stringify(await probeEditing()))
await page.keyboard.press('Escape')
await sleep(400)

console.log('\n--- B. delete tmp canvas via real menu (confirm accepted) ---')
const btn = await page.evaluate(() => {
  const b = document.querySelector('[data-testid="main-menu-trigger"]')
  if (!b) return null
  const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
await page.mouse.click(btn.x, btn.y); await sleep(700)
const item = await page.evaluate(() => {
  const b = [...document.querySelectorAll('[role="menuitem"], button')].find((e) => e.textContent?.trim() === '删除当前画布' && e.offsetParent !== null)
  if (!b) return null
  const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
if (!item) { console.log('FATAL: 删除当前画布 item not visible'); process.exit(1) }
await page.mouse.click(item.x, item.y)
await sleep(1500)
console.log('current after delete:', await page.evaluate(() => window.__dshCanvasTest.canvasStore.currentCanvasId()))
await sleep(2500)

console.log('\n--- C. dblclick on remaining canvas ---')
await page.mouse.dblclick((await center()).x, (await center()).y)
await sleep(900)
console.log('after dblclick:', JSON.stringify(await probeEditing()))
await page.keyboard.press('Escape')
await sleep(300)

// restore: give focus back if lost, and report
await page.evaluate(() => { window.focus() })
await page.mouse.click(10, 10)
console.log('\nrestored current =', originalId, '(set only, tab left as-is)')
await page.evaluate((id) => window.__dshCanvasTest.canvasStore.setCurrentCanvasId(id), originalId)
await browser.close()
