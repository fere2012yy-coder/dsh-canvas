#!/usr/bin/env node
/**
 * Build the browser half of dsh-canvas into the dsh browser bundle format:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } })
 *
 * The bundle id must equal the package name — the host's client-module
 * registry serves it at /plugins/dsh-canvas/client.js.
 *
 * Excalidraw (and react-dom) are bundled inline; react / react/jsx-runtime
 * stay external — the dsh shell provides them. Its stylesheet and fonts are
 * NOT bundled: CanvasBody injects a <link> to the CDN copy at runtime, so
 * font urls resolve against the CDN and the bundle stays lean.
 */
import { build } from 'esbuild'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const excalidrawVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/@excalidraw/excalidraw/package.json'), 'utf8'),
).version

/**
 * Directional marquee patch — replaces the containment-only verdict inside
 * the bundled `getElementsWithinSelection` (prod chunk, exact minified
 * string) with an optional hook: `window.__dshCanvasMarquee(element, rect)`
 * returning true/false overrides the containment test, anything else keeps
 * the stock behavior. dsh-canvas's client installs the hook (see
 * src/canvas/marquee-direction.js) to make right-to-left marquees select on
 * touch. If the stock string is not found the build FAILS LOUDLY — never
 * patch silently: re-derive the minified form from the new engine.
 */
const MARQUEE_STOCK =
  'c.locked===!1&&c.type!=="selection"&&!Ne(c)&&o<=l&&i<=U&&a>=p&&s>=m'
// `??` not `?:` — the hook returns undefined to DEFER to the stock verdict;
// a ternary turns that undefined into a falsy rejection and kills the stock
// containment entirely (regression caught live 2026-10-17).
const MARQUEE_PATCHED =
  'c.locked===!1&&c.type!=="selection"&&!Ne(c)&&(window.__dshCanvasMarquee?(window.__dshCanvasMarquee(c,[o,i,a,s])??(o<=l&&i<=U&&a>=p&&s>=m)):(o<=l&&i<=U&&a>=p&&s>=m))'
const marqueeDirectionPlugin = {
  name: 'dsh-marquee-direction',
  setup(build) {
    build.onLoad({ filter: /chunk-[A-Za-z0-9_-]+\.js$/ }, async (args) => {
      const text = readFileSync(args.path, 'utf8')
      if (!text.includes(MARQUEE_STOCK)) return null
      return {
        contents: text.replace(MARQUEE_STOCK, MARQUEE_PATCHED),
        loader: 'js',
        resolveDir: dirname(args.path),
      }
    })
  },
}

const result = await build({
  entryPoints: [join(root, 'src', 'client.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  jsx: 'automatic',
  // CSS imports become text modules: injected styles ship as runtime
  // <style> tags, keeping the bundle self-contained (Excalidraw is
  // unaffected — it loads via a CDN <link>).
  loader: { '.css': 'text' },
  plugins: [marqueeDirectionPlugin],
  minify: true,
  define: {
    'process.env.IS_PREACT': 'false',
    'process.env.EXCALIDRAW_ASSET_PATH': `"https://unpkg.com/@excalidraw/excalidraw@${excalidrawVersion}/dist/prod/"`,
  },
  write: false,
  logLevel: 'info',
})
const body = result.outputFiles[0].text.trim()

const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-canvas",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		if (typeof process === "undefined") { window.process = { env: {} }; }
${body}
		return module.exports;
	}
});`

mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib', 'client.js'), wrapped)
// Host half: plain ESM passthrough. Peer deps (@deepseek-ai/dsh-tools) are
// resolved by the DSH host runtime at load time — same pattern as
// dsh-obsidian-mem — never bundled.
await build({
  entryPoints: [join(root, 'src', 'index.js')],
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: ['node22'],
  outfile: join(root, 'lib', 'index.js'),
  logLevel: 'info',
})
console.log('build-client: wrote lib/client.js and lib/index.js')
