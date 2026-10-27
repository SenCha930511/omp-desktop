// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTreeDialog } from '../../src/components/SessionTreeDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

// Modal portals into document.body; query the whole document.
const treeResponse = {
  success: true,
  data: {
    tree: [
      {
        entry: { id: 'a', parentId: null, type: 'message', timestamp: '2026-10-27T09:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello, how can I help?' }] } },
        children: [
          {
            entry: { id: 'b1', parentId: 'a', type: 'message', timestamp: '2026-10-27T09:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'first attempt' }] } },
            children: [],
          },
          {
            entry: { id: 'b2', parentId: 'a', type: 'message', timestamp: '2026-10-27T09:02:00Z', message: { role: 'user', content: [{ type: 'text', text: 'second attempt' }] } },
            children: [
              { entry: { id: 'c', parentId: 'b2', type: 'message', timestamp: '2026-10-27T09:03:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, children: [] },
            ],
          },
        ],
      },
    ],
    leafId: 'c',
  },
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.querySelectorAll('.modal-backdrop').forEach((node) => { node.remove() })
  Reflect.deleteProperty(window, 'desktop')
  vi.restoreAllMocks()
})

function renderDialog(props: Partial<Parameters<typeof SessionTreeDialog>[0]> = {}) {
  return act(async () => {
    root.render(<SessionTreeDialog runtimeId="runtime-1" onClose={vi.fn()} {...props} />)
  })
}

describe('SessionTreeDialog loading states', () => {
  it('degrades to a readable message when the desktop bridge is missing', async () => {
    await renderDialog()
    expect(document.body.textContent).toContain('The session tree is only available in the desktop app.')
  })

  it('degrades when no runtime is attached to the workspace', async () => {
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command: vi.fn() } } })
    await renderDialog({ runtimeId: undefined })
    expect(document.body.textContent).toContain('Start the session first, then reopen the session tree.')
  })

  it('shows a readable load failure with a retry that refetches once clicked', async () => {
    const command = vi.fn(async (): Promise<Record<string, unknown>> => { throw new Error('transport closed') })
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    await renderDialog()
    expect(document.body.textContent).toContain('transport closed')
    expect(command).toHaveBeenCalledTimes(1)
    command.mockResolvedValue(treeResponse)
    const retry = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!
    await act(async () => { retry.click() })
    expect(command).toHaveBeenCalledTimes(2)
    expect(document.body.textContent).toContain('second attempt')
  })
})

describe('SessionTreeDialog tree rendering', () => {
  it('renders flattened rows, marks the current leaf, and only offers actions on user nodes', async () => {
    const command = vi.fn(async () => treeResponse)
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    await renderDialog()
    expect(command).toHaveBeenCalledWith('runtime-1', { type: 'get_tree' })
    expect(document.body.textContent).toContain('first attempt')
    expect(document.body.textContent).toContain('second attempt')
    expect(document.body.textContent).toContain('done')
    const branchButtons = [...document.querySelectorAll('button')].filter((button) => button.textContent === 'Branch & edit prompt')
    expect(branchButtons).toHaveLength(2)
    const current = document.querySelector('.session-tree__current')
    expect(current?.textContent).toBe('Current')
    expect(current?.closest('.session-tree__row')?.textContent).toContain('done')
  })

  it('renders the empty state when the session has no entries', async () => {
    const command = vi.fn(async () => ({ success: true, data: { tree: [], leafId: null } }))
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    await renderDialog()
    expect(document.body.textContent).toContain('This session has no entries yet.')
  })

  it('renders a load failure when the response shape is not a session tree', async () => {
    const command = vi.fn(async () => ({ success: true, data: { tree: 'nope' } }))
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    await renderDialog()
    expect(document.body.textContent).toContain('The session tree could not be loaded.')
  })
})

describe('SessionTreeDialog branch actions', () => {
  it('branches with the node entryId, toasts, prefills the prompt, and refetches the tree', async () => {
    const command = vi.fn()
    command.mockResolvedValueOnce(treeResponse)
    command.mockResolvedValueOnce({ success: true, data: { cancelled: false, text: 'first attempt' } })
    command.mockResolvedValueOnce(treeResponse)
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    const onToast = vi.fn()
    const onPrefillPrompt = vi.fn()
    await renderDialog({ onToast, onPrefillPrompt })
    const editButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Branch & edit prompt')!
    await act(async () => { editButton.click() })
    expect(command).toHaveBeenNthCalledWith(2, 'runtime-1', { type: 'branch', entryId: 'b1' })
    expect(onToast).toHaveBeenCalledWith('Branched into a new session.')
    expect(onPrefillPrompt).toHaveBeenCalledWith('first attempt')
    expect(command).toHaveBeenCalledTimes(3)
  })

  it('continue-from-here branches without prefilling the composer', async () => {
    const command = vi.fn()
    command.mockResolvedValueOnce(treeResponse)
    command.mockResolvedValueOnce({ success: true, data: { cancelled: false, text: 'second attempt' } })
    command.mockResolvedValueOnce(treeResponse)
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    const onPrefillPrompt = vi.fn()
    await renderDialog({ onPrefillPrompt, onToast: vi.fn() })
    const continueButtons = [...document.querySelectorAll('button')].filter((button) => button.textContent === 'Continue from here')
    await act(async () => { continueButtons[0].click() })
    expect(command).toHaveBeenNthCalledWith(2, 'runtime-1', { type: 'branch', entryId: 'b1' })
    expect(onPrefillPrompt).not.toHaveBeenCalled()
  })

  it('surfaces a branch failure in the dialog without retrying automatically', async () => {
    const command = vi.fn()
    command.mockResolvedValueOnce(treeResponse)
    command.mockResolvedValueOnce({ success: false, error: 'Invalid entry ID for branching' })
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    const onToast = vi.fn()
    await renderDialog({ onToast })
    const editButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Branch & edit prompt')!
    await act(async () => { editButton.click() })
    expect(document.body.textContent).toContain('Invalid entry ID for branching')
    expect(onToast).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledTimes(2)
  })

  it('reports a hook-cancelled branch without treating it as success', async () => {
    const command = vi.fn()
    command.mockResolvedValueOnce(treeResponse)
    command.mockResolvedValueOnce({ success: true, data: { cancelled: true, text: '' } })
    Object.defineProperty(window, 'desktop', { configurable: true, value: { agent: { command } } })
    const onToast = vi.fn()
    await renderDialog({ onToast })
    const editButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Branch & edit prompt')!
    await act(async () => { editButton.click() })
    expect(document.body.textContent).toContain('A session hook cancelled the branch.')
    expect(onToast).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledTimes(2)
  })
})
