import { createHash, randomUUID } from 'node:crypto'
import { renameSync, type BigIntStats, type Stats } from 'node:fs'
import { lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { CapabilityMutationInput, HarnessId, McpConnectionInput, McpStateInput, ProcessOutcome } from '../../../src/types/api'
import { assessMcpUrl, isAppManageableLocalMcpKey, MAX_MCP_DEFINITION_KEY_LENGTH } from '../../../src/lib/mcp-policy'
import { isPathWithin, isRecord, requireString } from '../validation'
import { errorCode, readAtMost } from './file-io'

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
const SETTINGS_LOCK_ATTEMPTS = 40
const SETTINGS_LOCK_RETRY_MS = 50
const SETTINGS_LOCK_OWNER = 'owner.json'
const SETTINGS_UPDATE_ATTEMPTS = 4

interface SettingsLockOwner {
  version: 1
  pid: number
  token: string
  createdAt: number
}

type FingerprintSettings = (path: string) => Promise<string>

export interface ProjectSettingsPath {
  path: string
  verify(): Promise<void>
}

function parseSettingsLockOwner(value: unknown): SettingsLockOwner | null {
  if (!isRecord(value) || value.version !== 1) return null
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null
  if (typeof value.token !== 'string' || value.token.length < 1 || value.token.length > 200) return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt <= 0) return null
  return { version: 1, pid: value.pid as number, token: value.token, createdAt: value.createdAt }
}

function sameSettingsLockOwner(left: SettingsLockOwner | null, right: SettingsLockOwner): boolean {
  return left?.version === right.version && left.pid === right.pid && left.token === right.token && left.createdAt === right.createdAt
}

async function readSettingsForUpdate(path: string, agentName = 'OMP'): Promise<{ settings: Record<string, unknown>; fingerprint: string; source: string | null }> {
  let content: string
  try {
    const value = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (value.truncated) throw new TypeError(`${agentName} settings exceed the maximum supported size`)
    content = value.content
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { settings: {}, fingerprint: 'missing', source: null }
    if (error instanceof TypeError && error.message.includes('maximum supported size')) throw error
    throw new TypeError(`${agentName} settings are not valid JSON; fix them before connecting an MCP server`)
  }
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new TypeError(`${agentName} settings are not valid JSON; fix them before connecting an MCP server`) }
  if (!isRecord(value)) throw new TypeError(`${agentName} settings must contain a JSON object`)
  return { settings: value, fingerprint: createHash('sha256').update(content).digest('hex'), source: content }
}

export async function settingsFingerprint(path: string): Promise<string> {
  try {
    const value = await readAtMost(path, MAX_SETTINGS_BYTES)
    if (value.truncated) throw new TypeError('OMP settings exceed the maximum supported size')
    return createHash('sha256').update(value.content).digest('hex')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing'
    throw error
  }
}

async function readSettingsLockOwner(lockPath: string): Promise<SettingsLockOwner | null> {
  try {
    const { content, truncated } = await readAtMost(join(lockPath, SETTINGS_LOCK_OWNER), 4 * 1024)
    if (truncated) return null
    return parseSettingsLockOwner(JSON.parse(content) as unknown)
  } catch { return null }
}

function isProcessProvablyDead(pid: number): boolean {
  if (pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

async function createSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  try {
    await mkdir(lockPath, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }

  const owner: SettingsLockOwner = { version: 1, pid: process.pid, token: randomUUID(), createdAt: Date.now() }
  try {
    await writeFile(join(lockPath, SETTINGS_LOCK_OWNER), `${JSON.stringify(owner)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true })
    throw error
  }
  return async () => {
    const current = await readSettingsLockOwner(lockPath)
    if (sameSettingsLockOwner(current, owner)) await rm(lockPath, { recursive: true, force: true })
  }
}

async function recoverStaleSettingsLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const observed = await readSettingsLockOwner(lockPath)
  if (!observed || !isProcessProvablyDead(observed.pid)) return null

  // The recovery directory serializes competing reapers. The owner is checked
  // again after claiming it, so a replacement lock is never removed by token.
  const recoveryPath = `${lockPath}.recovery`
  try {
    await mkdir(recoveryPath, { mode: 0o700 })
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw error
  }
  try {
    const current = await readSettingsLockOwner(lockPath)
    if (!sameSettingsLockOwner(current, observed) || !isProcessProvablyDead(observed.pid)) return null
    await rm(lockPath, { recursive: true, force: true })
    return await createSettingsLock(lockPath)
  } finally {
    await rm(recoveryPath, { recursive: true, force: true })
  }
}

export async function acquireSettingsLock(settingsPath: string, verify?: () => Promise<void>): Promise<() => Promise<void>> {
  if (verify) await verify()
  else await mkdir(dirname(settingsPath), { recursive: true })
  const lockPath = `${settingsPath}.lock`
  for (let attempt = 0; attempt < SETTINGS_LOCK_ATTEMPTS; attempt += 1) {
    await verify?.()
    const acquired = await createSettingsLock(lockPath)
    if (acquired) {
      try { await verify?.(); return acquired } catch (error) { await acquired(); throw error }
    }
    const recovered = await recoverStaleSettingsLock(lockPath)
    if (recovered) {
      try { await verify?.(); return recovered } catch (error) { await recovered(); throw error }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, SETTINGS_LOCK_RETRY_MS))
  }
  throw new Error('OMP settings are busy; try again')
}

interface FileIdentity {
  dev: string
  ino: string
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function regularFileIdentity(path: string): Promise<FileIdentity> {
  const stat = await lstat(path, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError('OMP settings staging file changed during update')
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

async function removeOwnedFile(path: string, expected: FileIdentity): Promise<boolean> {
  try {
    if (!sameFileIdentity(await regularFileIdentity(path), expected)) return false
    await rm(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

async function rollbackSettingsRename(
  path: string,
  temporary: string,
  temporaryIdentity: FileIdentity,
  backup: string,
  backupIdentity: FileIdentity | null,
): Promise<void> {
  if (!sameFileIdentity(await regularFileIdentity(path), temporaryIdentity)) {
    throw new Error('The staged settings file could not be located for rollback')
  }
  if (backupIdentity) {
    if (!sameFileIdentity(await regularFileIdentity(backup), backupIdentity)) {
      throw new Error('The original settings backup could not be located for rollback')
    }
    await rename(backup, path)
    if (!sameFileIdentity(await regularFileIdentity(path), backupIdentity)) throw new Error('The original settings backup was not restored')
    return
  }
  await rename(path, temporary)
  if (!sameFileIdentity(await regularFileIdentity(temporary), temporaryIdentity)) throw new Error('The new settings file was not removed')
}

async function writeSettingsAtomically(
  path: string,
  settings: Record<string, unknown>,
  expectedFingerprint: string,
  source: string | null,
  fingerprint: FingerprintSettings,
  verify?: () => Promise<void>,
): Promise<boolean> {
  const token = `${process.pid}.${randomUUID()}`
  const temporary = `${path}.${token}.tmp`
  const backup = `${path}.${token}.bak`
  let temporaryIdentity: FileIdentity | null = null
  let backupIdentity: FileIdentity | null = null
  let renamed = false
  try {
    await verify?.()
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    temporaryIdentity = await regularFileIdentity(temporary)
    if (source !== null) {
      await writeFile(backup, source, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      backupIdentity = await regularFileIdentity(backup)
    }
    // Both recovery files must have been staged in the still-pinned directory.
    await verify?.()
    if (await fingerprint(path) !== expectedFingerprint) return false
    await verify?.()
    if (!sameFileIdentity(await regularFileIdentity(temporary), temporaryIdentity)) {
      throw new TypeError('OMP settings staging file changed during update')
    }
    if (backupIdentity && !sameFileIdentity(await regularFileIdentity(backup), backupIdentity)) {
      throw new TypeError('OMP settings backup changed during update')
    }
    // There is no renameat-style API in Node on macOS. Await the pin re-check
    // immediately before the rename, then prove which inode won.
    await verify?.()
    // Invoke the final filesystem operation synchronously so no libuv worker-pool
    // admission window separates it from the rename syscall; the post-rename
    // identity and pin checks below remain the authority on what actually won.
    renameSync(temporary, path)
    renamed = true
    if (!sameFileIdentity(await regularFileIdentity(path), temporaryIdentity)) {
      throw new TypeError('OMP settings target changed during update')
    }
    await verify?.()
    if (backupIdentity && !await removeOwnedFile(backup, backupIdentity)) {
      throw new TypeError('OMP settings backup changed during update')
    }
    backupIdentity = null
    return true
  } catch (error) {
    if (renamed && temporaryIdentity) {
      try {
        await rollbackSettingsRename(path, temporary, temporaryIdentity, backup, backupIdentity)
        renamed = false
      } catch (rollbackError) {
        const message = error instanceof Error ? error.message : 'OMP settings update failed'
        throw new AggregateError([error, rollbackError], `${message}; settings rollback could not be completed`)
      }
    }
    throw error
  } finally {
    if (!renamed && temporaryIdentity) await removeOwnedFile(temporary, temporaryIdentity).catch(() => false)
    if (backupIdentity) await removeOwnedFile(backup, backupIdentity).catch(() => false)
  }
}

/** HTTP header name/token per RFC 9110; values may hold ${VAR} or !command verbatim (upstream expands at load). */
const MCP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/

export function validateMcpConnection(value: unknown, _harness: HarnessId = 'omp'): McpConnectionInput {
  if (!isRecord(value)) throw new TypeError('MCP connection must be an object')
  const name = requireString(value.name, 'MCP server name', { min: 1, max: 64, trim: true })
  // OMP's mcp.json uses the stricter native map-key charset.
  if (!isAppManageableLocalMcpKey(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new TypeError('MCP server name contains unsupported characters')
  const scope = value.scope
  if (scope !== 'user' && scope !== 'project') throw new TypeError('MCP scope must be user or project')
  const projectPath = scope === 'project' ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
  const mode = value.mode === undefined ? undefined : value.mode
  if (mode !== undefined && mode !== 'create' && mode !== 'replace') throw new TypeError('MCP update mode is invalid')
  if (value.type === 'stdio') {
    // stdio 與 url 互斥(上游 schema not: required [url])。
    if (value.url !== undefined) throw new TypeError('MCP stdio definitions cannot include a URL')
    const command = requireString(value.command, 'MCP command', { min: 1, max: 2_048, trim: true })
    if (command.startsWith('-') || /[\0\r\n\u2028\u2029]/.test(command)) throw new TypeError('MCP command is invalid')
    if (value.args !== undefined && !Array.isArray(value.args)) throw new TypeError('MCP arguments must be a list')
    const args = (value.args ?? []).map((arg, index) => {
      const parsed = requireString(arg, `MCP argument ${index + 1}`, { max: 2_048 })
      if (/[\0\r\n\u2028\u2029]/.test(parsed)) throw new TypeError(`MCP argument ${index + 1} is invalid`)
      return parsed
    })
    if (args.length > 64) throw new TypeError('MCP arguments exceed the maximum count')
    return { name, scope, projectPath, ...(mode !== undefined ? { mode } : {}), type: 'stdio', command, args }
  }
  if (value.type === 'http' || value.type === 'sse') {
    // http/sse 與 command 互斥(上游 schema not: required [command])。
    if (value.command !== undefined) throw new TypeError('MCP network definitions cannot include a command')
    const url = requireString(value.url, 'MCP endpoint URL', { min: 1, max: 2_048, trim: true })
    // https 預設;純 http 僅 loopback/私有網段且須明示 allowInsecureHttp。
    // URL 內嵌帳密由 assessMcpUrl 拒絕;${VAR} 參照原樣通過,上游載入時解析。
    const assessment = assessMcpUrl(url, { allowInsecureHttp: value.allowInsecureHttp === true })
    if (!assessment.ok) throw new TypeError(assessment.error ?? 'MCP endpoint URL is invalid')
    if (value.headers !== undefined && !isRecord(value.headers)) throw new TypeError('MCP headers must be an object')
    const headerEntries = value.headers === undefined ? [] : Object.entries(value.headers)
    if (headerEntries.length > 32) throw new TypeError('MCP headers exceed the maximum count')
    const headers: Record<string, string> = {}
    for (const [key, headerValue] of headerEntries) {
      if (!MCP_HEADER_NAME_PATTERN.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new TypeError('MCP header name is invalid')
      const parsed = requireString(headerValue, `MCP header ${key}`, { max: 4_096 })
      if (/[\0\r\n\u2028\u2029]/.test(parsed)) throw new TypeError(`MCP header ${key} is invalid`)
      headers[key] = parsed
    }
    if (value.timeout !== undefined) {
      if (typeof value.timeout !== 'number' || !Number.isInteger(value.timeout) || value.timeout < 0 || value.timeout > 600_000) {
        throw new TypeError('MCP timeout must be an integer between 0 and 600000 milliseconds')
      }
    }
    if (value.requestIdFormat !== undefined && value.requestIdFormat !== 'string' && value.requestIdFormat !== 'number') {
      throw new TypeError('MCP requestIdFormat must be string or number')
    }
    return {
      name, scope, projectPath,
      ...(mode !== undefined ? { mode } : {}),
      type: value.type,
      url,
      ...(headerEntries.length ? { headers } : {}),
      ...(value.timeout !== undefined ? { timeout: value.timeout as number } : {}),
      ...(value.requestIdFormat !== undefined ? { requestIdFormat: value.requestIdFormat as 'string' | 'number' } : {}),
      ...(value.allowInsecureHttp === true ? { allowInsecureHttp: true as const } : {}),
    }
  }
  throw new TypeError('MCP transport must be stdio, http, or sse')
}

export function validateMcpStateInput(value: unknown, _harness: HarnessId = 'omp'): McpStateInput {
  if (!isRecord(value)) throw new TypeError('MCP state must be an object')
  const name = requireString(value.name, 'MCP server name', { min: 1, max: 64, trim: true })
  if (!isAppManageableLocalMcpKey(name) || ['__proto__', 'prototype', 'constructor'].includes(name)) throw new TypeError('MCP server name contains unsupported characters')
  if (value.scope !== 'user' && value.scope !== 'project') throw new TypeError('MCP scope must be user or project')
  const projectPath = value.scope === 'project' ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
  if (typeof value.enabled !== 'boolean') throw new TypeError('MCP enabled state must be a boolean')
  return { name, scope: value.scope, projectPath, enabled: value.enabled }
}

export function validateCapabilityMutation(value: unknown, harness: HarnessId = 'omp'): CapabilityMutationInput {
  if (!isRecord(value)) throw new TypeError('Capability mutation must be an object')
  if (value.kind !== 'package' && value.kind !== 'mcp') throw new TypeError('Capability kind is invalid')
  if (value.action !== 'enable' && value.action !== 'disable' && value.action !== 'remove') throw new TypeError('Capability action is invalid')
  const name = requireString(value.name, 'Capability name', { min: 1, max: 120, trim: true })
  const scope = value.scope
  if (scope !== 'user' && scope !== 'project') throw new TypeError('Capability scope must be user or project')
  const projectPath = scope === 'project' ? requireString(value.projectPath, 'projectPath', { min: 1, max: 4096 }) : undefined
  const source = value.kind === 'package'
    ? requireString(value.source, 'Package source', { min: 1, max: 2_048, trim: true })
    : value.source === undefined ? undefined : requireString(value.source, 'Associated package source', { min: 1, max: 2_048, trim: true })
  if (source && (source.startsWith('-') || /[\r\n\u2028\u2029]/.test(source))) throw new TypeError('Package source is invalid')
  let definitionKey: string | undefined
  if (value.kind === 'mcp' && value.action === 'remove' && value.definitionKey !== undefined) {
    if (typeof value.definitionKey !== 'string' || value.definitionKey.length > MAX_MCP_DEFINITION_KEY_LENGTH) {
      throw new TypeError('MCP definition key exceeds the supported removal limit')
    }
    definitionKey = value.definitionKey
  } else if (value.kind === 'mcp') {
    validateMcpStateInput({ name, scope, projectPath, enabled: value.action === 'enable' }, harness)
  }
  return {
    kind: value.kind, action: value.action, name,
    ...(definitionKey !== undefined ? { definitionKey } : {}),
    source, scope, projectPath,
  }
}

export async function prepareProjectSettingsPath(
  projectPath: string,
  options: { segments?: readonly string[]; filename?: string } = {},
): Promise<ProjectSettingsPath> {
  const projectRoot = await realpath(projectPath)
  const pinnedDirectories = new Map<string, { dev: string; ino: string }>()
  const pin = async (path: string): Promise<void> => {
    const stat = await lstat(path, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TypeError('Project MCP configuration path must remain a real directory')
    pinnedDirectories.set(path, { dev: stat.dev.toString(), ino: stat.ino.toString() })
  }
  await pin(projectRoot)
  let directory = projectRoot
  for (const segment of options.segments ?? ['.omp']) {
    const candidate = join(directory, segment)
    let existing: Stats | undefined
    try {
      existing = await lstat(candidate)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error
    }
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new TypeError(`Project ${segment} configuration path must be a real directory`)
    } else {
      await mkdir(candidate, { mode: 0o700 })
    }
    directory = await realpath(candidate)
    if (!isPathWithin(projectRoot, directory)) throw new TypeError('Project MCP configuration path escapes the project')
    await pin(directory)
  }
  const settingsPath = join(directory, options.filename ?? 'settings.json')
  const verify = async (): Promise<void> => {
    for (const [path, expected] of pinnedDirectories) {
      let stat: BigIntStats
      try { stat = await lstat(path, { bigint: true }) } catch { throw new TypeError('Project MCP configuration directory changed during update') }
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev.toString() !== expected.dev || stat.ino.toString() !== expected.ino) {
        throw new TypeError('Project MCP configuration directory changed during update')
      }
    }
    let settingsStat: Stats | undefined
    try {
      settingsStat = await lstat(settingsPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new TypeError('Project MCP settings must be a regular file')
    }
    if (settingsStat && (settingsStat.isSymbolicLink() || !settingsStat.isFile())) throw new TypeError('Project MCP settings must be a regular file')
  }
  await verify()
  return { path: settingsPath, verify }
}

export async function updateMcpSettings(
  target: string | ProjectSettingsPath,
  input: McpConnectionInput,
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string; harness?: HarnessId; schema?: string; successMessage?: string; includeType?: boolean } = {},
): Promise<ProcessOutcome> {
  const agentName = options.agentName ?? 'OMP'
  const settingsPath = typeof target === 'string' ? target : target.path
  const verify = typeof target === 'string' ? undefined : target.verify
  const release = await acquireSettingsLock(settingsPath, verify)
  try {
    for (let attempt = 0; attempt < SETTINGS_UPDATE_ATTEMPTS; attempt += 1) {
      await verify?.()
      const snapshot = await readSettingsForUpdate(settingsPath, agentName)
      await verify?.()
      const settings = snapshot.settings
      if (settings.mcpServers !== undefined && !isRecord(settings.mcpServers)) throw new TypeError(`${agentName} mcpServers setting must contain a JSON object`)
      const currentServers = isRecord(settings.mcpServers) ? settings.mcpServers : {}
      const replacing = input.mode === 'replace'
      const existing = currentServers[input.name]
      if (!replacing && Object.hasOwn(currentServers, input.name)) {
        return { ok: false, reason: 'blocked', output: `An MCP server named “${input.name}” already exists in this scope.` }
      }
      if (replacing && !isRecord(existing)) {
        return { ok: false, reason: 'blocked', output: `MCP server “${input.name}” was not found in this scope.` }
      }
      // 編輯器保存(replace):保留 harness 擁有的 auth/oauth credential 與
      // 本次未提供的欄位(headers、enabled、env、cwd),避免編輯 URL 時
      // 抹掉上游管理的授權或使用者調整。headers 只在明確提供時覆寫。
      const preserved: Record<string, unknown> = replacing && isRecord(existing) ? existing : {}
      const config: Record<string, unknown> = input.type === 'stdio'
        ? {
            ...(preserved.env !== undefined ? { env: preserved.env } : {}),
            ...(preserved.cwd !== undefined ? { cwd: preserved.cwd } : {}),
            type: 'stdio',
            command: input.command,
            ...(input.args?.length ? { args: input.args } : preserved.args !== undefined ? { args: preserved.args } : {}),
          }
        : {
            type: input.type,
            url: input.url,
            ...(input.headers !== undefined ? { headers: input.headers } : preserved.headers !== undefined ? { headers: preserved.headers } : {}),
          }
      const merged: Record<string, unknown> = {
        ...preserved,
        ...config,
        ...(preserved.auth !== undefined ? { auth: preserved.auth } : {}),
        ...(preserved.oauth !== undefined ? { oauth: preserved.oauth } : {}),
        ...(input.type !== 'stdio' && input.timeout !== undefined ? { timeout: input.timeout } : {}),
        ...(input.type !== 'stdio' && input.requestIdFormat !== undefined ? { requestIdFormat: input.requestIdFormat } : {}),
        ...(preserved.enabled !== undefined ? { enabled: preserved.enabled } : { enabled: true }),
      }
      // stdio/http 互斥:換 transport 時丟棄舊 transport 專屬欄位。
      if (input.type === 'stdio') { delete merged.url; delete merged.headers }
      else { delete merged.command; delete merged.args; delete merged.env; delete merged.cwd }
      settings.mcpServers = { ...currentServers, [input.name]: merged }
      if (options.schema && settings.$schema === undefined) settings.$schema = options.schema
      if (await writeSettingsAtomically(settingsPath, settings, snapshot.fingerprint, snapshot.source, fingerprint, verify)) {
        return { ok: true, output: options.successMessage ?? `Saved MCP server definition “${input.name}”. Start a new OMP session to load it.` }
      }
    }
    throw new Error(`${agentName} settings changed repeatedly; no MCP configuration was overwritten`)
  } finally {
    await release()
  }
}

export async function updateMcpState(
  target: string | ProjectSettingsPath,
  input: McpStateInput,
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string; harness?: HarnessId } = {},
): Promise<ProcessOutcome> {
  const agentName = options.agentName ?? 'OMP'
  const settingsPath = typeof target === 'string' ? target : target.path
  const verify = typeof target === 'string' ? undefined : target.verify
  const release = await acquireSettingsLock(settingsPath, verify)
  try {
    for (let attempt = 0; attempt < SETTINGS_UPDATE_ATTEMPTS; attempt += 1) {
      await verify?.()
      const snapshot = await readSettingsForUpdate(settingsPath, agentName)
      await verify?.()
      const settings = snapshot.settings
      if (!isRecord(settings.mcpServers)) return { ok: false, reason: 'blocked', output: `MCP server “${input.name}” was not found in this scope.` }
      const current = settings.mcpServers[input.name]
      if (!isRecord(current)) return { ok: false, reason: 'blocked', output: `MCP server “${input.name}” was not found in this scope.` }
      // disabledServers/enabledServers 是上游 mcp.json 原生的 allow/deny 清單:
      // deny 優先,allow 會覆蓋定義上的 enabled:false。切換時一併正規化,
      // 避免 GUI 顯示的狀態與上游生效狀態分叉。
      const listFor = (key: 'disabledServers' | 'enabledServers'): string[] =>
        Array.isArray(settings[key]) ? (settings[key] as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 1_024) : []
      const disabled = listFor('disabledServers')
      const allowed = listFor('enabledServers')
      // deny 優先於 allow,allow 覆蓋定義上的 enabled:false(上游 mcp-schema 語意)。
      const currentlyEnabled = !disabled.includes(input.name) && (current.enabled !== false || allowed.includes(input.name))
      if (currentlyEnabled === input.enabled && !disabled.includes(input.name) && !allowed.includes(input.name)) {
        return { ok: true, output: `MCP server “${input.name}” is already ${input.enabled ? 'enabled' : 'disabled'}.` }
      }
      if (input.enabled) {
        if (disabled.includes(input.name)) settings.disabledServers = disabled.filter((item) => item !== input.name)
        settings.mcpServers = { ...settings.mcpServers, [input.name]: { ...current, enabled: true } }
      } else {
        if (allowed.includes(input.name)) settings.enabledServers = allowed.filter((item) => item !== input.name)
        settings.mcpServers = { ...settings.mcpServers, [input.name]: { ...current, enabled: false } }
      }
      if (Array.isArray(settings.disabledServers) && settings.disabledServers.length === 0) delete settings.disabledServers
      if (Array.isArray(settings.enabledServers) && settings.enabledServers.length === 0) delete settings.enabledServers
      if (await writeSettingsAtomically(settingsPath, settings, snapshot.fingerprint, snapshot.source, fingerprint, verify)) {
        return { ok: true, output: `${input.enabled ? 'Enabled' : 'Disabled'} MCP server “${input.name}”. Start a new ${agentName} session to apply the change.` }
      }
    }
    throw new Error(`${agentName} settings changed repeatedly; no MCP configuration was overwritten`)
  } finally {
    await release()
  }
}

export async function removeMcpDefinition(
  target: string | ProjectSettingsPath,
  input: Pick<CapabilityMutationInput, 'name' | 'definitionKey'>,
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string } = {},
): Promise<ProcessOutcome> {
  const agentName = options.agentName ?? 'OMP'
  const settingsPath = typeof target === 'string' ? target : target.path
  const definitionKey = input.definitionKey ?? input.name
  if (definitionKey.length > MAX_MCP_DEFINITION_KEY_LENGTH) {
    throw new TypeError('MCP definition key exceeds the supported removal limit')
  }
  const verify = typeof target === 'string' ? undefined : target.verify
  const release = await acquireSettingsLock(settingsPath, verify)
  try {
    for (let attempt = 0; attempt < SETTINGS_UPDATE_ATTEMPTS; attempt += 1) {
      await verify?.()
      const snapshot = await readSettingsForUpdate(settingsPath, agentName)
      await verify?.()
      if (!isRecord(snapshot.settings.mcpServers) || !Object.hasOwn(snapshot.settings.mcpServers, definitionKey)) {
        return { ok: false, reason: 'blocked', output: `MCP server “${input.name}” was not found in this scope.` }
      }
      const nextServers = { ...snapshot.settings.mcpServers }
      delete nextServers[definitionKey]
      snapshot.settings.mcpServers = nextServers
      if (await writeSettingsAtomically(settingsPath, snapshot.settings, snapshot.fingerprint, snapshot.source, fingerprint, verify)) {
        return { ok: true, output: `Removed MCP server “${input.name}”. Other server definitions were kept.` }
      }
    }
    throw new Error(`${agentName} settings changed repeatedly; no MCP configuration was overwritten`)
  } finally {
    await release()
  }
}

export async function updatePackageState(
  target: string | ProjectSettingsPath,
  input: Pick<CapabilityMutationInput, 'source' | 'action'>,
  fingerprint: FingerprintSettings = settingsFingerprint,
  options: { agentName?: string } = {},
): Promise<ProcessOutcome> {
  const source = input.source!
  const agentName = options.agentName ?? 'OMP'
  const settingsPath = typeof target === 'string' ? target : target.path
  const verify = typeof target === 'string' ? undefined : target.verify
  const release = await acquireSettingsLock(settingsPath, verify)
  try {
    for (let attempt = 0; attempt < SETTINGS_UPDATE_ATTEMPTS; attempt += 1) {
      const snapshot = await readSettingsForUpdate(settingsPath, agentName)
      const packages = Array.isArray(snapshot.settings.packages) ? snapshot.settings.packages : []
      const index = packages.findIndex((item) => item === source || (isRecord(item) && item.source === source))
      if (index < 0) return { ok: false, reason: 'blocked', output: `Package “${source}” was not found in this scope.` }
      const saved = isRecord(snapshot.settings.gooeypiDisabledPackages) ? { ...snapshot.settings.gooeypiDisabledPackages } : {}
      const next = [...packages]
      if (input.action === 'disable') {
        if (saved[source] === undefined) saved[source] = next[index]
        next[index] = { source, extensions: [], skills: [], prompts: [], themes: [] }
      } else if (input.action === 'enable') {
        if (saved[source] === undefined) return { ok: true, output: `Package “${source}” is already enabled.` }
        next[index] = saved[source]
        delete saved[source]
      } else {
        next.splice(index, 1)
        delete saved[source]
      }
      snapshot.settings.packages = next
      if (Object.keys(saved).length) snapshot.settings.gooeypiDisabledPackages = saved
      else delete snapshot.settings.gooeypiDisabledPackages
      if (await writeSettingsAtomically(settingsPath, snapshot.settings, snapshot.fingerprint, snapshot.source, fingerprint, verify)) {
        const verb = input.action === 'enable' ? 'Enabled' : input.action === 'disable' ? 'Disabled' : 'Removed'
        return { ok: true, output: `${verb} package “${source}”.` }
      }
    }
    throw new Error(`${agentName} settings changed repeatedly; no package configuration was overwritten`)
  } finally {
    await release()
  }
}
