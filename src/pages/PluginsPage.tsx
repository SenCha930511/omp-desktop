import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  FileCode2,
  FileText,
  GitFork,
  Globe2,
  Package,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { EmptyState, Modal } from '@/components/ui'
import { HARNESS_SHORT_NAMES } from '@/lib/harness'
import { type MessageKey, useI18n } from '@/lib/i18n'
import { NETWORK_MCP_UNAVAILABLE_DETAIL } from '@/lib/mcp-policy'
import type { CapabilityMutationInput, ExtensionInstallInput, HarnessId, McpConnectionInput, McpStateInput, PluginWarning, SkillRecord } from '@/types/api'

const MCP_STDIO_HELP: Record<HarnessId, MessageKey> = {
  omp: 'plugins.mcpStdioHelp',
}

type DirectoryTab = 'plugins' | 'skills'
type AddKind = 'mcp' | 'bundle' | 'extension'
type McpScope = 'user' | 'project'

const PACKAGE_HELP: Record<HarnessId, MessageKey> = {
  omp: 'plugins.packageHelp',
}
const GITHUB_ISSUES_URL = 'https://github.com/am-will/gooey-pi/issues/new'

function capabilityDetailId(skill: SkillRecord): string {
  return `capability-detail-${skill.id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128)}`
}

function SkillIcon({ skill }: { skill: SkillRecord }) {
  const common = { size: 16 }
  if (skill.icon === 'github') return <GitFork {...common} />
  if (skill.icon === 'palette') return <Palette {...common} />
  if (skill.icon === 'book-open') return <BookOpen {...common} />
  if (skill.kind === 'mcp') return <Globe2 {...common} />
  if (skill.kind === 'prompt') return <FileText {...common} />
  if (skill.kind === 'skill') return <WandSparkles {...common} />
  return <Package {...common} />
}

interface PluginsPageProps {
  harness: HarnessId
  skills: SkillRecord[]
  warnings: PluginWarning[]
  loading: boolean
  activeProjectPath?: string
  onRefresh(): Promise<void>
  askUserEnabled: boolean
  onSetAskUserEnabled(enabled: boolean): Promise<void>
  browserEnabled: boolean
  onSetBrowserEnabled(enabled: boolean): Promise<void>
  computerUseEnabled: boolean
  onSetComputerUseEnabled(enabled: boolean): Promise<void>
  onOpenExternal(url: string): void
  onInstall(source: string): Promise<{ ok: boolean; output: string }>
  onInstallExtension(input: ExtensionInstallInput): Promise<{ ok: boolean; output: string }>
  onConnectMcp(input: McpConnectionInput): Promise<{ ok: boolean; output: string }>
  onSetMcpEnabled(input: McpStateInput): Promise<{ ok: boolean; output: string }>
  onMutateCapability?(input: CapabilityMutationInput): Promise<{ ok: boolean; output: string }>
}

export function PluginsPage({
  harness,
  skills,
  warnings,
  loading,
  activeProjectPath,
  askUserEnabled,
  onSetAskUserEnabled,
  browserEnabled,
  onSetBrowserEnabled,
  computerUseEnabled,
  onSetComputerUseEnabled,
  onOpenExternal,
  onRefresh,
  onInstall,
  onInstallExtension,
  onConnectMcp,
  onSetMcpEnabled,
  onMutateCapability,
}: PluginsPageProps) {
  const { t } = useI18n()
  const mutateCapability = onMutateCapability ?? (async () => ({ ok: false, output: t('plugins.capabilityChangesUnavailable') }))
  const [tab, setTab] = useState<DirectoryTab>('plugins')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [addOpen, setAddOpen] = useState(false)
  const [addKind, setAddKind] = useState<AddKind | null>(null)
  const [source, setSource] = useState('')
  const [mcpName, setMcpName] = useState('')
  const [mcpCommand, setMcpCommand] = useState('')
  const [mcpArgs, setMcpArgs] = useState('')
  const [mcpScope, setMcpScope] = useState<McpScope>('user')
  const [result, setResult] = useState('')
  const [adding, setAdding] = useState(false)
  const [askUserUpdating, setAskUserUpdating] = useState(false)
  const [browserUpdating, setBrowserUpdating] = useState(false)
  const [computerUseUpdating, setComputerUseUpdating] = useState(false)
  const [computerUseAlert, setComputerUseAlert] = useState('')
  const [capabilityUpdating, setCapabilityUpdating] = useState('')
  const [confirmDisable, setConfirmDisable] = useState<SkillRecord | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<SkillRecord | null>(null)
  const [capabilityAlert, setCapabilityAlert] = useState('')

  const visible = useMemo(
    () =>
      skills
        .map((skill) =>
          skill.id === 'gooeypi-ask-user'
            ? { ...skill, enabled: askUserEnabled }
            : skill.id === 'omp-desktop-browser' || skill.id === 'omp-work-browser'
              ? { ...skill, enabled: browserEnabled }
              : skill.id === 'gooeypi-computer-use'
                ? { ...skill, enabled: computerUseEnabled }
                : skill,
        )
        .filter((skill) => {
          const capability = skill.id === 'omp-desktop-browser' || skill.id === 'omp-work-browser' || (skill.kind !== 'skill' && skill.kind !== 'prompt')
          return (
            (tab === 'plugins' ? capability : !capability) &&
            (filter === 'all' || (filter === 'installed' && skill.enabled) || filter === skill.location) &&
            `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
          )
        }),
    [askUserEnabled, browserEnabled, computerUseEnabled, skills, tab, filter, query],
  )

  const canAdd =
    addKind === 'bundle'
      ? Boolean(source.trim())
      : addKind === 'extension'
        ? Boolean(source.trim() && (mcpScope !== 'project' || activeProjectPath))
        : addKind === 'mcp' && Boolean(mcpName.trim() && mcpCommand.trim() && (mcpScope !== 'project' || activeProjectPath))

  const add = async () => {
    if (!canAdd) return
    setAdding(true)
    setResult('')
    try {
      const response =
        addKind === 'bundle'
          ? await onInstall(source.trim())
          : addKind === 'extension'
            ? await onInstallExtension({ source: source.trim(), scope: mcpScope, projectPath: mcpScope === 'project' ? activeProjectPath : undefined })
            : await onConnectMcp({
                name: mcpName.trim(),
                scope: mcpScope,
                projectPath: mcpScope === 'project' ? activeProjectPath : undefined,
                type: 'stdio',
                command: mcpCommand.trim(),
                args: mcpArgs
                  .split('\n')
                  .map((arg) => arg.trim())
                  .filter(Boolean),
              })
      setResult(response.output)
      if (response.ok) {
        setSource('')
        setMcpName('')
        setMcpCommand('')
        setMcpArgs('')
        if (addKind === 'mcp' || addKind === 'bundle') await onRefresh()
      }
    } finally {
      setAdding(false)
    }
  }

  const selectAddKind = (value: AddKind | null) => {
    setAddKind(value)
    setSource('')
    setResult('')
  }
  const openAdd = () => {
    setResult('')
    setAddKind(null)
    setAddOpen(true)
  }
  const setAskUser = async (enabled: boolean) => {
    if (askUserUpdating) return
    setAskUserUpdating(true)
    try {
      await onSetAskUserEnabled(enabled)
      await onRefresh()
    } finally {
      setAskUserUpdating(false)
    }
  }
  const setBrowser = async (enabled: boolean) => {
    if (browserUpdating) return
    setBrowserUpdating(true)
    try {
      await onSetBrowserEnabled(enabled)
      await onRefresh()
    } finally {
      setBrowserUpdating(false)
    }
  }
  const setComputerUse = async (skill: SkillRecord, enabled: boolean) => {
    if (computerUseUpdating) return
    if (enabled && skill.availability?.available === false) {
      setComputerUseAlert(skill.availability.detail)
      if (skill.availability.actionUrl) onOpenExternal(skill.availability.actionUrl)
      return
    }
    setComputerUseAlert('')
    setComputerUseUpdating(true)
    try {
      await onSetComputerUseEnabled(enabled)
      await onRefresh()
    } finally {
      setComputerUseUpdating(false)
    }
  }
  const setMcp = async (skill: SkillRecord, enabled: boolean) => {
    if (capabilityUpdating) return
    setCapabilityUpdating(skill.id)
    setCapabilityAlert('')
    try {
      const response = await onSetMcpEnabled({
        name: skill.name,
        scope: skill.location === 'project' ? 'project' : 'user',
        projectPath: skill.location === 'project' ? activeProjectPath : undefined,
        enabled,
      })
      if (!response.ok) setCapabilityAlert(response.output)
    } finally {
      setCapabilityUpdating('')
    }
  }
  const disableCapability = async (skill: SkillRecord) => {
    setConfirmDisable(null)
    if (skill.id === 'gooeypi-ask-user') await setAskUser(false)
    else if (skill.id === 'omp-desktop-browser' || skill.id === 'omp-work-browser') await setBrowser(false)
    else if (skill.id === 'gooeypi-computer-use') await setComputerUse(skill, false)
    else if (skill.kind === 'mcp') await setMcp(skill, false)
    else if (skill.kind === 'package') await mutate(skill, 'disable')
  }
  const mutate = async (skill: SkillRecord, action: CapabilityMutationInput['action']) => {
    setCapabilityUpdating(skill.id)
    setCapabilityAlert('')
    try {
      const response = await mutateCapability({
        kind: skill.kind === 'mcp' ? 'mcp' : 'package',
        action,
        name: skill.name,
        ...(skill.kind === 'mcp' && action === 'remove' && skill.definitionKey !== undefined ? { definitionKey: skill.definitionKey } : {}),
        ...(skill.kind === 'package' ? { source: skill.source } : {}),
        scope: skill.location === 'project' ? 'project' : 'user',
        projectPath: skill.location === 'project' ? activeProjectPath : undefined,
      })
      if (!response.ok) setCapabilityAlert(response.output)
    } finally {
      setCapabilityUpdating('')
    }
  }
  const removeCapability = async (skill: SkillRecord) => {
    setConfirmRemove(null)
    await mutate(skill, 'remove')
  }
  const mcpStatusDetail = (skill: SkillRecord): string | undefined => {
    if (skill.kind !== 'mcp') return undefined
    if (skill.availability?.available === false) return skill.availability.detail
    return undefined
  }
  const capabilityControl = (skill: SkillRecord) => {
    if (skill.kind === 'mcp' && skill.availability?.available === false) {
      const external = skill.availability.detail.includes('managed outside OMP Desktop')
      const label = external ? t('plugins.externallyManaged', { name: skill.name }) : t('plugins.unavailableCapability', { name: skill.name })
      return (
        <span className="plugin-toggle" role="img" aria-label={label} aria-describedby={capabilityDetailId(skill)}>
          <ShieldCheck aria-hidden="true" size={14} />
        </span>
      )
    }
    const isBrowser = skill.id === 'omp-desktop-browser' || skill.id === 'omp-work-browser'
    const actionable = skill.id === 'gooeypi-ask-user' || isBrowser || skill.id === 'gooeypi-computer-use' || skill.kind === 'mcp' || skill.kind === 'package'
    if (!actionable)
      return (
        <span
          className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'}
          aria-label={t(skill.enabled ? 'plugins.enabledCapability' : 'plugins.unavailableCapability', { name: skill.name })}
        >
          {skill.enabled ? <Check size={14} /> : <Plus size={14} />}
        </span>
      )
    const updating = skill.id === 'gooeypi-ask-user' ? askUserUpdating : isBrowser ? browserUpdating : skill.id === 'gooeypi-computer-use' ? computerUseUpdating : capabilityUpdating === skill.id
    const enable = () => {
      if (skill.id === 'gooeypi-ask-user') return setAskUser(true)
      if (isBrowser) return setBrowser(true)
      if (skill.id === 'gooeypi-computer-use') return setComputerUse(skill, true)
      if (skill.kind === 'package') return mutate(skill, 'enable')
      return setMcp(skill, true)
    }
    return (
      <button
        type="button"
        className={skill.enabled ? 'plugin-toggle is-enabled' : 'plugin-toggle'}
        aria-label={t(skill.enabled ? 'plugins.disableCapability' : 'plugins.enableCapability', { name: skill.name })}
        aria-pressed={skill.enabled}
        disabled={updating}
        title={skill.availability?.detail}
        onClick={() => {
          if (skill.enabled) setConfirmDisable(skill)
          else void enable()
        }}
      >
        {updating ? (
          <RefreshCw className="spin" size={14} />
        ) : skill.enabled ? (
          <>
            <Check className="plugin-toggle__check" size={14} />
            <X className="plugin-toggle__disable" size={14} />
          </>
        ) : (
          <Plus className="plugin-toggle__plus" size={14} />
        )}
      </button>
    )
  }

  return (
    <div className="page plugin-page scroll-area">
      <div className="page-container plugin-container">
        <header className="plugin-header">
          <div>
            <span className="eyebrow">{t('plugins.headerEyebrow', { harness: HARNESS_SHORT_NAMES[harness] })}</span>
            <h1>{t('plugins.extendHarness', { harness: HARNESS_SHORT_NAMES[harness] })}</h1>
            <p>{t('plugins.subtitle')}</p>
          </div>
          <div>
            <button type="button" className="button" onClick={() => void onRefresh()}>
              <RefreshCw className={loading ? 'spin' : ''} size={13} /> {t('plugins.refresh')}
            </button>
            <button type="button" className="button" onClick={() => setFilter('installed')}>
              <Settings2 size={13} /> {t('plugins.manage')}
            </button>
            <button type="button" className="button button--primary" onClick={openAdd}>
              <Plus size={14} /> {t('plugins.add')}
            </button>
          </div>
        </header>
        <div className="directory-tabs">
          <button type="button" className={tab === 'plugins' ? 'is-active' : ''} onClick={() => setTab('plugins')}>
            {t('plugins.tabCapabilities')}
          </button>
          <button type="button" className={tab === 'skills' ? 'is-active' : ''} onClick={() => setTab('skills')}>
            {t('plugins.tabSkills')}
          </button>
        </div>
        <div className="directory-tools">
          <label className="page-search">
            <Search size={14} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(tab === 'plugins' ? 'plugins.searchCapabilities' : 'plugins.searchSkills')} />
          </label>
          <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label={t('plugins.filterLabel')}>
            <option value="all">{t('plugins.filterAllSources')}</option>
            <option value="installed">{t('plugins.filterInstalled')}</option>
            <option value="bundled">{t('plugins.filterBundled')}</option>
            <option value="user">{t('plugins.filterPersonal')}</option>
            <option value="project">{t('plugins.filterProject')}</option>
            <option value="system">{t('plugins.filterSystem')}</option>
          </select>
        </div>
        {warnings.map((warning) => (
          <p key={`${warning.scope}:${warning.path}`} className="page-inline-error" role="alert">
            <AlertTriangle size={13} />{' '}
            {t('plugins.warning', { scope: t(warning.scope === 'project' ? 'plugins.filterProject' : 'plugins.filterPersonal'), message: warning.message, path: warning.path })}
          </p>
        ))}
        {capabilityAlert ? (
          <p className="page-inline-error" role="alert">
            <AlertTriangle size={13} /> {capabilityAlert}
          </p>
        ) : null}
        {computerUseAlert ? (
          <p className="page-inline-error" role="alert">
            <AlertTriangle size={13} /> {computerUseAlert}
          </p>
        ) : null}
        <p className="connection-warning">
          <ShieldCheck size={13} /> {NETWORK_MCP_UNAVAILABLE_DETAIL}
        </p>
        <div className="directory-heading">
          <h2>{filter === 'installed' ? t('plugins.filterInstalled') : tab === 'plugins' ? t('plugins.tabCapabilities') : t('plugins.tabSkills')}</h2>
          <span>{t('plugins.shownCount', { count: visible.length })}</span>
        </div>
        {visible.length ? (
          <div className="directory-list">
            {visible.map((skill) => {
              const statusDetail = mcpStatusDetail(skill)
              return (
                <article key={skill.id}>
                  <span className={`directory-icon directory-icon--${skill.kind}`}>
                    <SkillIcon skill={skill} />
                  </span>
                  <div>
                    <div>
                      <h3>{skill.name}</h3>
                      <span>{skill.location}</span>
                    </div>
                    <p id={statusDetail ? capabilityDetailId(skill) : undefined}>
                      {skill.description}
                      {statusDetail ? ` ${statusDetail}` : ''}
                    </p>
                  </div>
                  <div className="capability-actions">
                    {skill.kind === 'package' || (skill.kind === 'mcp' && skill.location !== 'bundled' && skill.location !== 'system' && skill.definitionRemovalAvailable !== false) ? (
                      <button
                        type="button"
                        className="plugin-remove"
                        aria-label={t('plugins.removeCapability', { name: skill.name })}
                        disabled={capabilityUpdating === skill.id}
                        onClick={() => setConfirmRemove(skill)}
                      >
                        <Trash2 size={13} />
                      </button>
                    ) : null}
                    {capabilityControl(skill)}
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <EmptyState icon={<Sparkles size={23} />} title={t('plugins.emptyTitle')}>
            {t('plugins.emptyBody', { harness: HARNESS_SHORT_NAMES[harness] })}
          </EmptyState>
        )}

        {confirmDisable ? (
          <Modal
            title={t('plugins.disableConfirmTitle', { name: confirmDisable.name })}
            onClose={() => setConfirmDisable(null)}
            footer={
              <>
                <button type="button" className="button" onClick={() => setConfirmDisable(null)}>
                  {t('plugins.cancel')}
                </button>
                <button type="button" className="button button--danger" onClick={() => void disableCapability(confirmDisable)}>
                  {t('plugins.yesDisable')}
                </button>
              </>
            }
          >
            <p className="modal-intro">{t('plugins.disableConfirmBody')}</p>
          </Modal>
        ) : null}
        {confirmRemove ? (
          <Modal
            title={t('plugins.removeConfirmTitle', { name: confirmRemove.name })}
            onClose={() => setConfirmRemove(null)}
            footer={
              <>
                <button type="button" className="button" onClick={() => setConfirmRemove(null)}>
                  {t('plugins.cancel')}
                </button>
                <button type="button" className="button button--danger" onClick={() => void removeCapability(confirmRemove)}>
                  {t('plugins.yesRemove')}
                </button>
              </>
            }
          >
            <p className="modal-intro">{t('plugins.removeConfirmBody', { detail: t(confirmRemove.kind === 'mcp' ? 'plugins.removeDetailMcp' : 'plugins.removeDetailPackage') })}</p>
          </Modal>
        ) : null}

        {addOpen ? (
          <Modal
            title={
              addKind
                ? t(addKind === 'mcp' ? 'plugins.addMcpServerTitle' : addKind === 'extension' ? 'plugins.addExtensionWordTitle' : 'plugins.addPluginWordTitle')
                : t('plugins.addCapabilityTitle', { harness: HARNESS_SHORT_NAMES[harness] })
            }
            onClose={() => setAddOpen(false)}
            footer={
              addKind ? (
                <>
                  <button type="button" className="button" onClick={() => selectAddKind(null)}>
                    <ArrowLeft size={13} /> {t('plugins.back')}
                  </button>
                  <button type="button" className="button button--primary" disabled={!canAdd || adding} onClick={() => void add()}>
                    {adding
                      ? addKind === 'mcp'
                        ? t('plugins.saving')
                        : t('plugins.installing')
                      : addKind === 'mcp'
                        ? t('plugins.saveServer')
                        : addKind === 'extension'
                          ? t('plugins.installExtension')
                          : t('plugins.installPlugin')}
                  </button>
                </>
              ) : (
                <button type="button" className="button" onClick={() => setAddOpen(false)}>
                  {t('plugins.cancel')}
                </button>
              )
            }
          >
            {addKind === null ? (
              <div className="capability-choice-list">
                <button type="button" onClick={() => selectAddKind('mcp')}>
                  <span>
                    <Globe2 size={17} />
                  </span>
                  <span>
                    <strong>{t('plugins.addMcp')}</strong>
                    <small>{t('plugins.addMcpDetail')}</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
                <button type="button" onClick={() => selectAddKind('bundle')}>
                  <span>
                    <Package size={17} />
                  </span>
                  <span>
                    <strong>{t('plugins.addPluginLabel')}</strong>
                    <small>{t(PACKAGE_HELP[harness])}</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
                <button type="button" onClick={() => selectAddKind('extension')}>
                  <span>
                    <FileCode2 size={17} />
                  </span>
                  <span>
                    <strong>{t('plugins.addExtensionLabel')}</strong>
                    <small>{t('plugins.addExtensionDetail', { harness: HARNESS_SHORT_NAMES[harness] })}</small>
                  </span>
                  <ChevronRight size={15} />
                </button>
                <p className="capability-compatibility-note">
                  <AlertTriangle size={13} />
                  <span>
                    {t('plugins.compatibilityNote')}{' '}
                    <button type="button" onClick={() => onOpenExternal(GITHUB_ISSUES_URL)}>
                      {t('plugins.createIssue')}
                    </button>
                    .
                  </span>
                </p>
              </div>
            ) : addKind === 'bundle' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{t('plugins.bundleIntro', { help: t(PACKAGE_HELP[harness]) })}</p>
                <label className="field">
                  <span>{t('plugins.sourceLabel')}</span>
                  <input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="plugin-name@marketplace" />
                </label>
                <small className="field-help">
                  {t('plugins.sourceHelpBefore')} <code>name@marketplace</code>
                  {t('plugins.sourceHelpAfter')}
                </small>
              </div>
            ) : addKind === 'extension' ? (
              <div className="add-tool-form">
                <p className="modal-intro">{t('plugins.extensionIntro')}</p>
                <label className="field">
                  <span>{t('plugins.extensionFileLabel')}</span>
                  <input autoFocus value={source} onChange={(event) => setSource(event.target.value)} placeholder="/absolute/path/to/my-extension.ts" />
                </label>
                <small className="field-help">
                  {t('plugins.extensionHelpBefore')} <code>.ts</code>, <code>.js</code>, <code>.mjs</code>, or <code>.cjs</code> {t('plugins.extensionHelpAfter')}
                </small>
                <label className="field">
                  <span>{t('plugins.availableIn')}</span>
                  <select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}>
                    <option value="user">{t('plugins.allProjectsPersonal')}</option>
                    <option value="project" disabled={!activeProjectPath}>
                      {t('plugins.currentProject')}
                    </option>
                  </select>
                </label>
                <p className="connection-warning">
                  <ShieldCheck size={13} /> {t('plugins.extensionWarning')}
                </p>
              </div>
            ) : (
              <div className="add-tool-form">
                <p className="modal-intro">{t('plugins.mcpIntro')}</p>
                <label className="field">
                  <span>{t('plugins.serverName')}</span>
                  <input autoFocus value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="my-local-tools" />
                </label>
                <p className="field-help">{t(MCP_STDIO_HELP[harness])}</p>
                <label className="field">
                  <span>{t('plugins.executable')}</span>
                  <input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="npx" />
                </label>
                <label className="field">
                  <span>
                    {t('plugins.arguments')} <small>{t('plugins.onePerLine')}</small>
                  </span>
                  <textarea value={mcpArgs} onChange={(event) => setMcpArgs(event.target.value)} rows={3} placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/project'} />
                </label>
                <label className="field">
                  <span>{t('plugins.availableIn')}</span>
                  <select value={mcpScope} onChange={(event) => setMcpScope(event.target.value as McpScope)}>
                    <option value="user">{t('plugins.allProjectsPersonal')}</option>
                    <option value="project" disabled={!activeProjectPath}>
                      {t('plugins.currentProject')}
                    </option>
                  </select>
                </label>
                <p className="connection-warning">
                  <ShieldCheck size={13} /> {t('plugins.mcpWarning')}
                </p>
              </div>
            )}
            {result ? (
              <pre className="install-output" role="status">
                {result}
              </pre>
            ) : null}
          </Modal>
        ) : null}
      </div>
    </div>
  )
}
