import { CapabilityBridge, type CapabilityClaim } from '../lib/capability-bridge'
import { canonicalSessionPath } from '../session-paths'
import type { TerminalService } from '../terminal'
import type { RpcObject } from '../agent-rpc/types'
import { browserHostToolScope } from './host-tools'
import type { AgentBrowserService } from './agent-service'

export interface AgentBrowserBridgeOptions {
  service: AgentBrowserService
  terminals: Pick<TerminalService, 'readActive'>
  extensionPath: string
  skillPath: string
}

export class AgentBrowserBridge extends CapabilityBridge {
  // Browser driving is chattier than scheduling: a single agent turn can
  // issue dozens of read/act/verify calls.
  protected readonly rateLimit = 240
  protected readonly rateLimitError = 'Browser API rate limit exceeded; slow down and retry shortly'

  constructor(private readonly options: AgentBrowserBridgeOptions) { super() }

  protected environmentEntries(url: string, token: string): NodeJS.ProcessEnv {
    return {
      OMP_DESKTOP_BROWSER_URL: url,
      OMP_DESKTOP_BROWSER_TOKEN: token,
      OMP_DESKTOP_BROWSER_EXTENSION_PATH: this.options.extensionPath,
      OMP_DESKTOP_BROWSER_SKILL_PATH: this.options.skillPath,
    }
  }

  /**
   * Runtimes started without --resume only learn their session file at
   * handshake; the manager reports it here so the claim gains its session
   * scope. An existing scope is never overwritten.
   */
  bindSession(token: string | undefined, sessionFile: string | undefined): void {
    if (!token || !sessionFile) return
    const claim = this.claimForToken(token)
    if (claim && !claim.sessionPath) claim.sessionPath = sessionFile
  }

  /**
   * Path-only move:claim scope 已由基底 orthogonally 改寫成 newPath;這裡把
   * 分頁註冊表裡屬於舊檔的 tab/active/preview 所有權一併移過去,
   * 否則該 session 已開啟的瀏覽器分頁會變成永久不可達的孤兒。
   */
  protected override onSessionRebound(_claim: CapabilityClaim, previousPath: string, newPath: string): void {
    this.options.service.rekeySession(previousPath, newPath)
  }

  protected async dispatch(method: string, params: Record<string, unknown>, claim: CapabilityClaim): Promise<unknown> {
    if (!claim.sessionPath) throw new Error('Browser control is not available yet for this thread; try again in a moment')
    return this.call(method, params, canonicalSessionPath(claim.sessionPath))
  }

  /**
   * Runs one OMP v19 host tool call for the runtime that owns `sessionPath`.
   * Host tool frames carry no bearer token, so the claim is resolved from the
   * session the manager reports for that runtime; a runtime without a live
   * claim (Browser disabled, or not bound yet) gets a clear error instead of
   * another thread's tabs.
   */
  async hostToolCall(sessionPath: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    const claim = this.claimForSession(sessionPath)
    if (!claim) throw new Error('Browser control is not available for this session; the Browser capability is disabled or this runtime is not ready yet')
    return this.dispatch(method, params, claim)
  }

  /**
   * Browser host tool definitions and handlers bound to one runtime's session.
   * A session with no live claim (Browser disabled, or no environment minted
   * for it) yields no tools: advertising handlers that could only fail would
   * leave dead tools in the model's list.
   */
  hostToolScope(sessionPath: string): { tools: RpcObject[]; handlers: Map<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>> } {
    if (!this.claimForSession(sessionPath)) return { tools: [], handlers: new Map() }
    return browserHostToolScope((method, params) => this.hostToolCall(sessionPath, method, params))
  }

  private call(method: string, params: Record<string, unknown>, sessionKey: string): Promise<unknown> {
    const service = this.options.service
    if (method === 'terminal.read') {
      const active = this.options.terminals.readActive(sessionKey)
      if (!active) throw new Error('No active terminal is open for this task')
      return Promise.resolve(active)
    }
    if (method === 'tabs.list') return service.listTabs(sessionKey)
    if (method === 'tabs.open') return service.openTab(sessionKey, params)
    if (method === 'tabs.close') return service.closeTabScoped(sessionKey, params)
    if (method === 'tabs.select') return service.selectTabScoped(sessionKey, params)
    if (method === 'navigate') return service.navigate(sessionKey, params)
    if (method === 'screenshot') return service.screenshot(sessionKey, params)
    if (method === 'click') return service.click(sessionKey, params)
    if (method === 'type') return service.type(sessionKey, params)
    if (method === 'press_key') return service.pressKey(sessionKey, params)
    if (method === 'scroll') return service.scroll(sessionKey, params)
    if (method === 'read_page') return service.readPage(sessionKey, params)
    if (method === 'evaluate') return service.evaluate(sessionKey, params)
    throw new TypeError(`Unsupported browser method ${method}`)
  }
}
