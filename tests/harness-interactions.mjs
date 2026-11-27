#!/usr/bin/env node
/**
 * Unified CDP regression runner for the dsh-canvas plugin.
 *
 * Executes the acceptance suite(s) against the live DSH desktop over
 * CDP 9222, in order, and exits non-zero if ANY suite fails:
 *
 *   canvas-features.mjs — canvas management, wheel swap, session binding,
 *                         UI persistence, Excalidraw integration
 *
 * 🔴 After a bundle change RESTART the DSH host first (DSH-debug.bat) —
 * never refresh over CDP with clearBrowserCache (it bricks the boot).
 * Run: node tests/harness-interactions.mjs   (or npm test)
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const suites = ['canvas-features.mjs']

const failed = []
for (const suite of suites) {
  console.log(`\n========== ${suite} ==========`)
  const result = spawnSync(process.execPath, [join(root, 'tests', suite)], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) failed.push(suite)
}

console.log('\n========== SUMMARY ==========')
if (failed.length) {
  console.log(`FAILED suites: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(`all ${suites.length} suites passed`)
