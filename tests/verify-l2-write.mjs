#!/usr/bin/env node
/**
 * Host-level L2 verification: mounts src/index.js with a fake ctx, then
 * drives the full command channel — canvas_write enqueue → /dsh-canvas/commands
 * pickup (a fake "client") → /dsh-canvas/command-result → tool resolves with
 * created ids. Also covers validation, expiry, stale-result rejection and the
 * read side (/dsh-canvas/sync + /dsh-canvas/state).
 */
import { Readable } from 'node:stream'

globalThis.require = () => ({})
const plugin = await import('../src/index.js')

const routes = new Map()
const tools = []
const effects = []
const fakeCtx = {
  logger: { info() {} },
  effect: (x) => {
    effects.push(x)
    if (typeof x === 'function') x() // route registrations are effect(() => register(...))
  },
  webServer: { register: (r) => routes.set(r.path, r.handler) },
  tools: { register: (t) => tools.push(t) },
}
plugin.apply(fakeCtx)

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const jsonRes = () => {
  const chunks = []
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(data) { if (data) chunks.push(data) },
    get body() { const s = Buffer.concat(chunks).toString('utf8'); return s ? JSON.parse(s) : null },
  }
}
const req = (bodyObj, origin = 'http://127.0.0.1:52318') => {
  const r = new Readable({ read() {} })
  if (bodyObj !== undefined) r.push(JSON.stringify(bodyObj))
  r.push(null)
  r.method = 'POST'
  r.headers = { origin }
  r.socket = { remoteAddress: '127.0.0.1' }
  return r
}
const getReq = (url) => {
  const r = new Readable({ read() {} })
  r.push(null)
  r.method = 'GET'
  r.url = url
  r.headers = {}
  r.socket = { remoteAddress: '127.0.0.1' }
  return r
}
const getRes = () => {
  const r = jsonRes()
  r.writeHead = r.writeHead.bind(r)
  return r
}

const tool = (n) => tools.find((t) => t.name === n)

// 0. routes + tools registered
check('routes registered', ['/dsh-canvas/sync', '/dsh-canvas/state', '/dsh-canvas/commands', '/dsh-canvas/command', '/dsh-canvas/command-result'].every((p) => routes.has(p)))
check('canvas_read + canvas_write registered', !!tool('canvas_read') && !!tool('canvas_write'))

// 1. push a scene so the mirror knows the canvas
let res = jsonRes()
await routes.get('/dsh-canvas/sync')(
  req({ canvasId: 'cv-test', name: '测试', elements: [{ id: 'src1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50, isDeleted: false }] }),
  res,
)
check('sync accepts scene', res.status === 204, `status=${res.status}`)

// 2. validation: bad op rejected before enqueue
const bad = await tool('canvas_write').execute({ canvasId: 'cv-test', ops: [{ op: 'teleport' }] })
check('bad op rejected', typeof bad.error === 'string' && /unknown op/.test(bad.error), JSON.stringify(bad))
{
  const r = getRes()
  const fakeReq = getReq('/dsh-canvas/commands?canvasId=cv-test&after=0')
  await routes.get('/dsh-canvas/commands')(fakeReq, r)
  check('bad op was NOT enqueued', r.body.commands.length === 0, JSON.stringify(r.body))
}

// 3. full round trip: write → client pickup → result → tool resolves
const writePromise = tool('canvas_write').execute({
  canvasId: 'cv-test',
  ops: [{ op: 'addNode', x: 10, y: 20, label: '开始' }],
})
await new Promise((r) => setTimeout(r, 50))
{
  const r = getRes()
  const fakeReq = getReq('/dsh-canvas/commands?canvasId=cv-test&after=0')
  await routes.get('/dsh-canvas/commands')(fakeReq, r)
  const cmds = r.body.commands
  check('client pickup returns 1 command', cmds.length === 1 && cmds[0].ops[0].op === 'addNode', JSON.stringify(r.body))
  const r2 = jsonRes()
  await routes.get('/dsh-canvas/command-result')(
    req({ canvasId: 'cv-test', commandId: cmds[0].commandId, ok: true, created: [{ id: 'node-x', textId: 'txt-x' }], nodes: { a: { id: 'node-x' } }, edges: { 'a→b': { id: 'e1' } } }),
    r2,
  )
  await new Promise((r) => setImmediate(r))
  check('result accepted', r2.status === 204, `status=${r2.status}`)
  // stale replay rejected
  const r3 = jsonRes()
  await routes.get('/dsh-canvas/command-result')(
    req({ canvasId: 'cv-test', commandId: cmds[0].commandId, ok: true, created: [{ id: 'evil' }] }),
    r3,
  )
  await new Promise((r) => setImmediate(r))
  check('stale result rejected (409)', r3.status === 409, `status=${r3.status}`)
}
const writeResult = await writePromise
check('tool resolves with created ids', writeResult.ok === true && writeResult.created?.[0]?.id === 'node-x', JSON.stringify(writeResult))
check('tool passes nodes/edges maps through', writeResult.nodes?.a?.id === 'node-x' && writeResult.edges?.['a→b']?.id === 'e1', JSON.stringify(writeResult))

// 4. second write with after-cursor filtering (client would only see new ones)
{
  const r = getRes()
  const after = 0 // cursor 0 already consumed; queue is empty anyway
  const fakeReq = getReq(`/dsh-canvas/commands?canvasId=cv-test&after=${after}`)
  await routes.get('/dsh-canvas/commands')(fakeReq, r)
  check('settled command removed from queue', r.body.commands.length === 0, JSON.stringify(r.body))
}

// 5. failure path: client reports an error → tool surfaces it
const failPromise = tool('canvas_write').execute({
  canvasId: 'cv-test',
  ops: [{ op: 'connect', fromId: 'a', toId: 'b' }],
})
await new Promise((r) => setTimeout(r, 50))
{
  const r = getRes()
  const fakeReq = getReq('/dsh-canvas/commands?canvasId=cv-test&after=0')
  await routes.get('/dsh-canvas/commands')(fakeReq, r)
  const cmds = r.body.commands
  const r2 = jsonRes()
  await routes.get('/dsh-canvas/command-result')(
    req({ canvasId: 'cv-test', commandId: cmds[0].commandId, ok: false, error: 'connect: fromId a not found' }),
    r2,
  )
}
const failResult = await failPromise
check('client error surfaced to tool', failResult.ok === false && /fromId a not found/.test(failResult.error), JSON.stringify(failResult))

// 6. canvas_write without canvasId when exactly one canvas known → uses it
const auto = await tool('canvas_write').execute({ ops: [{ op: 'delete', ids: ['nope'] }] })
check('implicit single canvas works', auto.ok === false && /not found|expired|timeout/.test(auto.error ?? ''), JSON.stringify(auto))
// (the fake client is gone for this one — ok:false via timeout/error is fine; just not "canvasId required")

// 7. read side still intact
const state = jsonRes()
{
  const fakeReq = getReq('/dsh-canvas/state?canvasId=cv-test')
  await routes.get('/dsh-canvas/state')(fakeReq, state)
}
check('state readback intact', state.body?.canvasId === 'cv-test' && state.body.shapes?.length === 1, JSON.stringify(state.body)?.slice(0, 200))

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
