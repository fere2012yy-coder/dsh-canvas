/** Pure smoke test for frame-erase-rescue (no DOM). */
import { rescueErasedFrames, resetFrameEraseTracker } from '../src/canvas/frame-erase-rescue.js'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

const el = (id, extra = {}) => ({ id, type: 'rectangle', isDeleted: false, ...extra })
const frame = (id, extra = {}) => ({ id, type: 'frame', isDeleted: false, ...extra })

// 1. no tracker → no rescue
resetFrameEraseTracker()
const scene1 = [frame('f', { isDeleted: true }), el('c', { frameId: 'f', isDeleted: true })]
check('cold tracker: no rescue', rescueErasedFrames(scene1, true) === null)

// 2. armed + frame erased with child → child restored frameless, frame stays deleted
resetFrameEraseTracker()
rescueErasedFrames([frame('f'), el('c', { frameId: 'f' }), el('x')], false)
const scene2 = [frame('f', { isDeleted: true }), el('c', { frameId: 'f', isDeleted: true }), el('x')]
const r2 = rescueErasedFrames(scene2, true)
check('armed erase: rescue fires', Array.isArray(r2))
const c2 = r2?.find((e) => e.id === 'c')
const f2 = r2?.find((e) => e.id === 'f')
check('child restored frameless', c2 && c2.isDeleted === false && c2.frameId === null)
check('frame stays deleted', f2 && f2.isDeleted === true)
check('bystander untouched', r2.find((e) => e.id === 'x') === scene2[2])

// 3. not armed (Delete key) → no rescue
resetFrameEraseTracker()
rescueErasedFrames([frame('f'), el('c', { frameId: 'f' })], false)
const r3 = rescueErasedFrames(
  [frame('f', { isDeleted: true }), el('c', { frameId: 'f', isDeleted: true })],
  false,
)
check('unarmed (Delete key): no rescue', r3 === null)

// 4. follow-up change after rescue → no double rescue / no loop
resetFrameEraseTracker()
rescueErasedFrames([frame('f'), el('c', { frameId: 'f' })], false)
rescueErasedFrames([frame('f', { isDeleted: true }), el('c', { frameId: 'f', isDeleted: true })], true)
const r4 = rescueErasedFrames(
  [frame('f', { isDeleted: true }), el('c', { frameId: 'f', isDeleted: false })],
  true,
)
check('post-rescue change: idempotent', r4 === null)

// 5. scene switch (elements absent, not deleted) → no rescue
resetFrameEraseTracker()
rescueErasedFrames([frame('f'), el('c', { frameId: 'f' })], false)
const r5 = rescueErasedFrames([el('other')], true)
check('scene switch: no rescue', r5 === null)

// 6. child of an unrelated frame untouched
resetFrameEraseTracker()
rescueErasedFrames([frame('f'), el('c', { frameId: 'f' }), frame('g'), el('d', { frameId: 'g' })], false)
const r6 = rescueErasedFrames(
  [
    frame('f', { isDeleted: true }),
    el('c', { frameId: 'f', isDeleted: true }),
    frame('g'),
    el('d', { frameId: 'g' }),
  ],
  true,
)
check('only children of erased frames rescued', r6?.some((e) => e.id === 'c' && !e.isDeleted) && r6.find((e) => e.id === 'd') === r6[3])

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
