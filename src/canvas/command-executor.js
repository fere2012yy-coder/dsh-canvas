/**
 * Command executor (L2) — the write half of the agent channel.
 *
 * The host queues ops enqueued by the canvas_write tool under
 * /dsh-canvas/commands; this module polls (700ms) while the canvas tab is
 * mounted, executes each command against the live Excalidraw scene in ONE
 * updateScene (atomic — one undo step per command), and reports the outcome
 * (created ids / error) back to /dsh-canvas/command-result, which resolves
 * the waiting tool call.
 *
 * Node/label creation mirrors the dblclick flow in client.jsx: 0.18.1's
 * convertToExcalidrawElements mangles container bindings when shapes+text are
 * converted together, so elements are converted separately and wired by hand
 * against real ids (box.boundElements / text.containerId / arrow.label).
 */
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'

const rid = (p) => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const centerOf = (el) => ({ x: el.x + (el.width ?? 0) / 2, y: el.y + (el.height ?? 0) / 2 })

/** Apply `patches`/`add` in one atomic updateScene over the live scene. */
function commit(api, patches, add) {
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted().map((e) => patches.get(e.id) ?? e), ...add],
  })
}

/** Live view of an element: patched copy if this command already touched it. */
function live(all, patches, id) {
  return patches.get(id) ?? all.find((e) => e.id === id)
}

/** Create a box (+ centered bound label) at x/y — used by addNode & diagram. */
function makeNode({ x, y, label, shape = 'rectangle', width = 160, height = 84 }) {
  const [box] = convertToExcalidrawElements([
    { type: shape, x, y, width, height, backgroundColor: 'transparent' },
  ])
  box.id = rid('node')
  let text = null
  if (label) {
    const [t] = convertToExcalidrawElements([
      { type: 'text', x: 0, y: 0, text: String(label), fontSize: 20, textAlign: 'center', verticalAlign: 'middle' },
    ])
    t.id = rid('txt')
    t.containerId = box.id
    t.x = box.x + box.width / 2 - t.width / 2
    t.y = box.y + box.height / 2 - t.height / 2
    box.boundElements = [{ id: t.id, type: 'text' }]
    text = t
  }
  return { box, text, textId: text?.id ?? null }
}

/** Create a bound arrow between two existing elements (+ optional label). */
function makeEdge({ from, to, label }) {
  const fc = centerOf(from)
  const tc = centerOf(to)
  const [arrow] = convertToExcalidrawElements([
    { type: 'arrow', x: fc.x, y: fc.y, points: [[0, 0], [tc.x - fc.x, tc.y - fc.y]], strokeWidth: 2 },
  ])
  arrow.id = rid('edge')
  arrow.startBinding = { elementId: from.id, focus: 0, gap: 4 }
  arrow.endBinding = { elementId: to.id, focus: 0, gap: 4 }
  arrow.startArrowhead = null
  arrow.endArrowhead = 'arrow'
  let text = null
  if (label) {
    const [t] = convertToExcalidrawElements([
      { type: 'text', x: 0, y: 0, text: String(label), fontSize: 16, textAlign: 'center', verticalAlign: 'middle' },
    ])
    t.id = rid('lbl')
    t.containerId = arrow.id
    t.x = (fc.x + tc.x) / 2 - t.width / 2
    t.y = (fc.y + tc.y) / 2 - t.height / 2
    arrow.label = { labelIds: [t.id] }
    arrow.boundElements = [...(arrow.boundElements ?? []), { id: t.id, type: 'text' }]
    text = t
  }
  return { arrow, text, textId: text?.id ?? null }
}

async function executeOps(api, ops) {
  const all = api.getSceneElementsIncludingDeleted()
  const patches = new Map()
  const add = []
  const created = []
  let diagramResult = null

  for (const op of ops) {
    switch (op.op) {
      case 'addNode': {
        const { box, text, textId } = makeNode(op)
        if (text) add.push(text)
        add.push(box)
        created.push({ id: box.id, ...(textId ? { textId } : {}) })
        break
      }

      case 'connect': {
        const from = live(all, patches, op.fromId)
        const to = live(all, patches, op.toId)
        if (!from || from.isDeleted) throw new Error(`connect: fromId ${op.fromId} not found`)
        if (!to || to.isDeleted) throw new Error(`connect: toId ${op.toId} not found`)
        const { arrow, text, textId } = makeEdge({ from, to, label: op.label })
        for (const node of [from, to]) {
          patches.set(node.id, {
            ...node,
            boundElements: [...(node.boundElements ?? []), { id: arrow.id, type: 'arrow' }],
          })
        }
        if (text) add.push(text)
        add.push(arrow)
        created.push({ id: arrow.id, ...(textId ? { textId } : {}) })
        break
      }

      case 'diagram': {
        // One-shot whole-diagram op (L3): nodes + edges laid out in left→right
        // layers and committed in the SAME updateScene as the rest of the
        // command. Anchor defaults to the visible viewport center.
        const defs = op.nodes ?? []
        if (!defs.length) throw new Error('diagram: nodes must be a non-empty list')
        const sizeOf = (n) => ({
          w: n.width ?? Math.min(240, Math.max(130, String(n.label ?? '').length * 22 + 40)),
          h: n.height ?? 64,
        })
        // layer = longest-path depth from sources (or explicit col)
        const byKey = new Map(defs.map((n) => [n.key, n]))
        const depth = new Map()
        const depthOf = (key, seen = new Set()) => {
          if (depth.has(key)) return depth.get(key)
          if (seen.has(key)) return 0 // cycle guard
          seen.add(key)
          const inc = (op.edges ?? []).filter((e) => e.to === key).map((e) => e.from)
          const d = inc.length ? Math.max(...inc.map((k) => depthOf(k, seen) + 1)) : 0
          depth.set(key, d)
          return d
        }
        for (const n of defs) depthOf(n.key)
        const cols = []
        for (const n of defs) {
          const d = n.col ?? depth.get(n.key) ?? 0
          ;(cols[d] ??= []).push(n)
        }
        const colW = cols.map((c) => Math.max(...c.map((n) => sizeOf(n).w)))
        const GAP_X = 90
        const GAP_Y = 56
        const totalW = colW.reduce((a, w) => a + w, 0) + GAP_X * (cols.length - 1)
        const maxRows = Math.max(...cols.map((c) => c.length))
        const totalH = maxRows * 64 + GAP_Y * (maxRows - 1)
        // anchor: explicit x/y, else the center of the visible viewport
        let ax = op.x
        let ay = op.y
        if (ax == null || ay == null) {
          const st = api.getAppState()
          const canvas = document.querySelector('canvas.interactive') ?? document.querySelector('.excalidraw')
          const rect = canvas.getBoundingClientRect()
          const cx = rect.left + rect.width / 2
          const cy = rect.top + rect.height / 2
          ax = (cx - rect.left) / st.zoom.value - st.scrollX - totalW / 2
          ay = (cy - rect.top) / st.zoom.value - st.scrollY - totalH / 2
        }
        const pos = new Map()
        const nodeMap = {}
        cols.forEach((col, d) => {
          const colH = col.length * 64 + GAP_Y * (col.length - 1)
          const x = ax + colW.slice(0, d).reduce((a, w) => a + w + GAP_X, 0)
          col.forEach((n, r) => {
            const { w, h } = sizeOf(n)
            const y = ay + (totalH - colH) / 2 + r * (64 + GAP_Y)
            const { box, text, textId } = makeNode({ x, y, label: n.label, shape: n.shape, width: w, height: h })
            pos.set(n.key, box)
            nodeMap[n.key] = { id: box.id, ...(textId ? { textId } : {}) }
            if (text) add.push(text)
            add.push(box)
          })
        })
        // second pass: texts pushed after boxes? — texts are pushed with boxes
        // via makeNode above; wire edges now
        const edgeMap = {}
        for (const e of op.edges ?? []) {
          const from = pos.get(e.from)
          const to = pos.get(e.to)
          if (!from || !to) throw new Error(`diagram: edge ${e.from}→${e.to} references unknown key`)
          const { arrow, text, textId } = makeEdge({ from, to, label: e.label })
          for (const node of [from, to]) {
            node.boundElements = [...(node.boundElements ?? []), { id: arrow.id, type: 'arrow' }]
          }
          if (text) add.push(text)
          add.push(arrow)
          edgeMap[`${e.from}→${e.to}`] = { id: arrow.id, ...(textId ? { textId } : {}) }
        }
        diagramResult = { nodes: nodeMap, edges: edgeMap }
        break
      }

      case 'move': {
        const el = live(all, patches, op.id)
        if (!el || el.isDeleted) throw new Error(`move: id ${op.id} not found`)
        const dx = op.x - el.x
        const dy = op.y - el.y
        patches.set(op.id, { ...el, x: op.x, y: op.y })
        for (const e of all) {
          if (e.containerId === op.id && !e.isDeleted) {
            patches.set(e.id, { ...(patches.get(e.id) ?? e), x: e.x + dx, y: e.y + dy })
          }
        }
        break
      }

      case 'updateText': {
        const el = live(all, patches, op.id)
        if (!el || el.isDeleted) throw new Error(`updateText: id ${op.id} not found`)
        if (el.type === 'text') {
          patches.set(op.id, { ...el, text: op.text })
          break
        }
        const bound = all.find((e) => e.containerId === op.id && e.type === 'text' && !e.isDeleted)
        if (!bound) throw new Error(`updateText: ${op.id} has no bound text`)
        patches.set(bound.id, { ...bound, text: op.text })
        break
      }

      case 'delete': {
        // Engine-like semantics: deleting an element takes its bound texts
        // AND the arrows bound to it along (plus those arrows' own labels).
        const dead = new Set()
        const grow = (id) => {
          if (dead.has(id)) return
          dead.add(id)
          const el = live(all, patches, id)
          if (!el || el.isDeleted) return
          patches.set(id, { ...(patches.get(id) ?? el), isDeleted: true })
          for (const e of all) {
            if (e.containerId === id && !e.isDeleted) grow(e.id)
            if (e.type === 'arrow' && !e.isDeleted && (e.startBinding?.elementId === id || e.endBinding?.elementId === id)) grow(e.id)
          }
        }
        for (const id of op.ids) grow(id)
        break
      }

      default:
        throw new Error(`unknown op ${JSON.stringify(op.op)}`)
    }
  }

  commit(api, patches, add)
  return { created, ...(diagramResult ?? {}) }
}

/**
 * Poll the host queue and execute commands until disposed. `getApi` may
 * return null while Excalidraw is mounting — ticks are skipped then.
 */
export function startCommandExecutor(getApi, canvasId, intervalMs = 700) {
  let lastSeq = 0
  let timer = null
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const api = getApi()
      if (!api) return
      const res = await fetch(
        `/dsh-canvas/commands?canvasId=${encodeURIComponent(canvasId)}&after=${lastSeq}`,
      )
      if (!res.ok) return
      const data = await res.json()
      for (const cmd of data.commands ?? []) {
        lastSeq = Math.max(lastSeq, Number(cmd.seq) || 0)
        let result
        try {
          result = { ok: true, ...(await executeOps(api, cmd.ops)) }
        } catch (error) {
          result = { ok: false, error: String(error?.message ?? error) }
        }
        await fetch('/dsh-canvas/command-result', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ canvasId, commandId: cmd.commandId, ...result }),
        }).catch(() => {})
      }
    } catch {
      /* network hiccup or page teardown — next tick retries */
    } finally {
      busy = false
    }
  }
  timer = setInterval(tick, intervalMs)
  tick()
  return () => clearInterval(timer)
}
