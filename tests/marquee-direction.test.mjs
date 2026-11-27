/** Pure smoke test for marquee-direction (no DOM). */
import { elementAabb, marqueeVerdict } from '../src/canvas/marquee-direction.js'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`)
  if (!ok) failed++
}

const el = { id: 'a', type: 'rectangle', x: 100, y: 100, width: 50, height: 40, angle: 0 }

// LTR → defer to engine (undefined)
check('LTR defers', marqueeVerdict({ armed: true, startX: 0, curX: 500 }, el, [90, 90, 200, 200]) === undefined)
// not armed → defer
check('unarmed defers', marqueeVerdict({ armed: false, startX: 500, curX: 0 }, el, [90, 90, 200, 200]) === undefined)

// RTL: rect touches element edge → select
check('RTL touch selects', marqueeVerdict({ armed: true, startX: 500, curX: 0 }, el, [140, 90, 200, 200]) === true)
// RTL: rect overlaps interior → select
check('RTL overlap selects', marqueeVerdict({ armed: true, startX: 500, curX: 0 }, el, [120, 110, 130, 130]) === true)
// RTL: rect fully contains → select
check('RTL contains selects', marqueeVerdict({ armed: true, startX: 500, curX: 0 }, el, [0, 0, 1000, 1000]) === true)
// RTL: no contact (right of element) → reject
check('RTL miss rejects', marqueeVerdict({ armed: true, startX: 500, curX: 0 }, el, [200, 0, 300, 1000]) === false)
// RTL: no contact (gap) → reject
check('RTL gap rejects', marqueeVerdict({ armed: true, startX: 500, curX: 0 }, el, [0, 200, 1000, 300]) === false)

// rotated element AABB
const tilted = { ...el, angle: Math.PI / 2 } // 90°: AABB swaps w/h
const b = elementAabb(tilted)
check('rotated AABB', Math.abs((b[2] - b[0]) - 40) < 1e-9 && Math.abs((b[3] - b[1]) - 50) < 1e-9, JSON.stringify(b))
check(
  'rotated touch selects',
  marqueeVerdict({ armed: true, startX: 500, curX: 0 }, tilted, [b[0] + 5, b[1] + 5, b[2], b[3]]) === true,
)

console.log(failed ? `\n${failed} FAILED` : '\nall ok')
process.exit(failed ? 1 : 0)
