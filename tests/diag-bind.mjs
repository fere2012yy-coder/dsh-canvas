#!/usr/bin/env node
/**
 * bindToNewSession live diagnostic v2.
 * Fixes over v1: scroll-stability wait before geometry; elementFromPoint
 * self-check; synthetic contextmenu fallback; pinned state tracking.
 */
import { chromium } from 'playwright-core'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[diag]', ...a)

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().startsWith('dsh-app://'))
if (!page) {
  console.log('FATAL: no dsh-app page')
  process.exit(1)
}
await page.bringToFront()
await sleep(500)

// 1. open canvas + settle, waiting for scroll stability (v1 bug: clicked
// while the scene was still scrolling in → coordinates went stale)
for (let attempt = 0; attempt < 3; attempt += 1) {
  const ready = await page.evaluate(() => {
    const api = window.__dshCanvasTest?.excalidraw
    return !!api && !!document.querySelector('canvas.excalidraw__canvas.interactive')
  })
  if (ready) break
  await page.evaluate(() => window.__dshCanvasTest.open('canvas'))
  for (let i = 0; i < 20; i++) {
    if (
      await page.evaluate(
        () => !!document.querySelector('canvas.excalidraw__canvas.interactive'),
      )
    ) {
      break
    }
    await sleep(1000)
  }
}
await sleep(3000)
for (let i = 0; i < 8; i++) {
  const s1 = await page.evaluate(() => window.__dshCanvasTest.excalidraw.getAppState().scrollX)
  await sleep(1200)
  const s2 = await page.evaluate(() => window.__dshCanvasTest.excalidraw.getAppState().scrollX)
  if (s1 === s2) break
}

// 2. create a diagnostic block at canvas center
const block = await page.evaluate(() => {
  const api = window.__dshCanvasTest.excalidraw
  const st = api.getAppState()
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  const sx = (c.x + c.width / 2 - c.left) / st.zoom.value - st.scrollX
  const sy = (c.y + c.height / 2 - c.top) / st.zoom.value - st.scrollY
  const [box] = window.__dshCanvasTest.exHelpers.convertToExcalidrawElements([
    { type: 'rectangle', x: sx - 80, y: sy - 42, width: 160, height: 84 },
  ])
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), box] })
  return { id: box.id, sx, sy }
})
log('block', block.id)

// 3. geometry + self-check: what REALLY sits under the click point?
const geo = await page.evaluate((bid) => {
  const api = window.__dshCanvasTest.excalidraw
  const box = api.getSceneElements().find((e) => e.id === bid)
  const { zoom, scrollX, scrollY } = api.getAppState()
  const c = document.querySelector('canvas.excalidraw__canvas.interactive').getBoundingClientRect()
  const x = c.x + (box.x + box.width / 2 + scrollX) * zoom.value
  const y = c.y + (box.y + box.height / 2 + scrollY) * zoom.value
  const hit = document.elementFromPoint(x, y)
  return {
    x, y,
    canvasRect: { x: c.x, y: c.y, w: c.width, h: c.height },
    under: hit ? hit.tagName + '.' + String(hit.className).slice(0, 60) : null,
    zoom: zoom.value, scrollX, scrollY,
  }
}, block.id)
log('geo', JSON.stringify(geo))

const findMenu = () =>
  page.evaluate(() => {
    const labels = [...document.querySelectorAll('button')].map((b) => b.textContent?.trim())
    return {
      hasCreate: labels.includes('创建会话'),
      hasPick: labels.includes('绑定会话'),
      hasUnbind: labels.includes('取消绑定'),
      stockMenu: !!document.querySelector('.excalidraw .context-menu, [class*="context-menu"]'),
    }
  })

// 4a. real mouse Ctrl+right-click
await page.keyboard.down('Control')
await page.mouse.click(geo.x, geo.y, { button: 'right' })
await page.keyboard.up('Control')
await sleep(600)
let menu = await findMenu()
log('after real right-click', JSON.stringify(menu))

// 4b. fallback: synthetic contextmenu with ctrlKey on the canvas element
if (!menu.hasCreate) {
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('canvas.excalidraw__canvas.interactive')
    el.dispatchEvent(new MouseEvent('contextmenu', { ctrlKey: true, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  }, geo)
  await sleep(600)
  menu = await findMenu()
  log('after synthetic contextmenu', JSON.stringify(menu))
}

if (!menu.hasCreate) {
  log('FATAL: bind menu refuses to open — investigate contextmenu handler separately')
} else {
  // 5. click 创建会话 in the REAL menu (UI path, exactly like the user)
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === '创建会话')
    if (!b) return false
    b.click()
    return true
  })
  log('clicked 创建会话:', clicked)

  // 6. poll every signal
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    const s = await page.evaluate((bid) => {
      const t = window.__dshCanvasTest
      const liveEl = t?.excalidraw?.getSceneElements().find((e) => e.id === bid)
      let storeEl = null
      try {
        const cid = localStorage.getItem('dsh-canvas:excalidraw:current')
        const sc = JSON.parse(localStorage.getItem(`dsh-canvas:excalidraw:scene:${cid}`) ?? 'null')
        storeEl = sc?.elements?.find((e) => e.id === bid) ?? null
      } catch {}
      return {
        m: t.sessions.mountedSessionId()?.slice(0, 18),
        live: liveEl?.link?.slice(0, 40) ?? null,
        store: storeEl?.link?.slice(0, 40) ?? null,
        rows: document.querySelectorAll('[data-row-key^="session:"]').length,
        chip: [...document.querySelectorAll('[role="tab"]')].some((el) => (el.textContent || '').trim().startsWith('DSH Canvas')),
        pin: localStorage.getItem('dsh-canvas.pinned'),
      }
    }, block.id)
    log(`t+${((i + 1) * 0.4).toFixed(1)}s`, JSON.stringify(s))
    if (s.store && s.store.startsWith('dsh-session://')) {
      log('store link present — now testing the ERASURE hypothesis')
      // v3: a stroke on the VISIBLE canvas re-saves the live instance's
      // memory; if the link vanishes from the store afterwards, the live
      // instance never carried it (dead-apiRef write race) — root cause.
      const vis = await page.evaluate(() => {
        const canvases = [...document.querySelectorAll('canvas.excalidraw__canvas.interactive')].map((c) => {
          const r = c.getBoundingClientRect()
          return { x: r.x, y: r.y, w: r.width, h: r.height }
        })
        return { innerW: window.innerWidth, innerH: window.innerHeight, canvases }
      })
      log('viewport/canvases', JSON.stringify(vis))
      const target = vis.canvases.find((c) => c.x + c.w > 100 && c.x < vis.innerW) ?? vis.canvases[0]
      if (!target) {
        log('no interactive canvas found — cannot stroke')
      } else {
        // stroke must land in the canvas ∩ viewport intersection
        const x0 = Math.max(target.x + 20, 8)
        const x1 = Math.min(target.x + target.w - 20, vis.innerW - 8)
        const y0 = Math.max(target.y + 20, 8)
        const y1 = Math.min(target.y + target.h - 20, vis.innerH - 8)
        if (x1 - x0 < 40 || y1 - y0 < 40) {
          log('canvas has no visible intersection with viewport — cannot stroke', JSON.stringify({ x0, x1, y0, y1 }))
        } else {
          await page.mouse.move(x0, y0)
          await page.mouse.down()
          await page.mouse.move(x0 + 60, y0 + 40, { steps: 5 })
          await page.mouse.up()
          log('stroke drawn on visible canvas', JSON.stringify({ x0, y0 }))
        }
      }
      await sleep(1500)
      const after = await page.evaluate((bid) => {
        let storeEl = null
        try {
          const cid = localStorage.getItem('dsh-canvas:excalidraw:current')
          const sc = JSON.parse(localStorage.getItem(`dsh-canvas:excalidraw:scene:${cid}`) ?? 'null')
          storeEl = sc?.elements?.find((e) => e.id === bid) ?? null
        } catch {}
        const liveEl = window.__dshCanvasTest?.excalidraw?.getSceneElements().find((e) => e.id === bid)
        return { store: storeEl?.link?.slice(0, 40) ?? null, live: liveEl?.link?.slice(0, 40) ?? null }
      }, block.id)
      log('after stroke', JSON.stringify(after))
      if (after.store === null) log('*** ERASURE CONFIRMED: live memory overwrote the store link ***')
      else log('store link survived the stroke')
      break
    }
    if (i === 39) log('poll budget exhausted — NO persistent link')
  }
}
log('DONE')
process.exit(0)
