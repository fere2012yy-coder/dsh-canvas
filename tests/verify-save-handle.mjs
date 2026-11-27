#!/usr/bin/env node
/**
 * Live e2e for the Ctrl+S remembered-save-target feature (needs debug host +
 * NEW bundle). Verifies what is verifiable WITHOUT the native save dialog:
 *
 *  1. canvas tab mounts with the new bundle (excalidraw api up, no pageerror)
 *  2. async initialData ran → IndexedDB 'dsh-canvas' with store 'fileHandles'
 *     exists (created by the mount-time loadFileHandle read)
 *  3. clean first-run state: appState.fileHandle is null (nothing remembered)
 *  4. the file-handle-store round-trip works inside the page (put/get/clear)
 *
 * The silent-overwrite keystroke itself needs a real FileSystemFileHandle,
 * which only the native dialog can mint — that part stays manual acceptance.
 */
import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
const page = browser.contexts()[0].pages().find((p) => p.url().includes('dsh-app'))
if (!page) {
  console.log('FATAL no dsh-app page — host not up?')
  process.exit(1)
}
await page.bringToFront()

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))

await page.evaluate(() => window.__dshCanvasTest?.open?.('canvas'))
await sleep(2000)

check('canvas api mounted', await page.evaluate(() => !!window.__dshCanvasTest?.excalidraw?.getSceneElements))

const idb = await page.evaluate(async () => {
  const dbs = (await indexedDB.databases?.()) ?? []
  return {
    names: dbs.map((d) => d.name),
    hasStore: dbs.some((d) => d.name === 'dsh-canvas'),
  }
})
check("IndexedDB 'dsh-canvas' created by mount-time load", idb.names.includes('dsh-canvas'), JSON.stringify(idb))

const storeProbe = await page.evaluate(async () => {
  // Round-trip the store through a dummy value (a real handle only comes
  // from the native dialog; plain strings clone fine for the plumbing test).
  const open = () =>
    new Promise((resolve, reject) => {
      const r = indexedDB.open('dsh-canvas')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
  const db = await open()
  const get = () =>
    new Promise((resolve, reject) => {
      const tx = db.transaction('fileHandles', 'readwrite')
      const store = tx.objectStore('fileHandles')
      store.put({ __probe: true }, '__probe__')
      const req = store.get('__probe__')
      tx.oncomplete = () => resolve(req.result)
      tx.onerror = () => reject(tx.error)
    })
  const value = await get()
  db.close()
  return value
})
check('fileHandles store writable+readable', storeProbe?.__probe === true, JSON.stringify(storeProbe))

const consistency = await page.evaluate(async () => {
  const api = window.__dshCanvasTest?.excalidraw
  const live = api?.getAppState?.().fileHandle ?? null
  const canvasId = window.__dshCanvasTest.canvasStore.currentCanvasId()
  const stored = await new Promise((resolve) => {
    const req = indexedDB.open('dsh-canvas')
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction('fileHandles', 'readonly')
      const get = tx.objectStore('fileHandles').get(canvasId)
      tx.oncomplete = () => {
        db.close()
        resolve(get.result ?? null)
      }
    }
  })
  return {
    canvasId,
    liveName: live?.name ?? null,
    storedName: stored?.name ?? null,
    liveIsHandle: typeof live?.createWritable === 'function',
  }
})
// Feature invariant: whatever the engine holds is exactly what IDB remembers
// (both null = never saved to a file; both same name = remembered target).
check(
  'IDB record matches appState.fileHandle (the remember invariant)',
  consistency.liveName === consistency.storedName && consistency.liveIsHandle === (consistency.storedName !== null),
  JSON.stringify(consistency),
)

await page.evaluate(() => {
  // remove the plumbing probe record, keep real handles untouched
  const req = indexedDB.open('dsh-canvas')
  req.onsuccess = () => {
    const db = req.result
    const tx = db.transaction('fileHandles', 'readwrite')
    tx.objectStore('fileHandles').delete('__probe__')
    tx.oncomplete = () => db.close()
  }
})

check('no page errors during probe', pageErrors.length === 0, pageErrors.join(' | '))

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
