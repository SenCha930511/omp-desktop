// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_MCP_STATE_UNAVAILABLE_DETAIL, NETWORK_MCP_UNAVAILABLE_DETAIL } from '../../src/lib/mcp-policy'
import { PluginsPage } from '../../src/pages/PluginsPage'
import type { SkillRecord } from '../../src/types/api'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const askUser: SkillRecord = {
  id: 'gooeypi-ask-user', name: 'Ask user', description: 'Ask focused questions.',
  kind: 'extension', location: 'system', enabled: true,
}
const computerUse: SkillRecord = {
  id: 'gooeypi-computer-use', name: 'Computer Use | TryCUA', description: 'Native computer use.',
  kind: 'extension', location: 'system', enabled: false,
  availability: { available: false, detail: 'Install Cua Driver before enabling Computer Use.', actionUrl: 'https://cua.ai/docs/how-to-guides/driver/install' },
}
function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PluginsPage bundled capability controls', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  it('confirms before disabling the universal ask_user capability', async () => {
    const setEnabled = vi.fn(async () => undefined)
    const refresh = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[askUser]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={setEnabled}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })}
      />)
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Disable Ask user"]')
    expect(toggle?.getAttribute('aria-pressed')).toBe('true')
    expect(toggle?.querySelector('.plugin-toggle__check')).not.toBeNull()
    expect(toggle?.querySelector('.plugin-toggle__disable')).not.toBeNull()
    await act(async () => { toggle!.click(); await Promise.resolve(); await Promise.resolve() })

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Disable Ask user?')
    expect(dialog.textContent).toContain('Are you sure?')
    expect(setEnabled).not.toHaveBeenCalled()
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, disable')!.click(); await Promise.resolve(); await Promise.resolve() })

    expect(setEnabled).toHaveBeenCalledWith(false)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('enables Browser directly and confirms before disabling it', async () => {
    const setBrowserEnabled = vi.fn(async () => undefined)
    const browser: SkillRecord = { id: 'omp-desktop-browser', name: 'Browser', description: 'In-app browser.', kind: 'skill', location: 'system', enabled: false }
    const render = async (enabled: boolean) => act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[browser]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={enabled} onSetBrowserEnabled={setBrowserEnabled}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })}
      />)
    })
    await render(false)
    const enableBrowser = container.querySelector<HTMLButtonElement>('button[aria-label="Enable Browser"]')!
    expect(enableBrowser.querySelector('.plugin-toggle__plus')).not.toBeNull()
    expect(enableBrowser.querySelector('.plugin-toggle__disable')).toBeNull()
    await act(async () => { enableBrowser.click(); await Promise.resolve() })
    expect(setBrowserEnabled).toHaveBeenCalledWith(true)

    await render(true)
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Disable Browser"]')!.click() })
    expect(setBrowserEnabled).not.toHaveBeenCalledWith(false)
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, disable')!.click(); await Promise.resolve() })
    expect(setBrowserEnabled).toHaveBeenCalledWith(false)
  })

  it('keeps bundled network MCPs non-actionable without inspecting or cleaning up authorization', async () => {
    const mutateCapability = vi.fn(async () => ({ ok: true, output: '' }))
    const refresh = vi.fn(async () => undefined)
    const notion: SkillRecord = {
      id: 'mcp:bundled:notion', name: 'Notion', description: 'Official MCP.', kind: 'mcp', location: 'bundled', enabled: false,
      availability: { available: false, detail: NETWORK_MCP_UNAVAILABLE_DETAIL },
    }
    const render = async (enabled: boolean) => act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[{ ...notion, enabled }]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })}
        onMutateCapability={mutateCapability}
      />)
    })
    await render(false)
    const notionStatus = container.querySelector('[role="img"][aria-label="Externally managed Notion"]')
    expect(container.querySelector(`#${notionStatus?.getAttribute('aria-describedby')}`)?.textContent).toContain('Network MCP servers are managed outside OMP Desktop.')
    expect(container.querySelector('button[aria-label="Enable Notion"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Forget authorization for Notion"]')).toBeNull()
    expect(mutateCapability).not.toHaveBeenCalled()

    await render(true)
    expect(container.querySelector('button[aria-label="Disable Notion"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Forget authorization for Notion"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Remove Notion"]')).toBeNull()
    expect(refresh).not.toHaveBeenCalled()
    expect(mutateCapability).not.toHaveBeenCalled()
  })

  it('renders externally configured network MCPs read-only at either saved state', async () => {
    const setMcpEnabled = vi.fn(async () => ({ ok: true, output: '' }))
    const docs: SkillRecord = {
      id: 'mcp:user:docs', name: 'docs', description: 'HTTP MCP.', kind: 'mcp', location: 'user', enabled: true,
      availability: { available: false, detail: NETWORK_MCP_UNAVAILABLE_DETAIL },
    }
    const render = async (enabled: boolean) => act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[{ ...docs, enabled }]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={setMcpEnabled}
      />)
    })
    await render(true)
    const enabledStatus = container.querySelector('[role="img"][aria-label="Externally managed docs"]')
    expect(container.querySelector(`#${enabledStatus?.getAttribute('aria-describedby')}`)?.textContent).toContain('managed outside OMP Desktop')
    expect(container.querySelector('button[aria-label="Disable docs"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Remove docs"]')).not.toBeNull()
    expect(setMcpEnabled).not.toHaveBeenCalled()

    await render(false)
    const disabledStatus = container.querySelector('[role="img"][aria-label="Externally managed docs"]')
    expect(container.querySelector(`#${disabledStatus?.getAttribute('aria-describedby')}`)?.textContent).toContain('managed outside OMP Desktop')
    expect(container.querySelector('button[aria-label="Enable docs"]')).toBeNull()
    expect(setMcpEnabled).not.toHaveBeenCalled()
  })

  it('offers definition-only removal for user MCPs without forwarding an associated package', async () => {
    const mutateCapability = vi.fn(async () => ({ ok: true, output: '' }))
    const docs: SkillRecord = {
      id: 'mcp:user:docs', name: 'team docs', description: 'HTTP MCP.', kind: 'mcp', location: 'user', enabled: true,
      associatedPackageSource: 'npm:prime-docs', availability: { available: false, detail: NETWORK_MCP_UNAVAILABLE_DETAIL },
      definitionKey: 'team/docs',
    }
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[docs]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })}
        onMutateCapability={mutateCapability}
      />)
    })

    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove team docs"]')!
    const actions = remove.closest('.capability-actions')!
    expect(actions.lastElementChild?.getAttribute('role')).toBe('img')
    expect(actions.lastElementChild?.getAttribute('aria-label')).toBe('Externally managed team docs')
    expect(container.querySelector(`#${actions.lastElementChild?.getAttribute('aria-describedby')}`)?.textContent).toContain('Network MCP servers are managed outside OMP Desktop.')
    await act(async () => { remove.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('only the server definition; harness-owned authorization is not changed')
    expect(dialog.textContent).toContain('Other packages and MCP entries will be kept')
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Yes, remove completely')!.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
    expect(mutateCapability).toHaveBeenCalledWith({ kind: 'mcp', action: 'remove', name: 'team docs', definitionKey: 'team/docs', scope: 'user', projectPath: undefined })
  })

  it('does not offer a broken removal action for an unaddressable external definition', async () => {
    const record: SkillRecord = {
      id: 'mcp:user:oversized', name: 'oversized definition', description: 'Externally managed format.',
      kind: 'mcp', location: 'user', enabled: true, definitionRemovalAvailable: false,
      availability: { available: false, detail: NETWORK_MCP_UNAVAILABLE_DETAIL },
    }
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[record]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })} onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })}
      />)
    })

    expect(container.querySelector('button[aria-label="Remove oversized definition"]')).toBeNull()
    expect(container.querySelector('[role="img"][aria-label="Externally managed oversized definition"]')).not.toBeNull()
  })

  it('opens the TryCUA installer instead of enabling when the driver is missing', async () => {
    const setEnabled = vi.fn(async () => undefined)
    const openExternal = vi.fn()
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[computerUse]} warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={setEnabled} onOpenExternal={openExternal}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })}
      />)
    })

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Enable Computer Use | TryCUA"]')
    await act(async () => { toggle!.click(); await Promise.resolve() })
    expect(openExternal).toHaveBeenCalledWith('https://cua.ai/docs/how-to-guides/driver/install')
    expect(setEnabled).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Install Cua Driver before enabling Computer Use.')
  })

  it('only submits local stdio servers for OMP', async () => {
    const connect = vi.fn(async () => ({ ok: true, output: 'saved server' }))
    const refresh = vi.fn(async () => undefined)
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[]} warnings={[]} loading={false} activeProjectPath="/repo"
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={refresh} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onConnectMcp={connect} onSetMcpEnabled={async () => ({ ok: true, output: '' })}
      />)
    })
    await act(async () => { container.querySelector<HTMLButtonElement>('.button--primary')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add MCP'))!.click() })
    expect(dialog.textContent).toContain('Add a local stdio server to OMP’s native MCP configuration')
    expect(dialog.textContent).toContain('HTTP/SSE servers and OAuth are managed directly in OMP, outside OMP Desktop')
    expect(dialog.textContent).not.toContain('Server URL')
    expect(dialog.textContent).not.toContain('Authentication')
    const inputs = dialog.querySelectorAll<HTMLInputElement>('input')
    await act(async () => { changeInput(inputs[0], 'files'); changeInput(inputs[1], 'npx') })
    const args = dialog.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(args, '-y\nserver-files')
      args.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Save local server')!
    await act(async () => { save.click(); await Promise.resolve(); await Promise.resolve() })
    expect(connect).toHaveBeenCalledWith({ name: 'files', scope: 'user', projectPath: undefined, type: 'stdio', command: 'npx', args: ['-y', 'server-files'] })
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('warns about third-party compatibility and installs a local extension file separately', async () => {
    const installExtension = vi.fn(async () => ({ ok: true, output: 'installed extension' }))
    const openExternal = vi.fn()
    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[]} warnings={[]} loading={false} activeProjectPath="/repo"
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={openExternal}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={installExtension}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={async () => ({ ok: true, output: '' })}
      />)
    })

    await act(async () => { container.querySelector<HTMLButtonElement>('.button--primary')!.click() })
    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.textContent).toContain('Not every third-party package, plugin, or extension will work in OMP Desktop')
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'create a GitHub issue')!.click() })
    expect(openExternal).toHaveBeenCalledWith('https://github.com/am-will/gooey-pi/issues/new')

    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add Plugin'))!.click() })
    expect(dialog.textContent).not.toContain('Not every third-party')
    await act(async () => { dialog.querySelector<HTMLButtonElement>('.modal__footer .button')!.click() })
    await act(async () => { [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Add Extension'))!.click() })
    expect(dialog.textContent).toContain('Extension file')
    expect(dialog.textContent).toContain('native extensions directory')
    expect(dialog.textContent).not.toContain('Not every third-party')
    await act(async () => { changeInput(dialog.querySelector<HTMLInputElement>('input')!, '/tmp/example.ts') })
    const install = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Install extension')!
    await act(async () => { install.click(); await Promise.resolve(); await Promise.resolve() })
    expect(installExtension).toHaveBeenCalledWith({ source: '/tmp/example.ts', scope: 'user', projectPath: undefined })
  })

  it('keeps unaddressable local omp MCP keys externally managed', async () => {
    const setMcpEnabled = vi.fn(async () => ({ ok: true, output: '' }))
    const mutateCapability = vi.fn(async () => ({ ok: true, output: '' }))
    const unusual: SkillRecord = {
      id: 'mcp:user:team-docs', name: 'team/docs', description: 'Local stdio MCP server.',
      kind: 'mcp', location: 'user', enabled: true, definitionKey: 'team/docs',
      availability: {
        available: false,
        detail: LOCAL_MCP_STATE_UNAVAILABLE_DETAIL,
      },
    }
    const oversized: SkillRecord = {
      id: 'mcp:user:oversized-local', name: 'oversized local MCP', description: 'Local stdio MCP server.',
      kind: 'mcp', location: 'user', enabled: false, definitionRemovalAvailable: false,
      availability: {
        available: false,
        detail: LOCAL_MCP_STATE_UNAVAILABLE_DETAIL,
      },
    }

    await act(async () => {
      root.render(<PluginsPage
        harness="omp" skills={[unusual, oversized]}
        warnings={[]} loading={false}
        askUserEnabled={true} onSetAskUserEnabled={async () => undefined}
        browserEnabled={true} onSetBrowserEnabled={async () => undefined}
        computerUseEnabled={false} onSetComputerUseEnabled={async () => undefined} onOpenExternal={() => undefined}
        onRefresh={async () => undefined} onInstall={async () => ({ ok: true, output: '' })}
        onInstallExtension={async () => ({ ok: true, output: '' })}
        onConnectMcp={async () => ({ ok: true, output: '' })}
        onSetMcpEnabled={setMcpEnabled}
        onMutateCapability={mutateCapability}
      />)
    })

    const unusualStatus = container.querySelector('[role="img"][aria-label="Externally managed team/docs"]')
    expect(container.querySelector(`#${unusualStatus?.getAttribute('aria-describedby')}`)?.textContent).toContain('cannot safely enable or disable')
    expect(container.querySelector(`#${unusualStatus?.getAttribute('aria-describedby')}`)?.textContent).toContain('managed outside OMP Desktop')
    expect(container.querySelector('button[aria-label="Disable team/docs"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Remove team/docs"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Enable oversized local MCP"]')).toBeNull()
    expect(container.querySelector('button[aria-label="Remove oversized local MCP"]')).toBeNull()
    expect(setMcpEnabled).not.toHaveBeenCalled()
    expect(mutateCapability).not.toHaveBeenCalled()
  })
})
