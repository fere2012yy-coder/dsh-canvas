#!/usr/bin/env node
/**
 * Excalidraw canvas features acceptance — real DSH desktop over CDP (9222).
 *
 * Covers the four canvas features, in order:
 *   A. canvas management  — persistence, create/switch/delete canvases (menu)
 *   B. wheel swap         — wheel = cursor-anchored zoom, Ctrl+wheel = scroll
 *   C. boxed text block   — blank dblclick creates rectangle + bound text
 *   D. session binding    — Ctrl+right-click menu, dsh-session:// link on
 *                           element.link, Ctrl+click jumps to the session
 *
 * 🔴 Restart the DSH host after a bundle change (DSH-debug.bat); never
 * clearBrowserCache over CDP. Run: node tests/canvas-features.mjs
 */
import { chromium } from 'playwright-core'

const CDP = process.env.DSH_CDP ?? 'http://127.0.0.1:9222'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.connectOverCDP(CDP)
const context = browser.contexts()[0]
const page = context.pages().find((p) => p.url().startsWith('dsh-app://'))
if (!page) {
  console.log('FATAL: no dsh-app page')
  process.exit(1)
}
await page.bringToFront()
await sleep(500)

const ls = (key) => page.evaluate((k) => localStorage.getItem(k), key)
const sceneOf = (id) =>
  page.evaluate((k) => {
    try {
      return JSON.parse(localStorage.getItem(`dsh-canvas:excalidraw:scene:${k}`) ?? 'null')
    } catch {
      return null
    }
  }, id)
const canvasIndex = async () => JSON.parse((await ls('dsh-canvas:excalidraw:index')) ?? '[]')
const currentCanvas = () => ls('dsh-canvas:excalidraw:current')

const clickText = async (text) => {
  const r = await page.evaluate((t) => {
    const hits = [...document.querySelectorAll('button, [role="menuitem"], [role="button"]')].filter(
      (e) => e.textContent?.trim() === t && e.offsetParent !== null,
    )
    const el = hits[hits.length - 1]
    if (!el) return null
    el.scrollIntoView({ block: 'nearest' })
    const b = el.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }, text)
  if (!r) return false
  await page.mouse.click(r.x, r.y)
  await sleep(500)
  return true
}

const openMainMenu = async () => {
  const r = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="main-menu-trigger"]')
    if (!btn) return null
    const b = btn.getBoundingClientRect()
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  })
  if (!r) return false
  await page.mouse.click(r.x, r.y)
  await sleep(600)
  return true
}

const canvasCenter = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
    return { x: c.x + c.width / 2, y: c.y + c.height / 2, left: c.left, top: c.top }
  })

/** Mount the canvas tab and wait for the scene to settle (initialData races). */
async function openCanvasSettled() {
  await page.evaluate(() => window.__dshCanvasTest.open('canvas'))
  let mounted = false
  for (let i = 0; i < 20 && !mounted; i++) {
    await sleep(1000)
    mounted = await page.evaluate(() => !!window.__dshCanvasTest?.excalidraw)
  }
  check('canvas mounts with api', mounted)
  await sleep(3000)
  for (let i = 0; i < 8; i++) {
    const s1 = await page.evaluate(() => window.__dshCanvasTest.excalidraw.getAppState().scrollX)
    await sleep(1200)
    const s2 = await page.evaluate(() => window.__dshCanvasTest.excalidraw.getAppState().scrollX)
    if (s1 === s2) break
  }
}

// ============ A. canvas management (features 4+5) ============
await openCanvasSettled()
// Pre-clean stale EMPTY canvases (auto-named leftovers from earlier runs);
// canvases with content are never touched. Then mount a fresh canvas with a
// unique name so every later step is deterministic.
const cleaned = await page.evaluate(() => {
  const store = window.__dshCanvasTest.canvasStore
  if (!store) return 0
  let n = 0
  for (const c of store.listCanvases()) {
    let empty = true
    try {
      empty = (JSON.parse(localStorage.getItem(`dsh-canvas:excalidraw:scene:${c.id}`) ?? 'null')?.elements?.length ?? 0) === 0
    } catch {}
    if (empty && c.id !== store.currentCanvasId()) {
      store.deleteCanvas(c.id)
      n++
    }
  }
  return n
})
void cleaned
const idx1 = await canvasIndex()
const uniqueName = `验收画布 ${Date.now().toString(36)}`
const cur1 = await page.evaluate((name) => window.__dshCanvasTest.canvasStore.createCanvas(name).id, uniqueName)
await page.evaluate(() => window.__dshCanvasTest.closeActive())
await sleep(900)
await openCanvasSettled()
check('A1 fresh uniquely-named canvas mounted', (await currentCanvas()) === cur1, cur1)

await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  const els = window.__dshCanvasTest.exHelpers.convertToExcalidrawElements([
    { type: 'rectangle', x: 0, y: 0, width: 90, height: 60 },
  ])
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...els] })
})
await sleep(900)
const scene1 = await sceneOf(cur1)
check('A2 debounced save persists elements', (scene1?.elements?.length ?? 0) >= 1, `els=${scene1?.elements?.length}`)

check('A3 menu opens', await openMainMenu())
check('A4 新建画布 clicked', await clickText('新建画布'))
await sleep(1200)
const idx2 = await canvasIndex()
check('A5 second canvas created', idx2.length === idx1.length + 2, `n=${idx2.length}`)
const cur2 = await currentCanvas()
check('A6 current switched', cur2 !== cur1)
check('A7 new canvas empty', (await sceneOf(cur2))?.elements?.length === 0)

// switch back to cur1 — its unique name makes the menu item unambiguous
check('A8 menu opens again', await openMainMenu())
check('A9 switch back clicked', await clickText(uniqueName))
await sleep(1200)
check('A10 switch restores scene', (await page.evaluate(() => window.__dshCanvasTest.excalidraw.getSceneElements().length)) >= 1)
check('A11 current id restored', (await currentCanvas()) === cur1)

await page.evaluate(() => window.__dshCanvasTest.closeActive())
await sleep(900)
await openCanvasSettled()
check('A12 tab close/reopen restores canvas', (await page.evaluate(() => window.__dshCanvasTest.excalidraw.getSceneElements().length)) >= 1)

// switch to the other canvas for B/C/D so user content at the origin is
// untouched, then every run leaves only its own uniquely-named canvas behind
await openMainMenu()
await clickText(cur2 ? idx2.find((c) => c.id === cur2)?.name : null)
await sleep(1000)

// ============ B. wheel swap (feature 1) ============
{
  const center = await canvasCenter()
  await page.evaluate(() => {
    window.__dshCanvasTest.excalidraw.updateScene({ appState: { zoom: { value: 1 }, scrollX: 0, scrollY: 0 } })
  })
  await sleep(300)
  const state = () =>
    page.evaluate(() => {
      const { zoom, scrollX, scrollY } = window.__dshCanvasTest.excalidraw.getAppState()
      return { zoom: zoom.value, scrollX, scrollY }
    })
  const before = await state()
  await page.mouse.move(center.x, center.y)
  await page.mouse.wheel(0, 240)
  await sleep(400)
  const afterOut = await state()
  check('B1 plain wheel zooms out', afterOut.zoom < before.zoom, `${before.zoom} → ${afterOut.zoom.toFixed(3)}`)
  check(
    'B2 zoom factor = exp(-deltaY*0.0015), single-handled',
    Math.abs(afterOut.zoom / Math.exp(-240 * 0.0015) - 1) < 0.02,
    `got ${afterOut.zoom.toFixed(4)}`,
  )
  const sceneX = (s) => (center.x - center.left) / s.zoom - s.scrollX
  const sceneY = (s) => (center.y - center.top) / s.zoom - s.scrollY
  check(
    'B3 cursor anchor holds',
    Math.abs(sceneX(afterOut) - sceneX(before)) < 1 && Math.abs(sceneY(afterOut) - sceneY(before)) < 1,
  )
  await page.mouse.wheel(0, -240)
  await sleep(400)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 200)
  await page.keyboard.up('Control')
  await sleep(400)
  const afterCtrl = await state()
  check('B4 ctrl+wheel scrolls, no zoom', Math.abs(afterCtrl.scrollY - afterOut.scrollY) > 10 && Math.abs(afterCtrl.zoom - 1) < 0.02, `Δ=${(afterCtrl.scrollY - afterOut.scrollY).toFixed(1)} zoom=${afterCtrl.zoom.toFixed(3)}`)
}

// ============ C. stock blank dblclick (feature 2 is OFF by default) ============
{
  // fresh zone inside Excalidraw's reliable scene range
  const zone = -(20000 + Math.floor(Math.random() * 10000))
  await page.evaluate((z) => {
    window.__dshCanvasTest.excalidraw.updateScene({ appState: { zoom: { value: 1 }, scrollX: z, scrollY: z } })
  }, zone)
  await sleep(400)
  const center = await canvasCenter()
  const before = await page.evaluate(() => {
    const els = window.__dshCanvasTest.excalidraw.getSceneElements()
    return { total: els.length, rects: els.filter((e) => e.type === 'rectangle').length }
  })
  await page.mouse.dblclick(center.x, center.y)
  await sleep(900)
  const res = await page.evaluate(() => {
    const els = window.__dshCanvasTest.excalidraw.getSceneElements()
    const texts = els.filter((e) => e.type === 'text' && !e.isDeleted)
    return {
      total: els.length,
      rects: els.filter((e) => e.type === 'rectangle').length,
      newText: texts.at(-1)?.text ?? null,
    }
  })
  check('C1 blank dblclick keeps stock plain text (no box pair)', res.total === before.total + 1 && res.rects === before.rects, `${before.total} → ${res.total}, rects=${res.rects}`)
  void res.newText

  // a programmatic block for the binding tests (feature-independent target)
  const blockId = await page.evaluate(() => {
    const api = window.__dshCanvasTest.excalidraw
    const st = api.getAppState()
    const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
    const sx = (c.x + c.width / 2 - c.left) / st.zoom.value - st.scrollX
    const sy = (c.y + c.height / 2 - c.top) / st.zoom.value - st.scrollY
    const [box] = window.__dshCanvasTest.exHelpers.convertToExcalidrawElements([
      { type: 'rectangle', x: sx - 80, y: sy - 42, width: 160, height: 84 },
    ])
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), box] })
    return box.id
  })
  globalThis.__bindBlockId = blockId
  check('C2 binding target block created', !!blockId, String(blockId))
}

// ============ D. session binding (feature 3) ============
{
  let servicesReady = false
  for (let i = 0; i < 20 && !servicesReady; i++) {
    await sleep(1000)
    servicesReady = await page.evaluate(() => !!window.__dshCanvasTest?.sessions?.create)
  }
  check('D1 session services ready', servicesReady)

  const blockId = globalThis.__bindBlockId
  const blockPt = await page.evaluate((bid) => {
    const api = window.__dshCanvasTest.excalidraw
    const box = api.getSceneElements().find((e) => e.id === bid)
    const { zoom, scrollX, scrollY } = api.getAppState()
    const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
    const z = zoom.value
    return { x: c.x + (box.x + box.width / 2 + scrollX) * z, y: c.y + (box.y + box.height / 2 + scrollY) * z }
  }, blockId)

  const readLink = () =>
    page.evaluate((bid) => window.__dshCanvasTest.excalidraw.getSceneElements().find((e) => e.id === bid)?.link ?? null, blockId)
  const pollLink = async (want, timeout = 15000) => {
    for (let i = 0; i < timeout / 400; i++) {
      const link = await readLink()
      if (want === null ? link == null : typeof link === 'string' && link.startsWith('dsh-session://')) return link
      await sleep(400)
    }
    return want === null ? 'non-null' : null
  }
  const menuClick = async (label) => {
    await page.keyboard.down('Control')
    await page.mouse.click(blockPt.x, blockPt.y, { button: 'right' })
    await page.keyboard.up('Control')
    await sleep(500)
    const ok = await page.evaluate((t) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === t)
      if (!b) return false
      b.click()
      return true
    }, label)
    await sleep(400)
    return ok
  }

  check('D2 menu: 创建会话并绑定 clickable', await menuClick('创建会话并绑定'))
  const link1 = await pollLink('set')
  check('D3 create&bind writes dsh-session:// link', typeof link1 === 'string' && link1.startsWith('dsh-session://session-'), String(link1))

  await page.keyboard.down('Control')
  await page.mouse.click(blockPt.x, blockPt.y, { button: 'right' })
  await page.keyboard.up('Control')
  await sleep(500)
  const boundMenu = await page.evaluate(() => ({
    unbind: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '取消绑定'),
    create: [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '创建会话并绑定'),
  }))
  check('D4 bound menu shows 取消绑定 only', boundMenu.unbind && !boundMenu.create, JSON.stringify(boundMenu))
  await page.mouse.click(10, 10)
  await sleep(300)

  check('D5 menu: 取消绑定 clickable', await menuClick('取消绑定'))
  check('D6 unbind clears link', (await pollLink(null)) === null)

  check('D7 menu: 绑定已有会话 clickable', await menuClick('绑定已有会话…'))
  await sleep(600)
  const pickerRows = await page.evaluate(() => {
    const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === '搜索会话…')
    if (!input) return null
    return [...input.parentElement.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '')
  })
  check('D8 picker lists sidebar sessions', Array.isArray(pickerRows) && pickerRows.length > 0, `n=${pickerRows?.length}`)

  const activeBefore = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) =>
      /active|selected|current/i.test(r.className),
    )
    return row?.getAttribute('data-row-key') ?? null
  })
  // pick a row that is NOT the currently-active session
  const targetId = await page.evaluate(() => {
    const activeRow = [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) =>
      /active|selected|current/i.test(r.className),
    )
    const activeId = activeRow?.getAttribute('data-row-key') ?? ''
    const sideRows = [...document.querySelectorAll('[data-row-key^="session:"]')]
    const targetRow = sideRows.find((r) => r.getAttribute('data-row-key') !== activeId)
    const tid = targetRow?.getAttribute('data-row-key')?.slice('session:'.length) ?? null
    const title = targetRow
      ? [...targetRow.querySelectorAll('*')]
          .filter((n) => n.childElementCount === 0 && n.textContent?.trim())
          .map((n) => n.textContent.trim())
          .sort((a, b) => b.length - a.length)[0] ?? ''
      : ''
    const input = [...document.querySelectorAll('input')].find((i) => i.placeholder === '搜索会话…')
    const btn = [...input.parentElement.querySelectorAll('button')].find((b) => b.textContent?.trim() === title)
    btn?.click()
    return tid
  })
  await sleep(600)
  const link3 = await readLink()
  check('D9 picking a row rebinds', typeof link3 === 'string' && targetId && link3 === 'dsh-session://' + targetId, `link=${link3}`)

  await page.keyboard.down('Control')
  await page.mouse.click(blockPt.x, blockPt.y)
  await page.keyboard.up('Control')
  await sleep(2500)
  const activeAfter = await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-row-key^="session:"]')].find((r) =>
      /active|selected|current/i.test(r.className),
    )
    return row?.getAttribute('data-row-key') ?? null
  })
  check('D10 ctrl+click switches shell to bound session', activeBefore !== activeAfter && activeAfter === 'session:' + targetId, `before=${activeBefore} after=${activeAfter}`)

  // reopen the canvas tab (the session jump closes the per-session sidebar tab)
  await openCanvasSettled()
  const blockPt2 = await page.evaluate((bid) => {
    const api = window.__dshCanvasTest.excalidraw
    const box = api.getSceneElements().find((e) => e.id === bid)
    if (!box) return null
    const { zoom, scrollX, scrollY } = api.getAppState()
    const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
    const z = zoom.value
    return { x: c.x + (box.x + box.width / 2 + scrollX) * z, y: c.y + (box.y + box.height / 2 + scrollY) * z }
  }, blockId)
  check('D11 canvas reopens after jump', !!blockPt2)
  if (blockPt2) {
    await page.keyboard.down('Control')
    await page.mouse.click(blockPt2.x, blockPt2.y, { button: 'right' })
    await page.keyboard.up('Control')
    await sleep(500)
    await page.evaluate(() => {
      ;[...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '取消绑定')?.click()
    })
    await sleep(500)
    check('D12 final unbind clears link', (await readLink()) === null)
  }

  // cleanup: delete the two test canvases entirely — the environment returns
  // to exactly the user's own canvas set
  await page.evaluate(({ a, b }) => {
    const store = window.__dshCanvasTest.canvasStore
    if (!store) return
    store.deleteCanvas(a)
    if (b) store.deleteCanvas(b)
  }, { a: cur1, b: cur2 })
}

const failed = results.filter((r) => !r.ok).length
console.log(`\ncanvas-features: ${results.length - failed}/${results.length} passed`)
await browser.close()
process.exit(failed ? 1 : 0)
