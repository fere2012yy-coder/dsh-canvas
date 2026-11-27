# dsh-canvas

English | [中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness) plugin that adds two canvas workspace tabs to the native right sidebar — **DSH Canvas** (Excalidraw whiteboard) and **DSH-Flow** (a React Flow node canvas) — and flips the whole shell into a canvas-first layout on demand.

## Features

- **DSH Canvas tab** — a "DSH Canvas" card in the right sidebar's guide panel; clicking it (or pressing <kbd>Alt</kbd>+<kbd>\`</kbd>) opens the Excalidraw whiteboard tab.
- **DSH-Flow tab** — a "DSH-Flow" card opens a [React Flow 12](https://reactflow.dev) node canvas: text nodes, arrow edges, and Project Graph-style camera feel (see keys below). The board persists to `localStorage` and survives restarts.
- **Workspace swap** — opening either canvas tab trades the center (conversation) column and the whole right column: the canvas and its side panels take the middle, the chat docks to the right edge. Closing the tab restores the stock layout.
- **Native feel** — the divider line stays visible and draggable with natural direction, column widths follow window resizes live, and every exit path (shortcut, tab close, tab switch) restores the original layout.

## DSH-Flow keys and interactions

| Input | Action |
|---|---|
| Double-click empty canvas | create a text node |
| Double-click title / summary row | edit it in place (<kbd>Enter</kbd> commits, <kbd>Esc</kbd> cancels) |
| Drag between node handles | connect with an arrow edge |
| Right-click node | recolor (5-color palette) / delete |
| Right-click canvas | create node / export PNG |
| <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> (hold) | camera pan (continuous, eased) |
| <kbd>]</kbd> / <kbd>[</kbd> (hold) | zoom in / out — ×1.05 / ×0.95 per frame, eased |
| <kbd>Enter</kbd> / <kbd>F2</kbd> | edit the selected node's title |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> | undo / redo (snapshot stack) |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | delete selection |
| <kbd>Esc</kbd> | clear selection / close menu |

Mouse wheel zooms with the cursor anchored; dragging empty canvas pans. The keyboard camera only moves a *target* — an rAF lerp eases the real viewport toward it (Project Graph feel), while wheel and drag keep d3-zoom's direct control. The keybind engine stays silent while a node editor is open or focus is in any editable element.

## How the swap works

DSH's shell frame (`AppFrame`) is a 3-track CSS grid whose column widths are recomputed in JS and written as an inline `grid-template-columns`. The swap therefore:

1. Re-places the three columns explicitly with CSS `grid-area` (center → track 3, rightbar → track 2, sidebar → track 1) and pins the shell's `[data-shell-bottom]` row to row 2. Explicit placement, **not `order`**: since 0.2.1 the frame also holds a bottom-row grid item, and `order` re-sequences auto-placement — the two swapped half-columns would be pushed past that row into an implicit third row.
2. Mirrors the shell's own inline declaration — segments swapped textually — into a CSS variable applied with `!important`. The shell keeps owning every number; recomputes (drag, resize, collapse) are followed live.
3. Locates the frame through the stable `[data-rightbar-col]` attribute and derives the css-module hash prefix from the live `className` — engine upgrades rename the hashes (0.1.7 `pI_x6G_` → 0.2.0/0.2.1 `BynINW_`), nothing here is hardcoded.
4. Re-emits divider drags with `clientX` mirrored around the drag origin, converting the shell's right-anchored width drag into the natural left-anchored feel.
5. Degrades to a no-op: if the swapped frame ever reports more rows than the two known ones, the swap disables itself and the stock (usable) layout returns.

When the right column loses its track (collapsed / overlay mode), the swap steps aside automatically and resumes when the track returns.

## Reusing the swap in another plugin

The whole mechanism lives in [`src/shell-column-swap.js`](src/shell-column-swap.js) — zero dependencies, no React. Any plugin that mounts a surface into the native right sidebar can reuse it:

```js
import { installShellColumnSwap } from './shell-column-swap.js'

// While your surface is mounted, trade the center and right columns.
// Names are per-plugin, so several plugins can coexist safely.
const dispose = installShellColumnSwap({
  attribute: 'data-myplugin-swap', // root <html> toggle (default data-shell-swap)
  varPrefix: 'myplugin-swap',      // --myplugin-swap-cols / -handle (default shell-swap)
  tagId: 'my-plugin',              // marker on the injected <style> tag
  logPrefix: 'my-plugin',          // console.warn prefix
})

// On every exit path (tab close, shortcut, tab switch) — restore the stock layout:
dispose()
```

What you get for free: explicit `grid-area` placement (0.2.1-safe), live mirroring of the shell's own column widths, auto step-aside when the right track collapses, natural-direction divider drags, and the rows-guard degradation to the stock layout.

## Install

```sh
dsh plugin --profile desktop add <local-path-or-github:owner/repo>
```

Restart the DSH desktop app afterwards. Requires the web client — tested against the DSH desktop engine **0.2.1-rc.1** (and its 0.2.0 layout).

## Build

```sh
npm install
npm run build   # esbuild → lib/client.js (browser) + lib/index.js (host)
```

## Test

The acceptance suites drive the REAL DSH desktop app over CDP (port 9222 — start the app with the bundled `DSH-debug.bat` launcher or any `--remote-debugging-port=9222` flag):

```sh
npm test          # runs all four suites in order
npm run test:phase1   # mount/swap · create · connect · zoom anchor · pan · persist
npm run test:phase2   # editing · palette · context menu · undo/redo · delete · PNG export
npm run test:phase3   # camera feel: WASD · [ ] zoom · lerp · Enter/F2 · edit guards
npm run test:phase4   # Excalidraw canvas: canvas management · wheel swap · stock dblclick · session binding
node tests/verify-021-adaptation.mjs   # 0.2.1 layout regression: swap grid, collapse/expand, fullscreen, divider drag, session pin
```

⚠️ After rebuilding the bundle, RESTART the DSH app before testing — the browser keeps whatever bundle was current at its boot. Never refresh over CDP with `Network.clearBrowserCache`: it permanently breaks the app's boot.

Note (0.2.x Desktop): configurable shortcuts such as <kbd>Alt</kbd>+<kbd>\`</kbd> are dispatched from native keyboard input through the trusted preload bridge, so CDP-synthesized key events can never trigger them — tests open the tab through the plugin's test bridge instead.

## Structure

| Path | Role |
|---|---|
| `src/index.js` | host half — a no-op so the loader can mount the package |
| `src/client.jsx` | browser half — tab registration, <kbd>Alt</kbd>+<kbd>\`</kbd> shortcut, workspace swap, CDP test bridge |
| `src/canvas/CanvasFlow.jsx` | DSH-Flow board — state, camera (target+lerp), persistence, PNG export |
| `src/canvas/TextNode.jsx` | the text node with in-place editing |
| `src/canvas/ContextMenu.jsx` | right-click menu (recolor/delete · create/export) |
| `src/canvas/useUndoRedo.js` | snapshot undo/redo stacks |
| `src/canvas/palette.js` | the 5-color palette + node action context |
| `src/keyboard.js` | keybind engine (chords, sequences, continuous holds, `when` guards) |
| `src/workspace-swap.js` | the center/right column swap — thin dsh-canvas binding (names + React hook) |
| `src/shell-column-swap.js` | reusable, framework-free shell column swap (`installShellColumnSwap`) — any right-sidebar plugin can use it |
| `scripts/build-client.mjs` | bundles the browser half into the DSH module-loader format |
| `scripts/asar-tool.mjs` | read-only ASAR lister/extractor (inspect the installed engine's bundles) |
| `tests/harness-interactions.mjs` | unified CDP regression runner (`npm test`) |
| `tests/verify-021-adaptation.mjs` | 0.2.1 shell-layout adaptation suite (swap / collapse / fullscreen / drag / pin) |
| `tests/flow-phase*.mjs` | the three acceptance suites |
| `lib/` | build output (kept in the repo; the shipped bundle) |

## License

MIT
