/** Probe sidebar structure: filter input, grouping/collapse, virtualization. */
import { chromium } from 'playwright-core'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('dsh-app://'))
await page.bringToFront()
await sleep(500)

const info = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-row-key^="session:"]')]
  const out = { rowCount: rows.length }
  // the list container: closest common ancestor of rows
  out.rowSample = rows[0] ? { cls: rows[0].className.slice(0, 120), parentCls: rows[0].parentElement?.className.slice(0, 120) } : null
  // walk up from a row to find virtualization hints / aria / role=list
  let anc = []
  let n = rows[0]
  while (n && n !== document.body) {
    anc.push({ tag: n.tagName, role: n.getAttribute?.('role'), cls: (n.className || '').toString().slice(0, 80), virt: n.getAttribute?.('data-virtuoso-scroller') ?? (n.hasAttribute?.('data-test-virtuoso-item-list') ? 'virtuoso' : undefined) })
    n = n.parentElement
  }
  out.ancestors = anc.slice(0, 14)
  // inputs in the sidebar area
  const sidebar = rows[0]?.closest('[data-sidebar-left], [class*=sidebar], aside') ?? document
  out.inputs = [...sidebar.querySelectorAll('input')].map((i) => ({ ph: i.placeholder, type: i.type, cls: (i.className || '').slice(0, 60), aria: i.getAttribute('aria-label') }))
  // group headers / collapsible hints
  const heads = [...document.querySelectorAll('[role="button"], [class*=group], [class*=header], [class*=collapse], summary')]
    .filter((e) => /会话|session|分组|折叠|历史|置顶|收藏/i.test(e.textContent?.slice(0, 30) || '') && e.textContent.length < 40)
    .slice(0, 10)
  out.headers = heads.map((h) => ({ tag: h.tagName, text: h.textContent.trim().slice(0, 30), cls: (h.className || '').toString().slice(0, 60), expanded: h.getAttribute('aria-expanded') }))
  // data-row-key varieties (non-session rows tell us about groups)
  const allKeys = [...new Set([...document.querySelectorAll('[data-row-key]')].map((e) => e.getAttribute('data-row-key').split(':')[0]))]
  out.rowKeyKinds = allKeys
  return out
})
console.log(JSON.stringify(info, null, 1))
await browser.close()
