#!/usr/bin/env node
/**
 * Live e2e for the L3 diagram op (needs debug host + NEW bundle):
 * one canvas_diagram command → auto-laid-out nodes + bound arrows + edge
 * labels in a single atomic updateScene; verified via /dsh-canvas/state.
 */
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().includes('dsh-app'))
await page.bringToFront()

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await page.evaluate(() => window.__dshCanvasTest?.open?.('canvas'))
await sleep(1200)
const canvasId = await page.evaluate(() => window.__dshCanvasTest?.canvasStore?.currentCanvasId?.())
const post = (body) =>
  page.evaluate(async (b) => {
    const res = await fetch('/dsh-canvas/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }, body)
const state = (id) =>
  page.evaluate(async (id) => (await fetch(`/dsh-canvas/state?canvasId=${encodeURIComponent(id)}`)).json(), canvasId)

const r = await post({ canvasId, ops: [{
  op: 'diagram',
  nodes: [
    { key: 'a', label: '开始' },
    { key: 'b', label: '处理节点' },
    { key: 'c', label: '结束', shape: 'diamond' },
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c', label: '完成' },
  ],
}] })
if (r.status === 405) { console.log('FATAL route not live — restart host'); process.exit(1) }
check('diagram accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r))
const { nodes, edges } = r.body ?? {}
check('node id map returned', nodes?.a?.id && nodes?.b?.id && nodes?.c?.id, JSON.stringify(nodes))
check('edge id map returned', edges?.['a→b']?.id && edges?.['b→c']?.id, JSON.stringify(edges))
check('labels wired', nodes?.a?.textId && edges?.['b→c']?.textId, JSON.stringify({ nodes, edges }))
await sleep(1800)

const s = await state(canvasId)
const texts = (s.texts ?? []).map((t) => t.text)
check('state: node labels present', ['开始', '处理节点', '结束'].every((t) => texts.includes(t)), JSON.stringify(texts))
const arrow = (s.arrows ?? []).find((x) => x.from === nodes.a.id && x.to === nodes.b.id)
const arrow2 = (s.arrows ?? []).find((x) => x.from === nodes.b.id && x.to === nodes.c.id)
check('state: both arrows bound', !!arrow && !!arrow2, JSON.stringify(s.arrows))
check('state: edge label present', (arrow2?.labels ?? []).includes('完成'), JSON.stringify(arrow2))
// layout: left→right layers (a left of b left of c)
const shapeOf = (id) => (s.shapes ?? []).find((sh) => sh.id === id)
const [sa, sb, sc] = [shapeOf(nodes.a.id), shapeOf(nodes.b.id), shapeOf(nodes.c.id)]
check('layout: layered left→right', sa && sb && sc && sa.x < sb.x && sb.x < sc.x, JSON.stringify([sa?.x, sb?.x, sc?.x]))

// cleanup
await post({ canvasId, ops: [{ op: 'delete', ids: Object.values(nodes).map((n) => n.id) }] })
await sleep(1200)

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
