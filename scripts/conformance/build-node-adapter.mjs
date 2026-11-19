#!/usr/bin/env node
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const entryPoint = resolve(projectRoot, 'tests', 'conformance', 'adapters', 'node-adapter.ts')
const outfile = resolve(projectRoot, 'out', 'conformance', 'node-adapter.mjs')
const electronShim = resolve(projectRoot, 'tests', 'conformance', 'adapters', 'electron-shim.ts')

mkdirSync(dirname(outfile), { recursive: true })

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['node-pty'],
  sourcemap: 'inline',
  banner: {
    js: "import { createRequire as __conformanceCreateRequire } from 'node:module'; const require = __conformanceCreateRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'conformance-electron-shim',
      setup(pluginBuild) {
        pluginBuild.onResolve({ filter: /^electron$/ }, () => ({ path: electronShim }))
      },
    },
  ],
})

console.log(`Built conformance reference adapter: ${outfile}`)
