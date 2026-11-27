#!/usr/bin/env node
/** Acceptance: bind-mode UX — menu(创建会话/绑定会话/取消绑定) → 绑定会话
 * enters bind mode (hint bar, no picker) → sidebar row click binds. */
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

await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  api.updateScene({ appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 } })
  api.updateScene({
    elements: [
      ...api.getSceneElementsIncludingDeleted(),
      ...window.__dshCanvasTest.exHelpers.convertToExcalidrawElements([
        { type: 'rectangle', x: -80, y: -42, width: 160, height: 84 },
      ]),
    ],
  })
})
await sleep(800)
const pt = await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  const { zoom, scrollX, scrollY } = api.getAppState()
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  return { x: c.left + scrollX * zoom.value, y: c.top + scrollY * zoom.value }
})

// 1. menu with the three items (retry loop: fresh-mount/initialData races)
let menu = null
for (let attempt = 0; attempt < 6 && !menu?.create; attempt++) {
  await page.mouse.click(10, 500)
  await sleep(400)
  const pt = await page.evaluate(() => {
    const api = window.__dshCanvasTest.excalidraw
    const st = api.getAppState()
    if (!st?.zoom || !Number.isFinite(st.scrollX)) return null
    const c = document.querySelector('canvas.excalidraw__canvas.interactive')?.getBoundingClientRect()
    if (!c) return null
    return { x: c.left + (0 + st.scrollX) * st.zoom.value + 5, y: c.top + (0 + st.scrollY) * st.zoom.value + 5 }
  })
  if (!pt) { await sleep(1000); continue }
  await page.keyboard.down('Control')
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await page.keyboard.up('Control')
  await sleep(700)
  menu = await page.evaluate(() => {
    const t = (s) => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === s)
    return { create: t('创建会话'), bind: t('绑定会话'), unbind: t('取消绑定'), pickerInput: !!document.querySelector('input[placeholder="搜索会话…"]') }
  })
}
check('menu shows 创建会话+绑定会话, no old picker', !!menu?.create && !!menu?.bind && !menu.pickerInput, JSON.stringify(menu))

// 2. click 绑定会话 → bind mode hint, no picker menu
await page.evaluate(() => { [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '绑定会话')?.click() })
await sleep(500)
const mode = await page.evaluate(() => {
  const hint = [...document.querySelectorAll('div')].some((d) => d.textContent?.includes('绑定模式：在左侧会话列表点击要绑定的会话') && d.children.length === 0)
  const cursor = getComputedStyle(document.querySelector('.excalidraw')?.closest('div') ?? document.body).cursor
  return { hint, cursorHasSvg: cursor.includes('svg') || cursor === 'crosshair' }
})
check('bind mode hint shown, no picker', mode.hint, JSON.stringify(mode))

// 3. click a sidebar session row → binds
const rowCount = await page.evaluate(() => [...document.querySelectorAll('[data-row-key^="session:"]')].length)
check('sidebar rows available', rowCount > 0, `rows=${rowCount}`)
const rowBox = await page.evaluate(() => {
  const row = [...document.querySelectorAll('[data-row-key^="session:"]')][0]
  row.scrollIntoView({ block: 'center' })
  const r = row.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: row.getAttribute('data-row-key').slice('session:'.length) }
})
await page.mouse.click(rowBox.x, rowBox.y)
await sleep(800)
const res = await page.evaluate(() => ({
  link: window.__dshCanvasTest.excalidraw.getSceneElements().find((e) => e.type === 'rectangle')?.link ?? null,
  hintGone: ![...document.querySelectorAll('div')].some((d) => d.textContent?.includes('绑定模式：在左侧会话列表点击要绑定的会话') && d.children.length === 0),
  toast: [...document.querySelectorAll('div')].some((d) => d.textContent?.trim() === '已绑定 ✓' && d.children.length === 0),
}))
check('row click writes dsh-session:// link', res.link === 'dsh-session://' + rowBox.id, `${res.link}`)
check('bind mode exited (hint gone + toast)', res.hintGone && res.toast, JSON.stringify({ hintGone: res.hintGone, toast: res.toast }))

// cleanup tmp canvas
await page.evaluate((id) => window.__dshCanvasTest.canvasStore.deleteCanvas(id), tmpId)
await page.evaluate((id) => window.__dshCanvasTest.canvasStore.setCurrentCanvasId(id), originalId)
await browser.close()
