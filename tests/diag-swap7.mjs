#!/usr/bin/env node
/** Diagnostic 7: fetch the exact combined plugin bundle URL from the last
 * openTab error stack, extract ui-layout width logic + sidebar-right errors. */
import { chromium } from 'playwright-core'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Verbatim from the SidebarRightController stack trace (openTab failure).
const EXACT_URL =
  '/plugins/??@deepseek-ai/dsh-client-product-analytics/client.js,@deepseek-ai/dsh-client-ui-open-in-app/client.js,@deepseek-ai/dsh-api-gateway/client.js,@deepseek-ai/dsh-api-job-controller/client.js,@deepseek-ai/dsh-api-terminal-controller/client.js,@deepseek-ai/dsh-api-workspace-files/client.js,@deepseek-ai/dsh-client-ui-settings-account/client.js,@deepseek-ai/dsh-client-hmr/client.js,@deepseek-ai/dsh-cordis-client-runner/client.js,@deepseek-ai/dsh-client-ui-theme/client.js,@deepseek-ai/dsh-client-locale/client.js,@deepseek-ai/dsh-client-shortcuts/client.js,@deepseek-ai/dsh-client-ui-shortcuts/client.js,@deepseek-ai/dsh-client-ui-layout/client.js,@deepseek-ai/dsh-client-ui-renderer/client.js,@deepseek-ai/dsh-client-ui-session/client.js,@deepseek-ai/dsh-client-resources/client.js,@deepseek-ai/dsh-client-ui-sidebar/client.js,@deepseek-ai/dsh-client-ui-sidebar-right/client.js,@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client.js,@deepseek-ai/dsh-client-ui-sidebar-browser/client.js,@deepseek-ai/dsh-client-ui-sidebar-terminal/client.js,@deepseek-ai/dsh-client-ui-files/client.js,@deepseek-ai/dsh-client-ui-settings/client.js,@deepseek-ai/dsh-client-ui-settings-general/client.js,@deepseek-ai/dsh-client-ui-plugin-manager/client.js,@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client.js,@deepseek-ai/dsh-client-ui-conversation/client.js,@deepseek-ai/dsh-client-ui-approval/client.js,@deepseek-ai/dsh-client-ui-chat/client.js,@deepseek-ai/dsh-client-ui-brand-official/client.js,@deepseek-ai/dsh-client-ui-attachment/client.js,@deepseek-ai/dsh-client-ui-tool/client.js,@deepseek-ai/dsh-client-ui-cordis/client.js,@deepseek-ai/dsh-client-ui-workspace/client.js,@deepseek-ai/dsh-client-ui-workflow-run/client.js,@deepseek-ai/dsh-client-ui-input-trigger/client.js,@deepseek-ai/dsh-client-ui-commands/client.js,@deepseek-ai/dsh-client-ui-skill/client.js,@deepseek-ai/dsh-client-ui-subagent/client.js,@deepseek-ai/dsh-client-ui-reference/client.js,@deepseek-ai/dsh-client-ui-jobs/client.js,@deepseek-ai/dsh-client-ui-goal/client.js,@deepseek-ai/dsh-client-ui-message-feedback/client.js,@deepseek-ai/dsh-client-ui-model-selection/client.js,@deepseek-ai/dsh-client-ui-permission-presets/client.js,@deepseek-ai/dsh-client-ui-settings-session-log/client.js,@deepseek-ai/dsh-client-ui-settings-plugins/client.js,@deepseek-ai/dsh-client-ui-settings-shell/client.js,@deepseek-ai/dsh-client-ui-settings-agent-loop/client.js,@deepseek-ai/dsh-client-ui-settings-subagent/client.js,@deepseek-ai/dsh-client-ui-settings-web-search/client.js,@deepseek-ai/dsh-client-ui-plan/client.js,@deepseek-ai/dsh-client-ui-user-questions/client.js,@deepseek-ai/dsh-client-ui-trajectory/client.js,dsh-canvas/client.js'

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

const result = await page.evaluate(async (path) => {
  const around = (hay, needle, span = 1600, occurrence = 0) => {
    if (!hay) return null
    let idx = -1
    for (let i = 0; i <= occurrence; i++) idx = hay.indexOf(needle, idx + 1)
    if (idx < 0) return null
    return hay.slice(Math.max(0, idx - span / 2), idx + span / 2)
  }
  const tries = []
  for (const suffix of ['', '&rev=900e1d8d7aa1']) {
    try {
      const res = await fetch(location.origin + path + suffix)
      tries.push({ suffix, status: res.status })
      if (res.ok) {
        const text = await res.text()
        return {
          ok: true,
          total: text.length,
          noTabType: around(text, 'no tab type is registered', 2600),
          layoutWidth: [
            around(text, 'grid-template-columns', 2200, 0),
            around(text, 'gridTemplateColumns', 2200, 0),
          ].filter(Boolean),
          rightbarPx: around(text, 'setRightbar', 1600) ?? around(text, 'rightbarWidth', 1600),
        }
      }
    } catch (e) {
      tries.push({ suffix, error: String(e).slice(0, 100) })
    }
  }
  return { ok: false, tries }
}, EXACT_URL)
console.log(JSON.stringify(result, null, 1))
writeFileSync(join(root, 'tests', 'out', 'diag7.json'), JSON.stringify(result, null, 1))
await browser.close()
