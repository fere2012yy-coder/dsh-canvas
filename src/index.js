// dsh-canvas host half — agent-facing read side of the canvas plugin.
//
// The browser half (lib/client.js) owns the Excalidraw scene and persists it
// to localStorage. Every debounced save ALSO pushes the scene JSON to this
// half's /dsh-canvas/sync route (same-origin fetch in web mode; the desktop
// carrier forwards non-static dsh-app://app requests to the host webserver,
// so the same relative URL works there). This half keeps an in-memory mirror
// per canvas, appends changed snapshots to a JSONL history log, and exposes
// the canvas_read tool so agents can inspect the canvas structurally:
// text blocks, arrow bindings (A → B), and group memberships.
//
// Read-only by design: nothing here mutates the scene.
import { appendFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-canvas'
// Static injection: the fiber waits for both services, so apply() runs at a
// deterministic point (a dynamic ctx.inject callback can race service startup
// and never fire — observed on the desktop host).
export const inject = ['tools', 'webServer']

/** Allowed fetch origins: web GUI loopback pages and the desktop app frame. */
const ALLOWED_ORIGIN_PREFIXES = ['http://127.0.0.1:', 'http://localhost:']
const ALLOWED_ORIGINS = new Set(['dsh-app://app'])
const ALLOWED_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** canvasId → { name, elements, appState, hash, updatedAt, receivedAt } */
const mirror = new Map()

const historyDir = () => join(homedir(), '.dsh', 'dsh-canvas', 'history')

function originAllowed(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true // same-origin GET-ish or non-browser
  if (ALLOWED_ORIGINS.has(origin)) return true
  return ALLOWED_ORIGIN_PREFIXES.some((p) => origin.startsWith(p))
}

function readBody(req, limitBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, body, type = 'application/json') {
  const data = body === null ? null : Buffer.from(body)
  res.writeHead(status, {
    ...(data ? { 'content-type': type, 'content-length': data.length } : {}),
  })
  res.end(data)
}

/** Structural summary of one scene: shapes/texts, arrows with bindings, groups. */
function summarizeScene(canvasId, snap) {
  const elements = (snap.elements ?? []).filter((e) => !e.isDeleted)
  const byId = new Map(elements.map((e) => [e.id, e]))
  const texts = []
  const shapes = []
  const arrows = []
  const lines = []
  const groupMap = new Map()
  for (const e of elements) {
    const base = {
      id: e.id,
      type: e.type,
      x: Math.round(e.x ?? 0),
      y: Math.round(e.y ?? 0),
      width: Math.round(e.width ?? 0),
      height: Math.round(e.height ?? 0),
    }
    if (e.type === 'text') {
      texts.push({
        ...base,
        text: e.text ?? '',
        fontSize: e.fontSize,
        ...(e.containerId ? { containerId: e.containerId } : {}),
      })
    } else if (e.type === 'arrow' || e.type === 'line') {
      const from = e.startBinding?.elementId ?? null
      const to = e.endBinding?.elementId ?? null
      const labelIds = (e.label?.labelIds ?? []).length
        ? e.label.labelIds
        : elements.filter((t) => t.containerId === e.id).map((t) => t.id)
      const labels = labelIds
        .map((id) => byId.get(id)?.text)
        .filter((t) => t !== undefined)
      const record = {
        ...base,
        from,
        to,
        fromText: from ? (byId.get(from) ? labelOf(byId.get(from)) : null) : null,
        toText: to ? (byId.get(to) ? labelOf(byId.get(to)) : null) : null,
        ...(labels.length ? { labels } : {}),
      }
      if (e.type === 'arrow') arrows.push(record)
      else lines.push(record)
    } else {
      const boundText = elements.find((t) => t.containerId === e.id)?.text
      shapes.push({
        ...base,
        ...(typeof boundText === 'string' ? { text: boundText } : {}),
      })
    }
    for (const gid of e.groupIds ?? []) {
      if (!groupMap.has(gid)) groupMap.set(gid, [])
      groupMap.get(gid).push(e.id)
    }
  }
  return {
    canvasId,
    name: snap.name ?? null,
    updatedAt: new Date(snap.updatedAt).toISOString(),
    elementCount: elements.length,
    texts,
    shapes,
    arrows,
    lines,
    groups: [...groupMap.entries()].map(([groupId, memberIds]) => ({
      groupId,
      memberIds,
    })),
  }
}

/** Best-effort human label of an element: its own or bound text, else type+id. */
function labelOf(e) {
  if (e.type === 'text' && e.text) return e.text
  return `${e.type}:${e.id.slice(0, 8)}`
}

// ---------------------------------------------------------------------------
// Write channel (L2): the canvas_write tool enqueues ops; the mounted canvas
// tab polls /dsh-canvas/commands, executes them against the live Excalidraw
// scene and posts the outcome to /dsh-canvas/command-result; the tool awaits
// that outcome so the model gets the created element ids (or a precise
// error). Commands expire if no client picks them up in time — a closed tab
 // can never cause a surprise execution hours later.
// ---------------------------------------------------------------------------
let seqCounter = 0
const QUEUE_TTL_MS = 30_000
const RESULT_TTL_MS = 5 * 60_000
const queues = new Map() // canvasId → [{ seq, commandId, ops, enqueuedAt }]
const results = new Map() // commandId → result payload (kept for waiters+audit)
const waiters = new Map() // commandId → resolve(result)

function queueOf(canvasId) {
  let q = queues.get(canvasId)
  if (!q) queues.set(canvasId, (q = []))
  return q
}

function enqueueCommand(canvasId, ops) {
  const commandId = `cmd-${++seqCounter}-${Math.random().toString(36).slice(2, 8)}`
  queueOf(canvasId).push({ seq: seqCounter, commandId, ops, enqueuedAt: Date.now() })
  return commandId
}

/** Drop TTL-expired pending commands (marking them failed for waiters). */
function pruneQueue(canvasId) {
  const q = queues.get(canvasId)
  if (!q) return
  const now = Date.now()
  for (let i = q.length - 1; i >= 0; i--) {
    if (now - q[i].enqueuedAt > QUEUE_TTL_MS) {
      const { commandId } = q[i]
      q.splice(i, 1)
      settle(commandId, { ok: false, error: 'command expired — no canvas tab picked it up within 30s' })
    }
  }
}

function settle(commandId, payload) {
  payload.finishedAt = Date.now()
  results.set(commandId, payload)
  const waiter = waiters.get(commandId)
  if (waiter) {
    waiters.delete(commandId)
    waiter(payload)
  }
}

/** Known-op whitelist with per-op field validation (host-side gate only —
 * the client executor re-validates against the live scene). */
function validateOps(ops) {
  if (!Array.isArray(ops) || ops.length === 0) return 'ops must be a non-empty array'
  for (const op of ops) {
    if (typeof op !== 'object' || op === null) return 'each op must be an object'
    const num = (v) => typeof v === 'number' && Number.isFinite(v)
    switch (op.op) {
      case 'addNode':
        if (!num(op.x) || !num(op.y)) return 'addNode needs numeric x/y'
        if (op.label !== undefined && typeof op.label !== 'string') return 'addNode label must be a string'
        if (op.shape !== undefined && !['rectangle', 'ellipse', 'diamond'].includes(op.shape)) return 'addNode shape must be rectangle|ellipse|diamond'
        break
      case 'connect':
        if (typeof op.fromId !== 'string' || typeof op.toId !== 'string') return 'connect needs fromId/toId'
        break
      case 'move':
        if (typeof op.id !== 'string' || !num(op.x) || !num(op.y)) return 'move needs id + numeric x/y'
        break
      case 'updateText':
        if (typeof op.id !== 'string' || typeof op.text !== 'string') return 'updateText needs id + text'
        break
      case 'delete':
        if (!Array.isArray(op.ids) || !op.ids.every((i) => typeof i === 'string')) return 'delete needs ids: string[]'
        break
      case 'diagram': {
        if (!Array.isArray(op.nodes) || !op.nodes.length) return 'diagram needs nodes: non-empty array'
        for (const n of op.nodes) {
          if (typeof n?.key !== 'string' || typeof n?.label !== 'string') return 'diagram node needs key + label'
          if (n.shape !== undefined && !['rectangle', 'ellipse', 'diamond'].includes(n.shape)) return 'diagram node shape must be rectangle|ellipse|diamond'
        }
        if (op.edges !== undefined) {
          if (!Array.isArray(op.edges)) return 'diagram edges must be an array'
          for (const e of op.edges) {
            if (typeof e?.from !== 'string' || typeof e?.to !== 'string') return 'diagram edge needs from/to (node keys)'
            if (e.label !== undefined && typeof e.label !== 'string') return 'diagram edge label must be a string'
          }
        }
        break
      }
      default:
        return `unknown op ${JSON.stringify(op.op)}`
    }
  }
  return null
}

async function appendHistory(canvasId, snap) {
  try {
    const dir = historyDir()
    await mkdir(dir, { recursive: true })
    const line =
      JSON.stringify({
        ts: snap.updatedAt,
        hash: snap.hash,
        elementCount: (snap.elements ?? []).length,
        elements: snap.elements,
        appState: snap.appState ?? null,
      }) + '\n'
    await appendFile(join(dir, `${canvasId}.jsonl`), line, 'utf8')
  } catch (error) {
    // History is best-effort; the in-memory mirror stays the read source.
    console.warn(`dsh-canvas: history append failed: ${error.message}`)
  }
}

export function apply(ctx) {
  ctx.logger?.info?.('dsh-canvas host half mounted')

  // The webserver is injected statically, so it is live here. Register the
  // two named routes directly (no nesting, no race).
  const server = ctx.webServer
  try {
    const d1 = server.register({
        kind: 'exact',
        path: '/dsh-canvas/sync',
        handler: async (req, res) => {
          try {
            const ip = req.socket.remoteAddress ?? ''
            if (!ALLOWED_IPS.has(ip) || !originAllowed(req)) {
              return send(res, 403, JSON.stringify({ error: 'forbidden' }))
            }
            if (req.method !== 'POST') {
              return send(res, 405, JSON.stringify({ error: 'post only' }))
            }
            const body = JSON.parse(await readBody(req))
            const canvasId = typeof body?.canvasId === 'string' ? body.canvasId : null
            if (!canvasId || !/^[\w-]{1,128}$/.test(canvasId) || !Array.isArray(body.elements)) {
              return send(res, 400, JSON.stringify({ error: 'bad payload' }))
            }
            const hash = createHash('sha256')
              .update(JSON.stringify(body.elements))
              .digest('hex')
              .slice(0, 16)
            const prev = mirror.get(canvasId)
            const snap = {
              name: typeof body.name === 'string' ? body.name : (prev?.name ?? null),
              elements: body.elements,
              appState: body.appState ?? null,
              hash,
              updatedAt: Date.now(),
              receivedAt: Date.now(),
            }
            mirror.set(canvasId, snap)
            if (prev?.hash !== hash) await appendHistory(canvasId, snap)
            return send(res, 204, null)
          } catch (error) {
            return send(res, 400, JSON.stringify({ error: String(error?.message ?? error) }))
          }
        },
      })
      ctx.effect(() => d1)
    } catch (error) {
      console.error('[dsh-canvas] sync route registration FAILED:', error?.message)
    }
    // Read-back endpoint (loopback only): lets any local process — including
    // verification scripts — inspect the mirror without model round-trips.
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-canvas/state',
        handler: (req, res) => {
          try {
            const ip = req.socket.remoteAddress ?? ''
            if (!ALLOWED_IPS.has(ip) || !originAllowed(req)) {
              return send(res, 403, JSON.stringify({ error: 'forbidden' }))
            }
            if (req.method !== 'GET') {
              return send(res, 405, JSON.stringify({ error: 'get only' }))
            }
            const url = new URL(req.url, 'http://localhost')
            const canvasId = url.searchParams.get('canvasId')
            if (canvasId) {
              const snap = mirror.get(canvasId)
              if (!snap) return send(res, 404, JSON.stringify({ error: 'unknown canvas' }))
              return send(res, 200, JSON.stringify(summarizeScene(canvasId, snap)))
            }
            const canvases = [...mirror.entries()].map(([id, s]) => ({
              canvasId: id,
              name: s.name,
              updatedAt: new Date(s.updatedAt).toISOString(),
              elementCount: (s.elements ?? []).length,
            }))
            return send(
              res,
              200,
              JSON.stringify({ canvases, receivedAt: new Date().toISOString() }),
            )
          } catch (error) {
            return send(res, 500, JSON.stringify({ error: String(error?.message ?? error) }))
          }
        },
      }),
    )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-canvas/commands',
      handler: (req, res) => {
        try {
          const ip = req.socket.remoteAddress ?? ''
          if (!ALLOWED_IPS.has(ip) || !originAllowed(req)) {
            return send(res, 403, JSON.stringify({ error: 'forbidden' }))
          }
          if (req.method !== 'GET') {
            return send(res, 405, JSON.stringify({ error: 'get only' }))
          }
          const url = new URL(req.url, 'http://localhost')
          const canvasId = url.searchParams.get('canvasId')
          const after = Number(url.searchParams.get('after') ?? 0)
          if (!canvasId || !/^[\w-]{1,128}$/.test(canvasId)) {
            return send(res, 400, JSON.stringify({ error: 'bad canvasId' }))
          }
          pruneQueue(canvasId)
          const commands = queueOf(canvasId)
            .filter((c) => c.seq > (Number.isFinite(after) ? after : 0))
            .map(({ seq, commandId, ops }) => ({ seq, commandId, ops }))
          return send(res, 200, JSON.stringify({ commands }))
        } catch (error) {
          return send(res, 500, JSON.stringify({ error: String(error?.message ?? error) }))
        }
      },
    }),
  )

  // HTTP alias of the canvas_write tool (same queue, same waiter) — lets
  // external scripts drive the channel without a model round-trip.
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-canvas/command',
      handler: (req, res) => {
        try {
          const ip = req.socket.remoteAddress ?? ''
          if (!ALLOWED_IPS.has(ip) || !originAllowed(req)) {
            return send(res, 403, JSON.stringify({ error: 'forbidden' }))
          }
          if (req.method !== 'POST') {
            return send(res, 405, JSON.stringify({ error: 'post only' }))
          }
        } catch (error) {
          return send(res, 500, JSON.stringify({ error: String(error?.message ?? error) }))
        }
        readBody(req)
          .then(async (raw) => {
            const body = JSON.parse(raw)
            let canvasId = body?.canvasId
            if (!canvasId) {
              const ids = [...mirror.keys()]
              if (ids.length === 1) canvasId = ids[0]
            }
            if (!canvasId || !/^[\w-]{1,128}$/.test(canvasId)) {
              return send(res, 400, JSON.stringify({ error: 'bad canvasId' }))
            }
            const invalid = validateOps(body.ops)
            if (invalid) return send(res, 400, JSON.stringify({ error: invalid }))
            const commandId = enqueueCommand(canvasId, body.ops)
            const payload = await new Promise((resolve) => {
              const timer = setTimeout(() => {
                waiters.delete(commandId)
                resolve({ ok: false, error: 'timeout — is the canvas tab open?' })
              }, 8000)
              waiters.set(commandId, (result) => {
                clearTimeout(timer)
                resolve(result)
              })
            })
            return send(res, 200, JSON.stringify({ commandId, ...payload }))
          })
          .catch((error) => send(res, 400, JSON.stringify({ error: String(error?.message ?? error) })))
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-canvas/command-result',
      handler: (req, res) => {
        try {
          const ip = req.socket.remoteAddress ?? ''
          if (!ALLOWED_IPS.has(ip) || !originAllowed(req)) {
            return send(res, 403, JSON.stringify({ error: 'forbidden' }))
          }
          if (req.method !== 'POST') {
            return send(res, 405, JSON.stringify({ error: 'post only' }))
          }
        } catch (error) {
          return send(res, 500, JSON.stringify({ error: String(error?.message ?? error) }))
        }
        readBody(req)
          .then((raw) => {
            const body = JSON.parse(raw)
            const { canvasId, commandId } = body ?? {}
            if (typeof canvasId !== 'string' || typeof commandId !== 'string') {
              return send(res, 400, JSON.stringify({ error: 'bad payload' }))
            }
            // Only a command that is still pending accepts a result — a stale
            // executor replaying old results must not clobber newer state.
            const q = queues.get(canvasId) ?? []
            const idx = q.findIndex((c) => c.commandId === commandId)
            if (idx === -1) return send(res, 409, JSON.stringify({ error: 'unknown or settled command' }))
            q.splice(idx, 1)
            settle(commandId, {
              ok: body.ok === true,
              ...(body.created ? { created: body.created } : {}),
              ...(body.nodes ? { nodes: body.nodes } : {}),
              ...(body.edges ? { edges: body.edges } : {}),
              ...(body.error ? { error: String(body.error).slice(0, 500) } : {}),
            })
            return send(res, 204, null)
          })
          .catch((error) => send(res, 400, JSON.stringify({ error: String(error?.message ?? error) })))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'canvas_write',
      description:
        'Write to the DSH canvas (Excalidraw) via the open canvas browser tab. ' +
        'ops is a list of: {op:"addNode", x, y, label?, shape?("rectangle"|"ellipse"|"diamond"), width?, height?} — ' +
        'creates a shape (default 160x84) with an optional centered bound text label; ' +
        '{op:"connect", fromId, toId, label?} — bound arrow between two existing elements with optional label; ' +
        '{op:"move", id, x, y} — absolute reposition (bound label moves along); ' +
        '{op:"updateText", id, text}; {op:"delete", ids:[...]}. ' +
        'Use canvas_read first to discover element ids (shapes carry their label text). ' +
        'Requires a canvas tab to be open: the ops execute on the live scene within ~1s, ' +
        'and the tool returns the created element ids (addNode → {id, textId}); unexecuted ' +
        'commands expire after 30s. All ops of one call apply atomically (single undo step).',
      parameters: {
        canvasId: {
          type: 'string',
          description:
            'Canvas id (from canvas_read). Optional when exactly one canvas is known.',
        },
        ops: {
          type: 'array',
          description: 'Non-empty list of write ops (see description).',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args) {
        let canvasId = args.canvasId
        if (!canvasId) {
          const ids = [...mirror.keys()]
          if (ids.length === 1) canvasId = ids[0]
          else return { error: 'canvasId required (pass the canvasId from canvas_read)' }
        }
        const invalid = validateOps(args.ops)
        if (invalid) return { error: invalid }
        const commandId = enqueueCommand(canvasId, args.ops)
        const payload = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(commandId)
            resolve({ ok: false, error: 'timeout — is the canvas tab open? (it must poll, execute and report within 8s)' })
          }, 8000)
          waiters.set(commandId, (result) => {
            clearTimeout(timer)
            resolve(result)
          })
        })
        return { commandId, ...payload }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'canvas_diagram',
      description:
        'Draw a WHOLE diagram on the DSH canvas in ONE atomic command (single undo step), ' +
        'auto-laid-out left→right in layers (columns = longest-path depth, rows = listing order). ' +
        'nodes: [{key, label, shape?("rectangle"|"ellipse"|"diamond"), col?}] — key is your own reference; ' +
        'edges: [{from, to, label?}] — node keys. Coordinates are computed for you and the diagram is ' +
        'anchored at the center of the visible viewport (pass anchor {x,y} to place explicitly). ' +
        'Returns nodes: {key → {id, textId}} and edges: {"from→to" → {id, textId}} — feed these ids back ' +
        'to canvas_write (move/updateText/delete) for adjustments. Requires an open canvas tab.',
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id (from canvas_read). Optional when exactly one canvas is known.' },
        nodes: { type: 'array', description: '[{key, label, shape?, col?}] — col overrides auto layering.' },
        edges: { type: 'array', description: '[{from, to, label?}] — node keys; optional.' },
        anchorX: { type: 'number', description: 'Optional scene x for the diagram top-left (with anchorY). Default: viewport center.' },
        anchorY: { type: 'number', description: 'Optional scene y for the diagram top-left (with anchorX). Default: viewport center.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args) {
        let canvasId = args.canvasId
        if (!canvasId) {
          const ids = [...mirror.keys()]
          if (ids.length === 1) canvasId = ids[0]
          else return { error: 'canvasId required (pass the canvasId from canvas_read)' }
        }
        const op = {
          op: 'diagram',
          nodes: args.nodes,
          ...(args.edges ? { edges: args.edges } : {}),
          ...(args.anchorX != null && args.anchorY != null ? { x: args.anchorX, y: args.anchorY } : {}),
        }
        const invalid = validateOps([op])
        if (invalid) return { error: invalid }
        const commandId = enqueueCommand(canvasId, [op])
        const payload = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            waiters.delete(commandId)
            resolve({ ok: false, error: 'timeout — is the canvas tab open?' })
          }, 8000)
          waiters.set(commandId, (result) => {
            clearTimeout(timer)
            resolve(result)
          })
        })
        return { commandId, ...payload }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'canvas_read',
      description:
        'Read the DSH canvas (Excalidraw) content pushed by the canvas browser tab. ' +
        'Returns a structural summary per canvas: text blocks, shapes with their text, ' +
        'arrows with from/to element bindings and labels, line elements, and groups. ' +
        'Data freshness: updated within ~0.5s while a canvas tab is open; when no tab ' +
        'is open it is the last pushed snapshot (see updatedAt). History snapshots are ' +
        'appended to ~/.dsh/dsh-canvas/history/<canvasId>.jsonl and can be read with file tools.',
      parameters: {
        canvasId: {
          type: 'string',
          description:
            'Optional canvas id. Omit to list all known canvases with a short summary each.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args) {
        if (args.canvasId) {
          const snap = mirror.get(args.canvasId)
          if (!snap) {
            return {
              error: `unknown canvasId ${args.canvasId}; open the canvas tab so it pushes, or call without canvasId to list known canvases`,
            }
          }
          return summarizeScene(args.canvasId, snap)
        }
        if (mirror.size === 0) {
          return {
            canvases: [],
            note: 'no canvas has pushed yet — open the canvas tab in the DSH sidebar once',
          }
        }
        return {
          canvases: [...mirror.entries()].map(([id, s]) =>
            summarizeScene(id, s),
          ),
        }
      },
    }),
  )
}
