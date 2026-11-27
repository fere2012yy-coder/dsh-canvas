/** Acceptance v2: click-bound-block = select session in sidebar (penetrating
 * filter/overflow), and 创建会话 = native 新建会话 + auto-bind. */
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

// create block at scene origin and bind to the currently-active session row via bind-mode
await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  api.updateScene({ appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 } })
})
await sleep(300)
await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
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

// switch sidebar to a KNOWN session (first row), remember its id
const firstRow = await page.evaluate(() => {
  const r = [...document.querySelectorAll('[data-row-key^="session:"]')][0]
  r.click()
  return r.getAttribute('data-row-key').slice('session:'.length)
})
await sleep(1000)
console.log('target session:', firstRow)

// bind: ctrl+right-click block → 绑定会话 → click that row
const pt = await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  const st = api.getAppState()
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  return { x: c.left + (0 + st.scrollX) * st.zoom.value + 5, y: c.top + (0 + st.scrollY) * st.zoom.value + 5 }
})
let bound = false
for (let i = 0; i < 5 && !bound; i++) {
  await page.keyboard.down('Control')
  await page.mouse.click(pt.x, pt.y, { button: 'right' })
  await page.keyboard.up('Control')
  await sleep(600)
  bound = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '绑定会话')
    if (!b) return false
    b.click()
    return true
  })
  if (!bound) await sleep(800)
}
check('bind menu → 绑定会话 clicked', bound)
const rowPt = await page.evaluate((sid) => {
  const r = [...document.querySelectorAll('[data-row-key^="session:"]')].find((x) => x.getAttribute('data-row-key') === 'session:' + sid)
  if (!r) return null
  r.scrollIntoView({ block: 'center' })
  const b = r.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}, firstRow)
await page.mouse.click(rowPt.x, rowPt.y)
await sleep(800)
const link = await page.evaluate(() => window.__dshCanvasTest.excalidraw.getSceneElements().find((e) => e.type === 'rectangle')?.link ?? null)
check('block bound to session', link === 'dsh-session://' + firstRow, String(link))

// switch sidebar to a DIFFERENT session so the click test is meaningful
await page.evaluate(() => {
  const r = [...document.querySelectorAll('[data-row-key^="session:"]')].find((x) => x.getAttribute('data-row-key') !== 'session:' + firstRow)
  r?.click()
})
await sleep(800)

// A. plain click on block → sidebar selects bound session, canvas tab alive
await page.mouse.click(pt.x, pt.y)
await sleep(1500)
const a = await page.evaluate((sid) => ({
  activeRow: [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => /active|selected|current/i.test(r.className))?.getAttribute('data-row-key') ?? null,
  tab: window.__dshCanvasTest.active?.() ?? null,
}), firstRow)
check('A single click selects bound session', a.activeRow === 'session:' + firstRow, JSON.stringify(a.activeRow))
check('A canvas tab stays open', a.tab?.kind === 'canvas', JSON.stringify(a.tab))

// B. penetration: hide the row behind a search filter, then click the block
await page.evaluate(() => {
  const input = document.querySelector('input[placeholder="搜索会话名称"]')
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(input, '绝对不存在的过滤词XYZ')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(800)
const hidden = await page.evaluate((sid) => ![...document.querySelectorAll('[data-row-key^="session:"]')].some((r) => r.getAttribute('data-row-key') === 'session:' + sid), firstRow)
check('B row hidden by filter (precondition)', hidden)
await page.mouse.click(pt.x, pt.y)
await sleep(2500)
const bRes = await page.evaluate((sid) => ({
  activeRow: [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => /active|selected|current/i.test(r.className))?.getAttribute('data-row-key') ?? null,
  query: document.querySelector('input[placeholder="搜索会话名称"]')?.value ?? null,
  tab: window.__dshCanvasTest.active?.() ?? null,
}), firstRow)
check('B penetrated filter and selected', bRes.activeRow === 'session:' + firstRow, JSON.stringify(bRes.activeRow))
check('B search query restored', bRes.query === '绝对不存在的过滤词XYZ', JSON.stringify(bRes.query))
check('B canvas tab still open', bRes.tab?.kind === 'canvas')
// restore filter to empty for later steps
await page.evaluate(() => {
  const input = document.querySelector('input[placeholder="搜索会话名称"]')
  const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  set.call(input, '')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
await sleep(600)

// C. 创建会话 → native button + auto-bind
await page.keyboard.down('Control')
await page.mouse.click(pt.x, pt.y, { button: 'right' })
await page.keyboard.up('Control')
await sleep(600)
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '创建会话')
  if (!b) return false
  b.click()
  return true
})
check('C menu 创建会话 clicked', clicked)
let cRes = null
for (let i = 0; i < 20; i++) {
  await sleep(500)
  cRes = await page.evaluate(() => ({
    link: window.__dshCanvasTest.excalidraw.getSceneElements().find((e) => e.type === 'rectangle')?.link ?? null,
    tab: window.__dshCanvasTest.active?.() ?? null,
  }))
  if (cRes.link && cRes.link !== 'dsh-session://' + firstRow) break
}
check('C new session bound to block', !!cRes?.link && cRes.link.startsWith('dsh-session://session-') && cRes.link !== 'dsh-session://' + firstRow, String(cRes?.link))
check('C canvas tab still open', cRes?.tab?.kind === 'canvas', JSON.stringify(cRes?.tab))

// cleanup: delete tmp canvas, keep the created session (user's env gains one empty session — reported)
await page.evaluate((id) => window.__dshCanvasTest.canvasStore.deleteCanvas(id), tmpId)
await page.evaluate((id) => window.__dshCanvasTest.canvasStore.setCurrentCanvasId(id), originalId)
await browser.close()
