#!/usr/bin/env node
import { assertSupportedToolchain } from './lib.mjs'

// The release scripts run on the pinned Node/npm floor declared by package.json
// and .nvmrc. Signing and notarization belong to cargo-packager and the release
// workflow, so the preflight only has to prove the Node toolchain is usable.
try {
  const versions = assertSupportedToolchain()
  console.log(`Release toolchain preflight passed: Node ${versions.node} and npm ${versions.npm}.`)
} catch (error) {
  console.error(`Release preflight failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
