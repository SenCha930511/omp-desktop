#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

const infoPath = process.env.OMP_CONFORMANCE_INFO_FILE
const vitestPath = process.env.OMP_CONFORMANCE_VITEST_JSON
const outputPath = process.env.OMP_CONFORMANCE_REPORT ?? 'conformance-summary.json'

const readJson = (path) => {
  if (!path) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const info = readJson(infoPath)
const vitest = readJson(vitestPath)
const summary = {
  generatedAt: new Date().toISOString(),
  adapter: info
    ? {
        implementation: info.implementation,
        platform: info.platform,
        protocolVersion: info.protocolVersion,
        capabilities: info.capabilities ?? [],
        requiredCapabilities: info.requiredCapabilities ?? [],
        missingRequiredCapabilities: (info.requiredCapabilities ?? []).filter((capability) => !(info.capabilities ?? []).includes(capability)),
      }
    : null,
  tests: vitest
    ? {
        total: vitest.numTotalTests ?? 0,
        passed: vitest.numPassedTests ?? 0,
        failed: vitest.numFailedTests ?? 0,
        skipped: vitest.numPendingTests ?? 0,
        success: vitest.success ?? false,
      }
    : null,
}

writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(`Wrote ${outputPath}`)
