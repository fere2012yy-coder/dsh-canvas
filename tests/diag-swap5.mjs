#!/usr/bin/env node
/** Diagnostic 5: sidebar-right plugin client + dockkit width persistence source. */
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
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
  const base = location.origin
  const candidates = [
    '/plugins/@deepseek-ai/dsh-client-ui-sidebar-right/client.js',
    '/plugins/??@deepseek-ai/dsh-client-ui-sidebar-right/client.js',
  ]
  let text = null
  let usedUrl = null
  for (const c of candidates) {
    try {
      const res = await fetch(base + c)
      if (res.ok) {
        text = await res.text()
        usedUrl = c
        break
      }
    } catch (e) {}
  }

  const around = (hay, needle, span = 1600, occurrence = 0) => {
    if (!hay) return null
    let idx = -1
    for (let i = 0; i <= occurrence; i++) idx = hay.indexOf(needle, idx + 1)
    if (idx < 0) return null
    return hay.slice(Math.max(0, idx - span / 2), idx + span / 2)
  }

  // Main app bundle: how the frame grid columns are computed & persisted
  const main = await (await fetch(base + '/assets/index-' + (/index-([A-Za-z0-9_-]+)\.js/.exec([...document.scripts].map((s) => s.src).join(''))?.[1] ?? '') + '.js')).text()

  return {
    pluginClient: text
      ? {
          url: usedUrl,
          total: text.length,
          noTabType: around(text, 'no tab type is registered', 2400),
          registerType: around(text, 'registerTabType', 1200) ?? around(text, 'tabTypes', 1000),
        }
      : { error: 'all candidate urls failed' },
    mainBundle: {
      gridTpl: around(main, 'gridTemplateColumns', 2000, 0),
      gridTplCount: (main.match(/gridTemplateColumns/g) ?? []).length,
      dockPersist: around(main, 'dockkit', 1000, 0),
      lsSetKeys: [...main.matchAll(/localStorage\.setItem\(\s*["']([^"']{3,60})["']/g)].map((m) => m[1]).slice(0, 30),
    },
  }
})
console.log(JSON.stringify(out, null, 1))
writeFileSync(join(root, 'tests', 'out', 'diag5.json'), JSON.stringify(out, null, 1))
await browser.close()
