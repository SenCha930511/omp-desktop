import { constants as fsConstants } from 'node:fs'
import { access, copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { CURRENT_DESKTOP_STATE_FILENAME, LEGACY_DESKTOP_STATE_FILENAME } from './store'

/**
 * OMP Desktop-era application data directory that OMP Desktop migrates from on
 * first run. Only the productName changed, so Electron derives a different
 * `userData` directory and the app-owned files inside would otherwise be
 * abandoned on upgrade.
 */
export const LEGACY_USER_DATA_DIR_NAME = 'GooeyPi'

/** Per-file and total copy bounds; every migrated file is app-owned and small. */
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 64 * 1024 * 1024

/**
 * App-owned files worth carrying across the rename. Chromium profile and
 * cache directories are deliberately excluded: the browser partition name
 * changed with the rename, so those trees cannot be reused.
 */
const MIGRATED_FILES = [
  'agent-message-signing.key',
  'voice-secrets.json',
  'crash.log',
  CURRENT_DESKTOP_STATE_FILENAME,
  LEGACY_DESKTOP_STATE_FILENAME,
  'prime-work-state-v4.json',
  'prime-work-state.json',
]

/** State file names recorded before the OMP Desktop rename, mapped to their new names. */
const RENAMED_STATE_FILES: Record<string, string> = {
  'prime-work-state-v4.json': CURRENT_DESKTOP_STATE_FILENAME,
  'prime-work-state.json': LEGACY_DESKTOP_STATE_FILENAME,
}

export interface UserDataMigrationReport {
  migrated: boolean
  reason?: 'new-state-exists' | 'legacy-dir-missing' | 'empty'
  copiedFiles: string[]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Copies the app-owned files from OMP Desktop's old `userData` directory into the
 * OMP Desktop one, renaming the pre-rename state files to their current
 * names, when the new directory has no state file yet. The copy is bounded
 * per file and in total, never overwrites an existing file, and leaves the
 * legacy directory untouched so nothing is lost if it fails partway.
 */
export async function migrateLegacyUserData(appDataPath: string, userDataPath: string, legacyDirNames = [LEGACY_USER_DATA_DIR_NAME]): Promise<UserDataMigrationReport> {
  if (await pathExists(join(userDataPath, CURRENT_DESKTOP_STATE_FILENAME))) {
    return { migrated: false, reason: 'new-state-exists', copiedFiles: [] }
  }
  for (const legacyDirName of legacyDirNames) {
    const report = await migrateFromDirectory(join(appDataPath, legacyDirName), userDataPath)
    if (report.migrated || report.reason === 'empty') return report
  }
  return { migrated: false, reason: 'legacy-dir-missing', copiedFiles: [] }
}

async function migrateFromDirectory(legacyDir: string, userDataPath: string): Promise<UserDataMigrationReport> {
  if (!(await pathExists(legacyDir))) {
    return { migrated: false, reason: 'legacy-dir-missing', copiedFiles: [] }
  }
  const copyable: Array<{ source: string; target: string }> = []
  let totalBytes = 0
  for (const name of MIGRATED_FILES) {
    const source = join(legacyDir, name)
    try {
      const info = await stat(source)
      if (!info.isFile() || info.size > MAX_FILE_BYTES || totalBytes + info.size > MAX_TOTAL_BYTES) continue
      totalBytes += info.size
      copyable.push({ source, target: join(userDataPath, RENAMED_STATE_FILES[name] ?? name) })
    } catch { /* missing entries are skipped */ }
  }
  if (!copyable.length) return { migrated: false, reason: 'empty', copiedFiles: [] }
  await mkdir(userDataPath, { recursive: true })
  const copiedFiles: string[] = []
  for (const entry of copyable) {
    if (await pathExists(entry.target)) continue
    try {
      // Rename state files atomically through a copy+rename pair so a mid-copy
      // crash can never leave a truncated state file under the new name.
      const staging = `${entry.target}.migrating-${process.pid}`
      await copyFile(entry.source, staging)
      await rename(staging, entry.target)
      copiedFiles.push(entry.target)
    } catch (error) {
      console.error(`OMP Desktop could not migrate ${entry.source}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Removing the staging leftovers of interrupted attempts is best-effort.
  try {
    for (const entry of await readdir(userDataPath)) {
      if (entry.includes('.migrating-')) console.warn(`OMP Desktop left a partial migration file behind: ${entry}`)
    }
  } catch { /* listing is advisory only */ }
  return { migrated: true, copiedFiles }
}
