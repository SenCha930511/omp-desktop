#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runCommand } from './lib.mjs'

/**
 * `npx electron .` launches node_modules/electron/dist/Electron.app, so macOS
 * shows the stock "Electron" name (menu bar, Dock, app switcher) no matter
 * what the in-app menu template labels itself. Rebrand that development
 * bundle after install: the app name comes from CFBundleName/CFBundleDisplayName
 * and the Dock icon from CFBundleIconFile (electron.icns). The bundle
 * identifier also moves off stock `com.github.Electron` so LaunchServices never
 * confuses this dev copy with any other Electron checkout on the machine —
 * a stale or colliding registration is what keeps the Dock label "Electron".
 * The edited files are sealed by the bundle's ad-hoc signature, so the bundle
 * is re-signed ad hoc after the edit. Packaged builds get all of this from
 * electron-builder and are untouched; non-darwin platforms are skipped
 * because there is no bundle.
 */
export const DEV_APP_NAME = 'OMP Desktop'
export const DEV_BUNDLE_IDENTIFIER = 'app.ompdesktop.dev'

export const DEV_LSREGISTER_PATH = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))

export function defaultDevElectronPaths() {
  return {
    appBundle: join(repositoryRoot, 'node_modules', 'electron', 'dist', 'Electron.app'),
    iconSource: join(repositoryRoot, 'assets', 'icon.icns'),
  }
}

/** Reads one string value from a property list, tolerating missing keys as empty. */
export function readPlistString(plistPath, key, capture = captureCommandOutput) {
  const value = capture('plutil', ['-extract', key, 'raw', '-o', '-', plistPath])
  return value.trim()
}

function captureCommandOutput(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? `signal ${result.signal}`}`)
  return result.stdout ?? ''
}

function filesEqual(left, right) {
  if (!existsSync(left) || !existsSync(right)) return false
  return readFileSync(left).equals(readFileSync(right))
}

/**
 * @param {(command: string, args: string[]) => unknown} run
 * @param {NodeJS.Platform} platform
 * @param {{ appBundle?: string, iconSource?: string, capture?: (command: string, args: string[]) => string }} options
 */
export function brandDevElectron(run = runCommand, platform = process.platform, options = {}) {
  if (platform !== 'darwin') return { changed: false, reason: 'non-darwin platform' }
  const paths = { ...defaultDevElectronPaths(), ...options }
  if (!existsSync(paths.appBundle)) return { changed: false, reason: 'dev Electron.app not found' }

  const plistPath = join(paths.appBundle, 'Contents/Info.plist')
  const iconTarget = join(paths.appBundle, 'Contents/Resources/electron.icns')
  const plistUpdates = [
    { key: 'CFBundleName', value: DEV_APP_NAME },
    { key: 'CFBundleDisplayName', value: DEV_APP_NAME },
    { key: 'CFBundleIdentifier', value: DEV_BUNDLE_IDENTIFIER },
  ].filter((update) => readPlistString(plistPath, update.key, options.capture) !== update.value)
  const iconStale = !filesEqual(paths.iconSource, iconTarget)
  if (plistUpdates.length === 0 && !iconStale) return { changed: false, reason: 'already branded' }

  for (const { key, value } of plistUpdates) run('plutil', ['-replace', key, '-string', value, plistPath])
  if (iconStale) copyFileSync(paths.iconSource, iconTarget)
  run('codesign', ['--force', '--sign', '-', paths.appBundle])
  // LaunchServices caches the stock registration; without a forced refresh the
  // Dock keeps labelling the tile "Electron" even though the plist is patched.
  run(DEV_LSREGISTER_PATH, ['-f', paths.appBundle])
  return { changed: true, renamedKeys: plistUpdates.map((update) => update.key), iconUpdated: iconStale }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = brandDevElectron()
    if (result.changed) console.log(`Branded dev Electron.app as ${DEV_APP_NAME}${result.iconUpdated ? ' (icon refreshed)' : ''}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
