#!/usr/bin/env node
import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertBundleSizeBudgets, collectBundleSizeMetrics, describeSizeMetrics } from './size-budgets.mjs'

try {
  const out = resolve('out')
  const metrics = collectBundleSizeMetrics(out)
  assertBundleSizeBudgets(metrics)
  const legacyKatexFonts = readdirSync(join(out, 'renderer', 'assets')).filter((name) => /^KaTeX_.*\.(?:woff|ttf)$/.test(name))
  if (legacyKatexFonts.length > 0) throw new Error(`KaTeX legacy font assets are still emitted: ${legacyKatexFonts.slice(0, 3).join(', ')}`)
  console.log(`Bundle size budgets passed: ${describeSizeMetrics(metrics)}`)
} catch (error) {
  console.error(`Bundle size verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
