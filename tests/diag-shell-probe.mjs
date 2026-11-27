/** Probe: sessions service surface + native sidebar-row click behavior. */
import { chromium } from 'playwright-core'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('dsh-app://'))
await page.bringToFront()
await sleep(500)

const keys = await page.evaluate(() => {
  const s = window.__dshCanvasTest.sessions.raw
  const k = new Set()
  for (let o = s; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => k.add(n))
  return [...k]
})
console.log('sessions keys:', JSON.stringify(keys))

await page.evaluate(() => window.__dshCanvasTest.open('canvas'))
await sleep(2500)
console.log('canvas tab:', JSON.stringify(await page.evaluate(() => window.__dshCanvasTest.active?.() ?? null)))

const row = await page.evaluate(() => {
  const r = [...document.querySelectorAll('[data-row-key^="session:"]')][0]
  r.scrollIntoView({ block: 'center' })
  const b = r.getBoundingClientRect()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, id: r.getAttribute('data-row-key') }
})
await page.mouse.click(row.x, row.y)
await sleep(2500)
const after = await page.evaluate(() => ({
  activeTab: window.__dshCanvasTest.active?.() ?? null,
  activeRow: [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) => /active|selected|current/i.test(r.className))?.getAttribute('data-row-key') ?? null,
}))
console.log('after native row click:', JSON.stringify(after))
await browser.close()
