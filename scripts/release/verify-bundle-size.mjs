#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertBundleSizeBudgets, collectBundleSizeMetrics, describeSizeMetrics } from './size-budgets.mjs'

try {
  const out = resolve(process.argv[2] ?? 'out')
  const metrics = collectBundleSizeMetrics(out)
  assertBundleSizeBudgets(metrics)
  const entryHtml = readFileSync(join(out, 'renderer', 'index.html'), 'utf8')
  const eagerKatexAsset = entryHtml.match(/<(?:script|link)\b[^>]*\b(?:src|href)=["'][^"']*katex-vendor(?:-[^/"']+)?\.(?:js|css)(?:[?#][^"']*)?["'][^>]*>/i)
  if (eagerKatexAsset) throw new Error(`Renderer index must not initially reference katex-vendor JavaScript or CSS: ${eagerKatexAsset[0]}`)
  const legacyKatexFonts = readdirSync(join(out, 'renderer', 'assets')).filter((name) => /^KaTeX_.*\.(?:woff|ttf)$/.test(name))
  if (legacyKatexFonts.length > 0) throw new Error(`KaTeX legacy font assets are still emitted: ${legacyKatexFonts.slice(0, 3).join(', ')}`)
  console.log(`Bundle size budgets passed: ${describeSizeMetrics(metrics)}`)
} catch (error) {
  console.error(`Bundle size verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
