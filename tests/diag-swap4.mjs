#!/usr/bin/env node
/** Diagnostic 4: pull the shell's combined client bundle and extract the
 * sidebar-right controller + panel-width persistence source. */
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
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

const out = await page.evaluate(async () => {
  const entry =
    [...document.scripts].map((s) => s.src).find((u) => u.includes('/assets/index-')) ??
    performance.getEntriesByType('resource').map((e) => e.name).find((u) => u.includes('/plugins/??'))
  if (!entry) return { error: 'bundle url not found', scripts: [...document.scripts].map((s) => s.src).slice(0, 20) }
  const res = await fetch(entry)
  const text = await res.text()

  const around = (needle, span = 1400, occurrence = 0) => {
    let idx = -1
    for (let i = 0; i <= occurrence; i++) idx = text.indexOf(needle, idx + 1)
    if (idx < 0) return null
    return text.slice(Math.max(0, idx - span / 2), idx + span / 2)
  }

  return {
    url: entry.slice(0, 120),
    total: text.length,
    noTabType: around('no tab type is registered', 2200),
    placeTab: around('placeTab(', 1600),
    rightbarWidth: [
      around('setRightbar', 1200),
      around('rightbarWidth', 1200),
      around('panelWidth', 1200),
      around('sidebarRightWidth', 1200),
    ].filter(Boolean),
    lsKeys: [...text.matchAll(/localStorage\.(?:get|set)Item\(\s*["']([^"']+)["']/g)].map((m) => m[1]).filter(
      (k) => /width|panel|right|sidebar|layout|dock|frame|size/i.test(k),
    ),
  }
})
console.log(JSON.stringify(out, null, 1))
await browser.close()
