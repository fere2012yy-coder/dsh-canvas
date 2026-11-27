/**
 * Workspace swap — dsh-canvas's binding to the reusable shell-column-swap
 * utility. While a canvas tab body is mounted (Excalidraw, Leafer, …), the
 * shell's center column and right column trade places; see client.jsx header
 * for the full mechanism notes and shell-column-swap.js for the engine facts
 * (explicit `grid-area` placement, why `order` broke on 0.2.1, the row-guard
 * degradation, and the adaptive flexible-track assignment).
 *
 * This module only pins dsh-canvas's names — root attribute `data-canvas-swap`,
 * variables `--dsh-canvas-swap-cols` / `--dsh-canvas-swap-handle`, style tag
 * `dsh-canvas` — and re-exports the pure helpers for tests and sibling
 * plugins.
 */
import { installShellColumnSwap, swapCss as buildSwapCss } from './shell-column-swap.js'

/** dsh-canvas's naming for the swap's root attribute / CSS variables. */
const NAMES = {
  attribute: 'data-canvas-swap',
  varPrefix: 'dsh-canvas-swap',
  tagId: 'dsh-canvas',
  logPrefix: 'dsh-canvas',
  // Column widths stay 100% engine-owned (stock behavior): transient by
  // design, defaults on restart. No persistence, no pinned sizes.
}

export { locateFrame, splitTracks, trackPx, installShellColumnSwap } from './shell-column-swap.js'

/** Build the swap stylesheet with dsh-canvas's attribute/variable names. */
export function swapCss(prefix) {
  return buildSwapCss(prefix, NAMES)
}

const { useEffect } = require('react')

/**
 * While mounted, install the swap; unmounting (any exit path — Alt+`, tab
 * close, tab switch) disposes it and restores the stock layout.
 */
export function useWorkspaceSwap() {
  useEffect(() => installShellColumnSwap(NAMES), [])
}
