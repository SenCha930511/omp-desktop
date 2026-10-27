import { describe, expect, it } from 'vitest'
import { alwaysLocalSlashCommand, busySlashDisposition, canonicalSlashName, deferredSlashCommand, INITIAL_SLASH_COMMANDS, parseSlashCommands, parseSlashInvocation, slashCommandAcceptsImages, slashSuggestions } from '../../src/lib/slash-commands'
import { desktopSlashCommands, localSlashResponse } from '../../src/lib/slash-command-ui'
import { translate } from '../../src/lib/i18n'
import type { RuntimeInfo } from '../../src/types/api'

describe('slash command catalog', () => {
  it('omits builtins with desktop controls from both startup and live catalogs, including aliases and subcommands', () => {
    const hidden = ['model', 'switch', 'effort', 'fast', 'retry', 'rename', 'session', 'mcp', 'plugins', 'settings', 'agents']
    const t = (key: Parameters<typeof translate>[1]) => translate('en', key)
    expect(desktopSlashCommands(INITIAL_SLASH_COMMANDS, t).some((command) => hidden.includes(command.name))).toBe(false)
    for (const source of ['builtin', undefined]) {
      const commands = desktopSlashCommands([
        ...hidden.map((name) => ({ name, source, aliases: [`${name}-alias`], subcommands: [{ name: 'status' }] })),
        { name: 'modelpreset', source }, { name: 'compact', source },
      ], t)
      expect(commands.map((command) => command.name)).toEqual(['modelpreset', 'compact'])
      expect(slashSuggestions(commands, '/effort h')).toEqual([])
      expect(slashSuggestions(commands, '/model-alias')).toEqual([])
    }
  })
  it('preserves explicit extension overrides and unknown commands without source metadata', () => {
    const commands = [{ name: 'model', source: 'extension', description: 'Custom model command' }, { name: 'my-workflow', description: 'Local workflow' }]
    expect(desktopSlashCommands(commands, (key) => translate('en', key))).toEqual(commands)
  })
  it('keeps conversation commands localized and preserves custom commands', () => {
    // live catalog 是權威來源:builtin 的 marketplace 不再被白名單擋下,
    // 與 extension 的同名片存;login 已由 provider 帳號面板接出(gui-action),
    // 不再是 TUI-only,選單同樣以 GUI 入口呈現。
    const commands = desktopSlashCommands([
      { name: 'context', source: 'builtin', description: 'Show context usage' },
      { name: 'marketplace', source: 'builtin' },
      { name: 'login', source: 'builtin' },
      { name: 'marketplace', source: 'extension', description: 'Custom extension' },
    ], (key, values) => translate('zh-TW', key, values))
    expect(commands.map((command) => command.name)).toEqual(['context', 'marketplace', 'login', 'marketplace'])
    expect(commands[0].description).toBe('查看上下文用量')
    expect(commands[1].description).toBe('管理市集擴充')
    expect(commands[3].description).toBe('Custom extension')
  })
  it('shows newly added upstream builtins with their own description, aliases and subcommands', () => {
    // 上游新增的 builtin 不在任何寫死清單內,仍須出現在選單,描述採用上游原文。
    const upstream = { name: 'skill-new', source: 'builtin', description: 'Fresh upstream feature', aliases: ['sn'], subcommands: [{ name: 'go' }] } satisfies Parameters<typeof desktopSlashCommands>[0][number]
    const tuiOnly = { name: 'theme', source: 'builtin' }
    const commands = desktopSlashCommands([upstream, tuiOnly], (key) => translate('en', key))
    expect(commands).toEqual([upstream])
    expect(slashSuggestions(commands, '/sk')[0]).toEqual({ command: '/skill-new', detail: 'Fresh upstream feature' })
  })
  const commands = [{ name: 'model', aliases: ['models'], description: 'Model' }, { name: 'effort', subcommands: [{ name: 'high', description: 'Deep' }, { name: 'low' }] }]
  it('completes runtime names, aliases and arguments', () => {
    expect(slashSuggestions(commands, '/mo').map((item) => item.command)).toEqual(['/model'])
    expect(slashSuggestions(commands, '/models')[0].command).toBe('/models')
    expect(slashSuggestions(commands, '/effort h')).toEqual([{ command: '/effort high', detail: 'Deep' }])
    expect(slashSuggestions(commands, '/effort high extra')).toEqual([])
  })
  it('separates terminal displays from executable commands', () => {
    expect(deferredSlashCommand('/theme')).toBe('theme')
    expect(deferredSlashCommand('/todo edit')).toBe('todo edit')
    expect(deferredSlashCommand('/todo:EDIT')).toBe('todo EDIT')
    expect(parseSlashInvocation('/modelpreset:foo:bar')).toEqual({ name: 'modelpreset', args: 'foo:bar' })
    expect(parseSlashInvocation('/todo :edit')).toEqual({ name: 'todo', args: ':edit' })
    expect(deferredSlashCommand('/todo expand')).toBe('todo expand')
    expect(deferredSlashCommand('/advisor:configure')).toBe('advisor configure')
    expect(deferredSlashCommand('/todo done tests')).toBeUndefined()
    expect(deferredSlashCommand('/effort high')).toBeUndefined()
    expect(parseSlashCommands([null, { name: 3 }, { name: 'context' }])).toEqual([{ name: 'context' }])
  })
  it('hides TUI-only subcommands without changing extension commands', () => {
    const subcommands = [{ name: 'edit' }, { name: 'expand' }, { name: 'done' }]
    const commands = desktopSlashCommands([{ name: 'todo', source: 'builtin', subcommands }, { name: 'todo', source: 'extension', subcommands }], (key) => translate('en', key))
    expect(commands[0].subcommands?.map((sub) => sub.name)).toEqual(['done'])
    expect(commands[1].subcommands).toEqual(subcommands)
    expect(slashSuggestions([{ name: 'effort', subcommands: [{ name: 'high' }] }], '/effort:h')[0].command).toBe('/effort high')
  })
})

describe('busy slash dispatch', () => {
  it('answers read-only queries locally instead of queueing', () => {
    for (const prompt of ['/status', '/context', '/usage', '/model', '/session', '/fast status']) {
      expect(busySlashDisposition(prompt)).toEqual({ kind: 'respond-local' })
    }
  })
  it('keeps mutations and queries without a local data source queued', () => {
    // /model 帶參數是切換模型;/tools、/jobs、/todo、/memory 的資料不在
    // runtime 快照內,上游 busy 語意未查證,保守排隊。
    for (const prompt of ['/model auto', '/compact', '/tools', '/jobs', '/todo', '/todo done 3', '/memory', '/fast on', '/retry', '/fresh']) {
      expect(busySlashDisposition(prompt)).toEqual({ kind: 'queue-until-idle' })
    }
  })
  it('routes goal lifecycle commands through their busy-safe RPC', () => {
    // 上游 rpc-goal.handle 不依 streaming 擋任意 op,TUI 語彙 set/show 與
    // RPC 語彙 create/get 都對映到同一批操作。
    expect(busySlashDisposition('/pause')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'pause' } })
    expect(busySlashDisposition('/goal')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'get' } })
    expect(busySlashDisposition('/goal get')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'get' } })
    expect(busySlashDisposition('/goal show')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'get' } })
    expect(busySlashDisposition('/goal set fix the flaky tests')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'create', objective: 'fix the flaky tests' } })
    expect(busySlashDisposition('/goal create ship it')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'create', objective: 'ship it' } })
    expect(busySlashDisposition('/goal write the port notes')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'create', objective: 'write the port notes' } })
    expect(busySlashDisposition('/goal resume')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'resume' } })
    expect(busySlashDisposition('/goal pause')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'pause' } })
    expect(busySlashDisposition('/goal drop')).toEqual({ kind: 'agent-control', command: { type: 'goal', op: 'drop' } })
  })
  it('rejects goal usage errors in place instead of queueing them', () => {
    expect(busySlashDisposition('/goal set')).toEqual({ kind: 'goal-usage-error', messageKey: 'goal.error.createNeedsObjective' })
    expect(busySlashDisposition('/goal create')).toEqual({ kind: 'goal-usage-error', messageKey: 'goal.error.createNeedsObjective' })
    expect(busySlashDisposition('/goal budget 50000')).toEqual({ kind: 'goal-usage-error', messageKey: 'goal.error.budgetUnsupported' })
    expect(busySlashDisposition('/goal show now')).toEqual({ kind: 'goal-usage-error', messageKey: 'goal.error.usage' })
  })
  it('/status and goal commands are no longer deferred TUI commands', () => {
    expect(deferredSlashCommand('/status')).toBeUndefined()
    expect(deferredSlashCommand('/pause')).toBeUndefined()
    expect(deferredSlashCommand('/goal')).toBeUndefined()
    expect(deferredSlashCommand('/goal show')).toBeUndefined()
  })
  it('/login /logout open the provider accounts panel via gui-action, busy-safe and out of DEFERRED', () => {
    // 上游認證/查詢 RPC 皆非 session-mutation(busy-safe);一律即時分派,
    // 參數絕不送進模型(providerId 由面板操作攜帶)。
    expect(busySlashDisposition('/login')).toEqual({ kind: 'gui-action', action: 'provider-accounts' })
    expect(busySlashDisposition('/logout')).toEqual({ kind: 'gui-action', action: 'provider-accounts' })
    expect(busySlashDisposition('/login anthropic')).toEqual({ kind: 'gui-action', action: 'provider-accounts' })
    expect(busySlashDisposition('/LOGOUT')).toEqual({ kind: 'gui-action', action: 'provider-accounts' })
    expect(deferredSlashCommand('/login')).toBeUndefined()
    expect(deferredSlashCommand('/logout')).toBeUndefined()
    // /providers 仍是 TUI-only(DEFERRED),不能借 login 別名放行。
    expect(deferredSlashCommand('/providers')).toBe('providers')
  })
  it('routes session GUI entries to gui actions instead of the model', () => {
    for (const prompt of ['/tree', '/branch', '/rewind']) {
      expect(busySlashDisposition(prompt)).toEqual({ kind: 'gui-action', action: 'session-tree' })
    }
    expect(busySlashDisposition('/fork')).toEqual({ kind: 'gui-action', action: 'fork' })
    expect(busySlashDisposition('/new')).toEqual({ kind: 'gui-action', action: 'new-session' })
    // /clear 對應 durable 新工作階段(上游原地清除 context 無 RPC,差異記
    // 錄於 slash-commands.ts DEFERRED 註記)。
    expect(busySlashDisposition('/clear')).toEqual({ kind: 'gui-action', action: 'new-session' })
    // /resume 語意是切換;bare 由分派端開啟 sidebar,target 原樣保留給
    // catalog 比對。
    expect(busySlashDisposition('/resume')).toEqual({ kind: 'gui-action', action: 'resume-session', target: undefined })
    expect(busySlashDisposition('/resume abc123')).toEqual({ kind: 'gui-action', action: 'resume-session', target: 'abc123' })
    expect(busySlashDisposition('/resume @claude')).toEqual({ kind: 'gui-action', action: 'resume-session', target: '@claude' })
    // 已接出 DEFERRED,不再原地拒絕。
    for (const prompt of ['/tree', '/branch', '/rewind', '/fork', '/new', '/clear', '/resume']) {
      expect(deferredSlashCommand(prompt)).toBeUndefined()
    }
  })
  it('helps locally instead of deferring the TUI screen', () => {
    // TUI 說明畫面的資訊等價物:本地列出可用命令,空閒忙碌都走本地路徑。
    expect(deferredSlashCommand('/help')).toBeUndefined()
    expect(busySlashDisposition('/help')).toEqual({ kind: 'respond-local' })
    expect(busySlashDisposition('/help goal')).toEqual({ kind: 'respond-local' })
    expect(alwaysLocalSlashCommand('help')).toBe(true)
  })
  it('keeps the fork multiplexer subcommands deferred as TUI chrome', () => {
    // /fork pane|window|tab 是終端 multiplexer 介面,GUI 無等價;bare /fork
    // 已接出 native full fork。
    for (const sub of ['pane', 'window', 'tab']) {
      expect(deferredSlashCommand(`/fork ${sub}`)).toBe(`fork ${sub}`)
    }
    expect(deferredSlashCommand('/fork')).toBeUndefined()
    expect(busySlashDisposition('/fork pane')).toEqual({ kind: 'gui-action', action: 'fork' }) // 分派前先被 deferred 擋下,此不送模型的結果僅供盤點
  })
  it('keeps TUI-only modes without an upstream RPC deferred', () => {
    // 上游 v18.12.6 無對應 RPC(plan/plan-review/vibe/guided-goal/loop/queue
    // 僅 TUI handleTui),GUI 不偽裝自建生命週期。
    for (const mode of ['plan', 'plan-review', 'vibe', 'guided-goal', 'loop', 'queue']) {
      expect(deferredSlashCommand(`/${mode}`)).toBe(mode)
    }
  })
})

describe('local slash response', () => {
  const runtime: RuntimeInfo = {
    runtimeId: 'rt-1',
    harness: 'omp',
    cwd: '/project',
    sessionFile: '/project/session.jsonl',
    isStreaming: true,
    model: { provider: 'anthropic', id: 'opus', name: 'Claude Opus' },
    thinkingLevel: 'high',
    serviceTier: 'priority',
    contextUsage: { tokens: 151_000, contextWindow: 200_000, percent: 75.5 },
    sessionUsage: { cost: 0.42, tokens: { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 50, total: 1_650 } },
  }
  const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate('en', key, values)
  it('renders the owned-model query from the runtime snapshot', () => {
    expect(localSlashResponse('/model', runtime, t)).toBe('Model: Claude Opus\nThinking effort: high')
    expect(localSlashResponse('/model', undefined, t)).toBe('Model: unknown\nThinking effort: auto')
  })
  it('renders context, usage, session, tier and status snapshots', () => {
    expect(localSlashResponse('/context', runtime, t)).toBe('Context: 151,000 / 200,000 tokens (76%)')
    expect(localSlashResponse('/context', { ...runtime, contextUsage: undefined }, t)).toBe('Context usage is available after the next response.')
    expect(localSlashResponse('/usage', runtime, t)).toBe('Usage this session: $0.42 · 1,000 in / 500 out / 150 cached')
    expect(localSlashResponse('/usage', { ...runtime, sessionUsage: undefined }, t)).toBe('No usage recorded for this session yet.')
    expect(localSlashResponse('/session', runtime, t)).toBe('Session: /project/session.jsonl\nProject: /project\nState: busy')
    expect(localSlashResponse('/fast status', runtime, t)).toBe('Speed tier: priority')
    const status = localSlashResponse('/status', runtime, t)
    expect(status).toContain('Model: Claude Opus')
    expect(status).toContain('State: busy')
    expect(status).toContain('Context: 151,000 / 200,000 tokens (76%)')
    expect(status).toContain('Usage this session: $0.42')
  })
  it('renders the localized command listing for /help', () => {
    // TUI 說明畫面的資訊等價物:帶標題與可用命令清單(GUI 入口命令一併列出)。
    const help = localSlashResponse('/help', undefined, t)
    expect(help.split('\n')[0]).toBe('Commands available here:')
    expect(help).toContain('/tree — Browse the session tree')
    expect(help).toContain('/resume — Resume a different session')
    expect(help).toContain('/help — List available commands')
    // TUI-only 命令(如 plan)不在清單內,不偽裝成可用。
    expect(help).not.toContain('/plan')
  })
  it('localizes the help listing', () => {
    const tw = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate('zh-TW', key, values)
    const help = localSlashResponse('/help', undefined, tw)
    expect(help.split('\n')[0]).toBe('此處可用的指令：')
    expect(help).toContain('/tree — 瀏覽工作階段樹狀圖')
  })
})

describe('alias normalization via the live catalog', () => {
  // 上游 builtin-registry 以主名為主鍵、aliases 指向同一命令;GUI 以
  // catalog aliases 反查主名,不自造對應表。
  const catalog = [
    { name: 'model', source: 'builtin', aliases: ['models'] },
    { name: 'setup', source: 'builtin', aliases: ['providers'] },
    { name: 'quit', source: 'builtin', aliases: ['q'] },
    { name: 'extensions', source: 'builtin', aliases: ['status'] },
    { name: 'pause', source: 'builtin' },
  ]
  it('resolves aliases to canonical names', () => {
    expect(canonicalSlashName('models', catalog)).toBe('model')
    expect(canonicalSlashName('MODELS', catalog)).toBe('model')
    expect(canonicalSlashName('q', catalog)).toBe('quit')
    expect(canonicalSlashName('unknown', catalog)).toBe('unknown')
    expect(canonicalSlashName('models')).toBe('models')
  })
  it('classifies alias invocations like their canonical commands', () => {
    expect(busySlashDisposition('/models', catalog)).toEqual({ kind: 'respond-local' })
    expect(busySlashDisposition('/models', catalog)).toEqual(busySlashDisposition('/model', catalog))
    // catalog 尚未載入時依照 DEFERRED 清單的手寫別名兜底,不直送上游。
    expect(busySlashDisposition('/models')).toEqual({ kind: 'queue-until-idle' })
    expect(deferredSlashCommand('/quit', catalog)).toBe('quit')
    // DEFERRED 內的手寫別名照舊就地辨識;catalog 獨有的別名由反查補上。
    expect(deferredSlashCommand('/providers', catalog)).toBe('providers')
    expect(deferredSlashCommand('/bye', [{ name: 'quit', source: 'builtin', aliases: ['bye'] }])).toBe('quit')
    expect(alwaysLocalSlashCommand('status', catalog)).toBe(true)
    expect(alwaysLocalSlashCommand('status')).toBe(true)
  })
  it('keeps alias dispatch for commands without a catalog entry delegated upstream', () => {
    expect(deferredSlashCommand('/rewind', [{ name: 'branch', source: 'builtin', aliases: ['rewind'] }])).toBeUndefined()
    expect(busySlashDisposition('/rewind', [{ name: 'branch', source: 'builtin', aliases: ['rewind'] }])).toEqual({ kind: 'gui-action', action: 'session-tree' })
  })
})

describe('slash command image capability', () => {
  // 上游語意:skill 命令把圖片併入 promptCustomMessage content;file/custom/
  // mcp_prompt 展開成 prompt 後圖片仍隨同一個 t.prompt 送達,接受;
  // builtin/extension 本地消化,圖片會被靜默丟棄,GUI 拒絕。
  const catalog = [
    { name: 'commit', source: 'skill' },
    { name: 'skill:review', source: 'skill' },
    { name: 'review', source: 'file' },
    { name: 'ship', source: 'custom' },
    { name: 'mcp-thing', source: 'mcp_prompt' },
    { name: 'ext-x', source: 'extension' },
    { name: 'context', source: 'builtin', aliases: ['ctx'] },
    { name: 'compact', source: 'builtin' },
  ]
  it('accepts images for skill and template-expanding commands', () => {
    expect(slashCommandAcceptsImages('/commit make it good', catalog)).toBe(true)
    expect(slashCommandAcceptsImages('/skill:review this png', catalog)).toBe(true)
    expect(slashCommandAcceptsImages('/review', catalog)).toBe(true)
    expect(slashCommandAcceptsImages('/ship now', catalog)).toBe(true)
    expect(slashCommandAcceptsImages('/mcp-thing', catalog)).toBe(true)
  })
  it('rejects images for builtin, extension and unknown commands instead of silently dropping them', () => {
    expect(slashCommandAcceptsImages('/compact', catalog)).toBe(false)
    expect(slashCommandAcceptsImages('/compact soft', catalog)).toBe(false)
    expect(slashCommandAcceptsImages('/context', catalog)).toBe(false)
    expect(slashCommandAcceptsImages('/ctx', catalog)).toBe(false)
    expect(slashCommandAcceptsImages('/ext-x do', catalog)).toBe(false)
    expect(slashCommandAcceptsImages('/unknown-tool', catalog)).toBe(false)
    expect(slashCommandAcceptsImages('/commit make it good')).toBe(false)
    expect(slashCommandAcceptsImages('please look at this', catalog)).toBe(false)
  })
})
