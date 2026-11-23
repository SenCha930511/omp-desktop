import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessId, PluginCatalog, ProcessOutcome, SkillRecord } from '../../src/types/api'
import { HARNESSES } from './harness'
import { createAdmissionQueue, createSingleFlight } from './lib/async'
import { resolveExecutable, type ExecutableSource } from './process-utils'
import { requireString } from './validation'
import { discoverPlugins } from './plugins/catalog'
import { acquireSettingsLock, prepareProjectSettingsPath, removeMcpDefinition, settingsFingerprint, updateMcpSettings, updateMcpState, validateCapabilityMutation, validateMcpConnection, validateMcpStateInput } from './plugins/mcp'
import type { ProjectSettingsPath } from './plugins/mcp'
import { executeOmpPluginAction, executeOmpPluginInstall, validatePackageSource } from './plugins/package-execution'
import { installOmpExtension, validateExtensionInstallInput } from './plugins/extension-installation'

type PluginDiscovery = typeof discoverPlugins

interface PluginServiceOptions {
  harness?: HarnessId
  agentDir?: string
  discover?: PluginDiscovery
  builtInSkills?: SkillRecord[] | (() => SkillRecord[] | Promise<SkillRecord[]>)
}

const MAX_CONCURRENT_PLUGIN_DISCOVERIES = 2
const MAX_QUEUED_PLUGIN_DISCOVERIES = 32
const MAX_KNOWN_PATH_OWNERS = 64
const MAX_KNOWN_PATHS_PER_OWNER = 4_096
// Discovery walks the user and project capability trees; the panels and the
// IPC surface ask for the same catalog repeatedly, so a very short TTL keeps
// those reads off the filesystem while a settings mutation or refresh clears it
// immediately.
const PLUGIN_CATALOG_TTL_MS = 2_000
const MAX_CACHED_PLUGIN_CATALOGS = 16

function normalizedCapabilityIdentity(value: string): string {
  return value.toLowerCase().replace(/^@[^/]+\//, '').replace(/[^a-z0-9]+/g, '')
}

function dedupeAssociatedMcpPackages(skills: SkillRecord[]): SkillRecord[] {
  const mcpByScope = new Map(skills
    .filter((skill) => skill.kind === 'mcp' && skill.location !== 'bundled' && skill.location !== 'system')
    .map((skill) => [`${skill.location}:${normalizedCapabilityIdentity(skill.name)}`, skill] as const))
  const hiddenPackages = new Set<string>()
  const packageByMcpId = new Map<string, SkillRecord>()
  for (const skill of skills) {
    if (skill.kind !== 'package') continue
    const identities = skill.associatedMcpServers?.map(normalizedCapabilityIdentity)
      ?? [normalizedCapabilityIdentity(skill.name)]
    for (const identity of identities) {
      const mcp = mcpByScope.get(`${skill.location}:${identity}`)
      if (!mcp) continue
      hiddenPackages.add(skill.id)
      packageByMcpId.set(mcp.id, skill)
      break
    }
  }
  return skills.filter((skill) => !hiddenPackages.has(skill.id)).map((skill) => {
    const associatedPackage = packageByMcpId.get(skill.id)
    return associatedPackage?.source ? { ...skill, associatedPackageSource: associatedPackage.source } : skill
  })
}

const createDiscoveryQueue = () => createAdmissionQueue({
  maxConcurrent: MAX_CONCURRENT_PLUGIN_DISCOVERIES,
  maxPending: MAX_QUEUED_PLUGIN_DISCOVERIES,
  pendingLimitError: () => new TypeError('Too many plugin discoveries are pending'),
  closedError: () => new TypeError('OMP Desktop is shutting down'),
})
let discoveryQueue = createDiscoveryQueue()

export function beginPluginDiscoveryShutdown(): void {
  // Reject queued waiters; running discoveries finish normally. A fresh queue
  // keeps later callers working (only the quit path calls this in the app).
  discoveryQueue.close()
  discoveryQueue = createDiscoveryQueue()
}

export class PluginService {
  private lastProjectPath: string | undefined
  private readonly knownPathsByOwner = new Map<string, Set<string>>()
  private settingsMutation = Promise.resolve()
  private readonly discoveryInFlight = createSingleFlight<string, PluginCatalog>()
  private readonly catalogCache = new Map<string, { catalog: PluginCatalog; expiresAt: number }>()
  private readonly agentDir: string
  private readonly discoverCatalog: PluginDiscovery
  private readonly builtInSkills: () => SkillRecord[] | Promise<SkillRecord[]>
  private readonly harness: HarnessId

  constructor(
    private readonly agentPath: ExecutableSource,
    private readonly authorizeProject: (path: string) => Promise<string>,
    options: PluginServiceOptions = {},
  ) {
    this.harness = options.harness ?? 'omp'
    this.agentDir = options.agentDir ?? HARNESSES[this.harness].agentDir(homedir())
    this.discoverCatalog = options.discover ?? discoverPlugins
    const builtInSkills = options.builtInSkills
    this.builtInSkills = typeof builtInSkills === 'function'
      ? builtInSkills
      : () => builtInSkills ?? []
  }

  private queueSettingsMutation(mutate: () => Promise<ProcessOutcome>): Promise<ProcessOutcome> {
    const operation = this.settingsMutation.then(mutate)
    this.settingsMutation = operation.then(() => undefined, () => undefined)
    return operation
  }

  list(projectPath?: unknown): Promise<PluginCatalog> {
    if (!projectPath) return this.listCanonical()
    const requested = requireString(projectPath, 'projectPath', { min: 1, max: 4096 })
    return this.authorizeProject(requested).then((safeProjectPath) => this.listCanonical(safeProjectPath))
  }

  private listCanonical(safeProjectPath?: string): Promise<PluginCatalog> {
    const key = safeProjectPath ? `project:${safeProjectPath}` : 'user'
    const cached = this.cachedCatalog(key)
    // Every caller owns its rows: a panel that edits a record must never
    // rewrite the entry the next list call serves.
    if (cached) return Promise.resolve(structuredClone(cached))
    return this.discoveryInFlight.run(key, () => discoveryQueue.run(() => this.discover(safeProjectPath, key)))
  }

  private cachedCatalog(key: string): PluginCatalog | undefined {
    const entry = this.catalogCache.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.catalogCache.delete(key)
      return undefined
    }
    // Delete-then-set keeps insertion order as LRU order for bounded eviction.
    this.catalogCache.delete(key)
    this.catalogCache.set(key, entry)
    return entry.catalog
  }

  private rememberCatalog(key: string, catalog: PluginCatalog): void {
    this.catalogCache.delete(key)
    this.catalogCache.set(key, { catalog, expiresAt: Date.now() + PLUGIN_CATALOG_TTL_MS })
    while (this.catalogCache.size > MAX_CACHED_PLUGIN_CATALOGS) {
      const oldest = this.catalogCache.keys().next().value
      if (oldest === undefined) break
      this.catalogCache.delete(oldest)
    }
  }

  private async discover(safeProjectPath: string | undefined, ownerKey: string): Promise<PluginCatalog> {
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const result = await this.discoverCatalog(this.agentDir, safeProjectPath, resolveExecutable(this.agentPath), this.harness)
    const builtInSkills = await this.builtInSkills()
    const fixed = [...builtInSkills]
    const combined = dedupeAssociatedMcpPackages([...fixed, ...result.skills.filter((item) => !fixed.some((builtIn) => builtIn.id === item.id))])
    const knownPaths = combined.flatMap((item) => item.path ? [item.path] : []).slice(0, MAX_KNOWN_PATHS_PER_OWNER)
    // Delete-then-set keeps insertion order as LRU order for owner eviction.
    this.knownPathsByOwner.delete(ownerKey)
    this.knownPathsByOwner.set(ownerKey, new Set(knownPaths))
    while (this.knownPathsByOwner.size > MAX_KNOWN_PATH_OWNERS) {
      const oldest = this.knownPathsByOwner.keys().next().value
      if (oldest === undefined) break
      this.knownPathsByOwner.delete(oldest)
    }
    const catalog: PluginCatalog = { skills: combined, warnings: result.warnings }
    this.rememberCatalog(ownerKey, catalog)
    return structuredClone(catalog)
  }

  authorizeReveal(pathValue: unknown): string {
    const requested = requireString(pathValue, 'plugin path', { min: 1, max: 4096 })
    let path: string
    try { path = realpathSync.native(requested) } catch { throw new TypeError('plugin path does not exist') }
    if (![...this.knownPathsByOwner.values()].some((knownPaths) => knownPaths.has(path))) {
      throw new TypeError('plugin path was not discovered')
    }
    return path
  }

  async install(sourceValue: unknown): Promise<ProcessOutcome> {
    const agentPath = resolveExecutable(this.agentPath)
    if (!agentPath) return { ok: false, reason: 'blocked', output: `${HARNESSES[this.harness].agentName} executable was not found` }
    const source = validatePackageSource(sourceValue, { allowOmpMarketplaceTarget: true })
    // OMP tracks installs through its plugin lock file.
    const lockPath = join(this.agentDir, '..', 'plugins', 'omp-plugins.lock.json')
    const outcome = await this.queueSettingsMutation(async (): Promise<ProcessOutcome> => {
      const release = await acquireSettingsLock(lockPath)
      try {
        return await executeOmpPluginInstall(agentPath, source)
      } finally {
        await release()
      }
    })
    this.catalogCache.clear()
    return outcome
  }

  async installExtension(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateExtensionInstallInput(inputValue)
    const safeProjectPath = input.scope === 'project'
      ? await this.authorizeProject(input.projectPath!)
      : undefined
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const outcome = await installOmpExtension(input, this.agentDir, safeProjectPath)
    this.catalogCache.clear()
    return outcome
  }

  async connectMcp(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateMcpConnection(inputValue, this.harness)
    let settingsTarget: string | ProjectSettingsPath
    if (input.scope === 'project') {
      const projectPath = await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      this.lastProjectPath = projectPath
      settingsTarget = await prepareProjectSettingsPath(projectPath, {
        segments: ['.omp'], filename: 'mcp.json',
      })
    } else {
      settingsTarget = join(this.agentDir, 'mcp.json')
    }

    const settingsPath = typeof settingsTarget === 'string' ? settingsTarget : settingsTarget.path
    const verify = typeof settingsTarget === 'string' ? undefined : settingsTarget.verify
    const outcome = await this.queueSettingsMutation(async () => {
      const releaseSettings = await acquireSettingsLock(`${settingsPath}.gooeypi`, verify)
      try {
        return await updateMcpSettings(
          settingsTarget,
          input,
          (path) => this.settingsFingerprint(path),
          {
            agentName: 'OMP',
            harness: this.harness,
            schema: 'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json',
          },
        )
      } finally {
        await releaseSettings()
      }
    })
    this.catalogCache.clear()
    return outcome
  }

  async setMcpEnabled(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateMcpStateInput(inputValue, this.harness)
    let settingsTarget: string | ProjectSettingsPath
    if (input.scope === 'project') {
      const projectPath = await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      this.lastProjectPath = projectPath
      settingsTarget = await prepareProjectSettingsPath(projectPath, {
        segments: ['.omp'], filename: 'mcp.json',
      })
    } else {
      settingsTarget = join(this.agentDir, 'mcp.json')
    }
    const agentName = HARNESSES[this.harness].agentName
    const settingsPath = typeof settingsTarget === 'string' ? settingsTarget : settingsTarget.path
    const verify = typeof settingsTarget === 'string' ? undefined : settingsTarget.verify
    const outcome = await this.queueSettingsMutation(async () => {
      const releaseSettings = await acquireSettingsLock(`${settingsPath}.gooeypi`, verify)
      try {
        return await updateMcpState(
          settingsTarget,
          input,
          (path) => this.settingsFingerprint(path),
          { agentName, harness: this.harness },
        )
      } finally {
        await releaseSettings()
      }
    })
    this.catalogCache.clear()
    return outcome
  }

  async mutateCapability(inputValue: unknown): Promise<ProcessOutcome> {
    const input = validateCapabilityMutation(inputValue, this.harness)
    const safeProjectPath = input.scope === 'project'
      ? await this.authorizeProject(requireString(input.projectPath, 'projectPath', { min: 1, max: 4096 }))
      : undefined
    if (safeProjectPath) this.lastProjectPath = safeProjectPath
    const projectSettings = safeProjectPath
      ? await prepareProjectSettingsPath(safeProjectPath, {
          segments: ['.omp'], filename: input.kind === 'mcp' ? 'mcp.json' : 'settings.json',
        })
      : undefined
    const settingsPath = projectSettings?.path ?? join(this.agentDir, input.kind === 'mcp' ? 'mcp.json' : 'settings.json')
    const agentName = HARNESSES[this.harness].agentName
    const outcome = await this.queueSettingsMutation(async (): Promise<ProcessOutcome> => {
      const releaseSettings = await acquireSettingsLock(`${settingsPath}.gooeypi`, projectSettings?.verify)
      try {
        if (input.kind === 'mcp') {
          if (input.action !== 'remove') {
            return await updateMcpState(projectSettings ?? settingsPath, { ...input, enabled: input.action === 'enable' }, (path) => this.settingsFingerprint(path), { agentName, harness: this.harness })
          }
          return await removeMcpDefinition(projectSettings ?? settingsPath, input, (path) => this.settingsFingerprint(path), { agentName })
        }

        const agentPath = resolveExecutable(this.agentPath)
        if (!agentPath) return { ok: false, reason: 'blocked', output: `${agentName} executable was not found` }
        return await executeOmpPluginAction(agentPath, input.action === 'remove' ? 'uninstall' : input.action, input.source!, input.scope === 'project')
      } finally {
        await releaseSettings()
      }
    })
    // A partially applied mutation still invalidates: the next list rescans.
    this.catalogCache.clear()
    return outcome
  }

  refresh(): Promise<PluginCatalog> {
    this.catalogCache.clear()
    const projectPath = this.lastProjectPath
    if (!projectPath) return this.listCanonical()
    // Re-authorize on every refresh: the remembered project may have been
    // removed (or replaced) since the scope was last used.
    return this.authorizeProject(projectPath).then(
      (safeProjectPath) => this.listCanonical(safeProjectPath),
      (error) => {
        // Surface the failure once, then forget the stale scope so later
        // refreshes fall back to the user catalog.
        if (this.lastProjectPath === projectPath) this.lastProjectPath = undefined
        this.knownPathsByOwner.delete(`project:${projectPath}`)
        throw error
      },
    )
  }

  /** Revokes a removed project's revealable paths and cached catalog. */
  evictProjects(roots: readonly string[]): void {
    for (const root of roots) {
      this.knownPathsByOwner.delete(`project:${root}`)
      this.catalogCache.delete(`project:${root}`)
    }
  }

  private settingsFingerprint(path: string): Promise<string> {
    return settingsFingerprint(path)
  }
}
