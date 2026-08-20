/**
 * Standalone build for the dsh-plugin-token-usage Web panel client bundle.
 *
 * Mirrors the monorepo's client build convention (same as
 * dsh-plugin-desktop/build.mjs) so the emitted lib/client.js is
 * byte-compatible with the dsh web module table:
 *   - externals resolve through the injected `require` (browser module table);
 *   - the bundle is wrapped in `window.__ModuleLoader__.load({ id, factory })`;
 *   - the single CSS file is inlined and auto-injects a <style> tag.
 *
 * Run: `node build.mjs` (from the package root). Requires `npm install`.
 */
import { readFile } from 'node:fs/promises'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const id = 'dsh-plugin-token-usage'
const repo = fileURLToPath(new URL('.', import.meta.url))

// Browser module-table keys — the only specifiers that may stay external.
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

// The virtual id must NOT end in `.css` (tsdown css-guard) — suffix `.mjs`.
const CSS_PREFIX = '\0dsh-token-usage-css:'
const CSS_SUFFIX = '.mjs'

/** Inline one plain .css file as a JS module that injecta <style> tag once. */
const cssInline = {
  name: 'dsh-token-usage-css-inline',
  resolveId(source, importer) {
    if (!source.endsWith('.css')) return null
    const abs = importer ? resolve(dirname(importer), source) : source
    return CSS_PREFIX + abs + CSS_SUFFIX
  },
  async load(virtualId) {
    if (!virtualId.startsWith(CSS_PREFIX) || !virtualId.endsWith(CSS_SUFFIX)) return null
    const file = virtualId.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
    const source = (await readFile(file)).toString()
    return [
      `const css = ${JSON.stringify(source.toString())};`,
      `if (typeof document !== 'undefined' && document.querySelector('style[data-dsh-token-usage-css]') === null) {`,
      `  const tag = document.createElement('style');`,
      `  tag.dataset.dshTokenUsageCss = ${JSON.stringify(id + '/' + basename(file))};`,
      `  tag.textContent = css;`,
      `  document.head.appendChild(tag);`,
      `}`,
      `export {};`,
    ].join('\n')
  },
}

await build({
  cwd: repo,
  entry: { client: resolve(repo, 'src/client/index.ts') },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: false,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssInline],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

console.log(`[dsh-plugin-token-usage] built ${id} -> lib/client.js`)
