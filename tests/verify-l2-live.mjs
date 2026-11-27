#!/usr/bin/env node
/**
 * Live e2e for the L2 write channel (requires a debug-launched desktop host
 * with the NEW plugin bundle: the client executor must be polling).
 *
 * Drives the real channel from inside the page (same-origin fetch — desktop
 * dsh-app:// forwards to the host webserver): POST /dsh-canvas/command → the
 * client executor executes on the live scene → /dsh-canvas/state readback
 * must reflect each op (addNode → connect → move → updateText → delete).
 */
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const ctx = browser.contexts()[0]
const page = ctx.pages().find((p) => p.url().includes('dsh-app')) ?? ctx.pages()[0]
await page.bringToFront()

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// open a canvas tab
const opened = await page.evaluate(async () => {
  window.__dshCanvasTest?.open?.('canvas')
  await new Promise((r) => setTimeout(r, 1200))
  return window.__dshCanvasTest?.active?.() ?? null
})
check('canvas tab open', !!opened, JSON.stringify(opened))
await sleep(1200) // let the executor mount & push

const inPage = (fn, arg) => page.evaluate(fn, arg)
const post = (body) =>
  inPage(async (b) => {
    const res = await fetch('/dsh-canvas/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    })
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }, body)
const state = (canvasId) =>
  inPage(async (id) => {
    const res = await fetch(`/dsh-canvas/state?canvasId=${encodeURIComponent(id)}`)
    return res.json()
  }, canvasId)

const canvasId = await inPage(() => window.__dshCanvasTest?.canvasStore?.currentCanvasId?.())
check('current canvas id', typeof canvasId === 'string', String(canvasId))

// pre-clean: drop arrows left dangling by earlier runs (endpoints gone)
{
  const s = await state(canvasId)
  const alive = new Set([...(s.shapes ?? []), ...(s.texts ?? [])].map((e) => e.id))
  const dangling = (s.arrows ?? []).filter((a) => !alive.has(a.from) || !alive.has(a.to)).map((a) => a.id)
  if (dangling.length) {
    await post({ canvasId, ops: [{ op: 'delete', ids: dangling }] })
    await sleep(1500)
    console.log(`pre-clean: removed ${dangling.length} dangling arrow(s)`)
  }
}

// 1. addNode (atomic batch of two nodes)
let r = await post({ canvasId, ops: [
  { op: 'addNode', x: 100, y: 100, label: 'L2开始' },
  { op: 'addNode', x: 400, y: 100, label: 'L2结束', shape: 'diamond' },
] })
if (r.status === 405) {
  console.log('FATAL /dsh-canvas/command route not live — restart the host with the rebuilt lib and rerun')
  process.exit(1)
}
check('addNode accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r))
let nodes = r.body?.created ?? []
check('addNode returns ids', nodes.length === 2 && nodes.every((n) => n.id && n.textId), JSON.stringify(nodes))
await sleep(1800)
{
  const s = await state(canvasId)
  const texts = (s.texts ?? []).map((t) => t.text)
  check('scene reflects added nodes', texts.includes('L2开始') && texts.includes('L2结束'), JSON.stringify(texts))
}

// 2. connect
r = await post({ canvasId, ops: [{ op: 'connect', fromId: nodes[0].id, toId: nodes[1].id, label: 'L2流转' }] })
check('connect accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r))
await sleep(1800)
{
  const s = await state(canvasId)
  const arrow = (s.arrows ?? []).find((a) => a.from === nodes[0].id && a.to === nodes[1].id)
  check('arrow bound & labeled', !!arrow && (arrow.labels ?? []).includes('L2流转'), JSON.stringify(s.arrows))
}

// 3. move
r = await post({ canvasId, ops: [{ op: 'move', id: nodes[1].id, x: 400, y: 400 }] })
check('move accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r))
await sleep(1800)
{
  const s = await state(canvasId)
  const moved = (s.shapes ?? []).find((sh) => sh.id === nodes[1].id)
  check('node moved', moved && moved.y > 350, JSON.stringify(s.shapes))
}

// 4. updateText
r = await post({ canvasId, ops: [{ op: 'updateText', id: nodes[0].id, text: 'L2改名' }] })
check('updateText accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r))
await sleep(1800)
{
  const s = await state(canvasId)
  const texts = (s.texts ?? []).map((t) => t.text)
  check('text updated', texts.includes('L2改名') && !texts.includes('L2开始'), JSON.stringify(texts))
}

// 5. delete both nodes (bound texts go along)
r = await post({ canvasId, ops: [{ op: 'delete', ids: nodes.map((n) => n.id) }] })
check('delete accepted', r.status === 200 && r.body.ok === true, JSON.stringify(r))
await sleep(1800)
{
  const s = await state(canvasId)
  const texts = (s.texts ?? []).map((t) => t.text)
  const ids = [...(s.shapes ?? []), ...(s.texts ?? [])].map((e) => e.id)
  check('nodes+texts gone', !texts.some((t) => t.startsWith('L2')) && !ids.includes(nodes[0].id), JSON.stringify({ texts, ids }))
  // cleanup stray arrow (its endpoints are deleted → drop it too)
  const arrow = (s.arrows ?? []).find((a) => a.from === nodes[0].id)
  if (arrow) await post({ canvasId, ops: [{ op: 'delete', ids: [arrow.id] }] })
}

// 6. error path: connect to a missing element → tool would surface the error
r = await post({ canvasId, ops: [{ op: 'connect', fromId: 'ghost', toId: nodes[0].id }] })
check('bad connect reported', r.status === 200 && r.body.ok === false && /not found/.test(r.body.error ?? ''), JSON.stringify(r))

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
