import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { createCoverageInventory, familyCoverageThresholds } from './scripts/release/coverage-inventory'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const coverageInventory = createCoverageInventory(projectRoot)

export default defineConfig({
  root: projectRoot,
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['tests/conformance/**'],
    coverage: {
      provider: 'v8',
      include: coverageInventory.includePatterns,
      reporter: ['text', 'html', 'json-summary'],
      reportOnFailure: true,
      thresholds: {
        statements: 65,
        branches: 50,
        functions: 70,
        lines: 75,
        ...familyCoverageThresholds(),
      },
    },
  },
})
