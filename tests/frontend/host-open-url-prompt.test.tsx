// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostOpenUrlPrompt } from '../../src/components/HostOpenUrlPrompt'
import { I18nProvider } from '../../src/lib/i18n'
import type { HostAuthorizationSnapshot } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function renderPrompt(
  container: HTMLElement,
  root: Root,
  snapshot: HostAuthorizationSnapshot,
  onDecision: (decision: 'approve' | 'deny') => void,
  busy = false,
): void {
  act(() => {
    root.render(
      <I18nProvider preference="en">
        <HostOpenUrlPrompt snapshot={snapshot} busy={busy} onDecision={onDecision} />
      </I18nProvider>,
    )
  })
}

describe('HostOpenUrlPrompt', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.innerHTML = ''
  })

  it('renders the validated URL and dispatches approve or deny actions', () => {
    const onDecision = vi.fn()
    renderPrompt(
      container,
      root,
      {
        runtimeId: 'rt-1',
        registrationGeneration: 2,
        pending: {
          requestId: 'req-1',
          kind: 'open-url',
          url: 'https://example.test/docs?a=1&b=2',
        },
      },
      onDecision,
    )

    const code = document.body.querySelector('.host-auth-url code')
    expect(code?.textContent).toBe('https://example.test/docs?a=1&b=2')

    const buttons = [...document.body.querySelectorAll('button')]
    const approve = buttons.find((button) => button.textContent === 'Open page')
    const deny = buttons.find((button) => button.textContent === 'Deny')
    expect(approve).toBeDefined()
    expect(deny).toBeDefined()

    act(() => {
      approve?.click()
    })
    expect(onDecision).toHaveBeenLastCalledWith('approve')

    act(() => {
      deny?.click()
    })
    expect(onDecision).toHaveBeenLastCalledWith('deny')
  })

  it('disables decision buttons while a response is in flight', () => {
    const onDecision = vi.fn()
    renderPrompt(
      container,
      root,
      {
        runtimeId: 'rt-1',
        registrationGeneration: 2,
        pending: {
          requestId: 'req-2',
          kind: 'open-url',
          url: 'https://example.test/pending',
        },
      },
      onDecision,
      true,
    )

    const approve = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Open page')
    const deny = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Deny')
    expect(approve?.disabled).toBe(true)
    expect(deny?.disabled).toBe(true)
  })
})
