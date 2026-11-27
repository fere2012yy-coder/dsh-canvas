#!/usr/bin/env node
/** Diagnostic 6: combined plugin bundle (sidebar-right controller) + AppFrame width source. */
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIST = [
  '@deepseek-ai/dsh-client-product-analytics',
  '@deepseek-ai/dsh-client-ui-open-in-app',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-job-controller',
  '@deepseek-ai/dsh-api-terminal-controller',
  '@deepseek-ai/dsh-api-workspace-files',
  '@deepseek-ai/dsh-client-ui-settings-account',
  '@deepseek-ai/dsh-client-hmr',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-client-ui-theme',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-ui-shortcuts',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-resources',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-sidebar-documentpreview',
  '@deepseek-ai/dsh-client-ui-sidebar-browser',
  '@deepseek-ai/dsh-client-ui-sidebar-terminal',
  '@deepseek-ai/dsh-client-ui-files',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-cordis',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-reference',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-client-ui-settings-session-log',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-shell',
  '@deepseek-ai/dsh-client-ui-settings-agent-loop',
  '@deepseek-ai/dsh-client-ui-settings-subagent',
  '@deepseek-ai/dsh-client-ui-settings-web-search',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-trajectory',
  'dsh-canvas',
]
  .map((n) => n + '/client.js')
  .join(',')

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

const out = await page.evaluate(async (combined) => {
  const around = (hay, needle, span = 1600, occurrence = 0) => {
    if (!hay) return null
    let idx = -1
    for (let i = 0; i <= occurrence; i++) idx = hay.indexOf(needle, idx + 1)
    if (idx < 0) return null
    return hay.slice(Math.max(0, idx - span / 2), idx + span / 2)
  }
  let plugin = null
  try {
    const res = await fetch(location.origin + '/plugins/??' + combined)
    plugin = { status: res.status, text: res.ok ? await res.text() : null }
  } catch (e) {
    plugin = { error: String(e) }
  }
  const mainSrc = [...document.scripts].map((s) => s.src).find((u) => u.includes('/assets/index-'))
  const main = await (await fetch(mainSrc)).text()

  return {
    plugin: plugin.text
      ? {
          total: plugin.text.length,
          noTabType: around(plugin.text, 'no tab type is registered', 2600),
          placeTabCtx: around(plugin.text, 'placeTab', 1400),
        }
      : plugin,
    appFrame: {
      gridTpl2: around(main, 'gridTemplateColumns', 2400, 1),
      gridTpl3: around(main, 'gridTemplateColumns', 1600, 2),
      total: main.length,
    },
  }
}, LIST)
console.log(JSON.stringify(out, null, 1))
writeFileSync(join(root, 'tests', 'out', 'diag6.json'), JSON.stringify(out, null, 1))
await browser.close()
