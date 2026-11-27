# dsh-canvas

English | [中文](README.zh.md)

A [DeepSeek Harness (DSH)](https://deepseek-harness.github.io/deepseek-harness) plugin that adds a **DSH Canvas** (Excalidraw whiteboard) tab to the native right sidebar, and can flip the whole shell into a canvas-first layout on demand.

## Features

- **DSH Canvas tab** — a "DSH Canvas" card in the right sidebar's guide panel; clicking it (or pressing <kbd>Alt</kbd>+<kbd>\`</kbd>) opens the Excalidraw whiteboard (embedded `@excalidraw/excalidraw`).
- **Canvas management** — top-left menu: new canvas / canvas list / delete current. Each canvas persists to `localStorage` and survives tab closes and restarts.
- **Right-drag arrows** — hold the **right** mouse button and drag to draw an arrow (no shortcut needed): tail at press, head at release, endpoints snap to elements; releasing over blank canvas creates a new text element bound to the arrow. A plain right-click still opens the stock menu; Ctrl/Alt+right stays reserved for session binding.
- **Session binding** — Ctrl+right-click an element opens a menu (create & bind session / bind existing… / unbind); the binding lives in the official `element.link` (`dsh-session://<id>`) and follows copies/exports. **Ctrl+click a bound element = switch to that session** (via the client's `sessions.create` + `uiWorkspace.openSession`). The sidebar tab closes when the session switches; reopen to restore.
- **Ctrl+S remembers the save path** — after saving an `.excalidraw` file its handle is stored in IndexedDB per canvas, so a later Ctrl+S overwrites the same file across restarts (image-export paths are deliberately not remembered).
- **Space = selection tool** — holding <kbd>Space</kbd> switches to the selection tool (replacing stock hold-space-to-pan); typing and view mode are untouched.
- **Wheel swap** — wheel = cursor-anchored zoom, Ctrl+wheel = scroll (inverse of Excalidraw defaults), via capture-phase interception + `updateScene`.
- **Workspace swap** — while a canvas tab is open, the center (conversation) column and the whole right column trade places; closing the tab restores the stock layout.

## How the swap works

The DSH shell's `AppFrame` is a three-track CSS Grid whose column widths are recomputed and written inline. The swap therefore:

1. Places the three columns **explicitly** with `grid-area` (center → track 3, right → track 2, left → track 1) and pins the `[data-shell-bottom]` row to row 2. `order` cannot be used: since 0.2.1 AppFrame has an extra bottom-row item, and `order` re-flows auto-placement into a hidden third row.
2. **Mirrors the shell's own inline declaration** (segments 2/3 swapped) into CSS variables applied with `!important` — every value stays owned by the shell, so divider drags, resizes and collapses keep following live.
3. Locates the frame via the stable `[data-rightbar-col]` attribute and extracts the css-module hash prefix from its className (hashes change between engine releases — 0.1.7 `pI_x6G_` → 0.2.0/0.2.1 `BynINW_`); nothing is hardcoded.
4. Forwards divider drags with `clientX` mirrored around the drag origin, turning the shell's right-anchored width drag into a natural left-anchored feel.
5. Degrades safely: if the frame grows beyond the known two rows after a swap, the swap shuts off and returns to the usable native layout.

When the right track disappears (collapse/overlay), the swap yields automatically and resumes when the track returns.

## Reusing the column swap from other plugins

The whole mechanism lives in [`src/shell-column-swap.js`](src/shell-column-swap.js) — zero dependencies, no React. Any plugin that mounts into the native right sidebar can use it:

```js
import { installShellColumnSwap } from './shell-column-swap.js'

// While your panel is mounted, center and right columns trade places.
// Namespaces are per-plugin; several plugins can coexist.
const dispose = installShellColumnSwap({
  attribute: 'data-myplugin-swap', // toggle attribute on <html> (default data-shell-swap)
  varPrefix: 'myplugin-swap',      // --myplugin-swap-cols / -handle (default shell-swap)
  tagId: 'my-plugin',              // marker of the injected <style>
  logPrefix: 'my-plugin',          // console warning prefix
})

// Call on EVERY exit path (tab close, shortcut, tab switch) to restore the stock layout:
dispose()
```

Included for free: explicit `grid-area` placement (0.2.1-safe), live mirroring of shell widths, auto-yield on right-track collapse, natural-direction divider dragging, row-guard fallback to the native layout.

## Install

```sh
dsh plugin --profile desktop add <local path or github:owner/repo>
```

Restart the DSH desktop app afterwards. Requires the web client — tested on desktop engine **0.2.1-rc.1** (0.2.0 layout compatible).

## Build

```sh
npm install
npm run build   # esbuild → lib/client.js (browser half) + lib/index.js (host half)
```

## Testing

Acceptance tests drive a **real DSH desktop instance** over CDP (port 9222) — launch the app with `--remote-debugging-port=9222` (or any equivalent launcher), then:

```sh
npm test             # unified CDP regression entry (harness-interactions.mjs)
npm run test:phase4  # Excalidraw features: canvas management · wheel swap · native dblclick · session binding
node tests/verify-021-adaptation.mjs   # 0.2.1 layout regression: swap grid · collapse/expand · fullscreen · drag · session pin
node tests/verify-save-handle.mjs      # Ctrl+S save-handle persistence
```

⚠️ After rebuilding the bundle you must **restart the DSH app** before testing — the browser keeps the bundle it started with. Never refresh via CDP `Network.clearBrowserCache`: it permanently breaks the app's bootstrap.

Note (0.2.x desktop): configurable shortcuts such as <kbd>Alt</kbd>+<kbd>\`</kbd> are dispatched by the Windows native keyboard through a trusted preload bridge; CDP-synthesized key events cannot trigger them, so tests use the plugin's test bridge to open the tab.

## Layout

| Path | Role |
|---|---|
| `src/index.js` | Host half — no-op, lets the loader mount the package |
| `src/client.jsx` | Browser half — tab registration, <kbd>Alt</kbd>+<kbd>\`</kbd> shortcut, workspace swap, CDP test bridge |
| `src/canvas/excalidraw-canvas-store.js` | Multi-canvas management + localStorage persistence |
| `src/canvas/right-drag-arrow.js` | Right-drag arrows (endpoint snapping + blank-release element binding) |
| `src/canvas/file-handle-store.js` | IndexedDB persistence of Ctrl+S file handles |
| `src/canvas/space-to-select.js` | Space → selection tool |
| `src/canvas/marquee-direction.js` | Marquee-selection feel fix |
| `src/canvas/frame-erase-rescue.js` | Frame erase rescue |
| `src/canvas/command-executor.js` | Canvas command executor (CDP test bridge) |
| `src/keyboard.js` | Keyboard engine (chords, sequences, hold-repeat, `when` guards) |
| `src/workspace-swap.js` | Center/right swap — dsh-canvas's thin wrapper (namespacing + React hook) |
| `src/shell-column-swap.js` | Reusable, dependency-free shell column swap (`installShellColumnSwap`) for any sidebar plugin |
| `scripts/build-client.mjs` | Bundles the browser half into the DSH module-loader format |
| `scripts/asar-tool.mjs` | Read-only ASAR list/extract tool (inspect an installed engine's bundle) |
| `tests/harness-interactions.mjs` | Unified CDP regression entry (`npm test`) |
| `tests/verify-021-adaptation.mjs` | 0.2.1 shell-layout adaptation suite |
| `lib/` | Build output (shipped in the repo; this is the installed package) |

## License

MIT
