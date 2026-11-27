/** Inspect overflow rows and group layout; test expand. */
import { chromium } from 'playwright-core'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('dsh-app://'))
await page.bringToFront()
await sleep(500)
const r = await page.evaluate(() => {
  const before = document.querySelectorAll('[data-row-key^="session:"]').length
  const overflow = [...document.querySelectorAll('[data-row-key]')]
    .filter((e) => e.getAttribute('data-row-key').includes('overflow'))
    .map((e) => ({ k: e.getAttribute('data-row-key'), t: (e.textContent || '').trim().slice(0, 30) }))
  const groups = [...document.querySelectorAll('[class*="groupSection"]')].map((g) => ({
    t: (g.textContent || '').trim().slice(0, 14),
    rows: g.querySelectorAll('[data-row-key^="session:"]').length,
  }))
  return { before, overflow, groups }
})
console.log(JSON.stringify(r, null, 1))
// try expanding the first overflow row
const expanded = await page.evaluate(() => {
  const ov = [...document.querySelectorAll('[data-row-key]')].find((e) => e.getAttribute('data-row-key').includes('overflow'))
  if (!ov) return { clicked: false }
  ov.scrollIntoView({ block: 'center' })
  const b = ov.getBoundingClientRect()
  return { clicked: true, x: b.x + b.width / 2, y: b.y + b.height / 2 }
})
if (expanded.clicked) {
  const { mouse } = page
  await mouse.click(expanded.x, expanded.y)
  await sleep(1200)
  console.log('after expand:', await page.evaluate(() => document.querySelectorAll('[data-row-key^="session:"]').length))
}
await browser.close()
