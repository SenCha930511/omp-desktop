// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SearchRevealContext } from '../../src/components/TranscriptSearch'
import { AgentMessage, USER_BUBBLE_COLLAPSE_CHAR_THRESHOLD, USER_BUBBLE_COLLAPSE_LINE_THRESHOLD, UserMessage } from '../../src/components/transcript/messages'
import { WorkDisclosure } from '../../src/components/transcript/timeline'
import type { TranscriptMessage } from '../../src/types/api'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

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
})

describe('UserMessage collapsible long prompt bubble', () => {
  it('keeps short user messages expanded without a toggle button', () => {
    const shortMessage: TranscriptMessage = {
      id: 'user-short',
      role: 'user',
      timestamp: 1_000,
      parts: [{ type: 'text', text: 'Short user prompt.' }],
    }

    act(() => root.render(<UserMessage message={shortMessage} />))

    const bubble = container.querySelector('.user-bubble')
    expect(bubble).not.toBeNull()
    expect(bubble?.classList.contains('is-collapsed')).toBe(false)
    expect(container.querySelector('.user-bubble__toggle')).toBeNull()
    expect(bubble?.textContent).toBe('Short user prompt.')
  })

  it('collapses user messages exceeding the character threshold and toggles expansion on click', () => {
    const longText = 'a'.repeat(USER_BUBBLE_COLLAPSE_CHAR_THRESHOLD + 25)
    const longMessage: TranscriptMessage = {
      id: 'user-long-chars',
      role: 'user',
      timestamp: 1_000,
      parts: [{ type: 'text', text: longText }],
    }

    act(() => root.render(<UserMessage message={longMessage} />))

    const bubble = container.querySelector('.user-bubble')
    const toggle = container.querySelector<HTMLButtonElement>('.user-bubble__toggle')
    expect(bubble?.classList.contains('is-collapsed')).toBe(true)
    expect(bubble?.textContent).toBe(longText)
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.getAttribute('aria-label')).toBe('Show more')
    expect(toggle?.getAttribute('data-label')).toBe('Show more')
    expect(toggle?.textContent).toBe('')

    act(() => toggle?.click())

    expect(bubble?.classList.contains('is-collapsed')).toBe(false)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(toggle?.getAttribute('aria-label')).toBe('Show less')
    expect(toggle?.getAttribute('data-label')).toBe('Show less')

    act(() => toggle?.click())

    expect(bubble?.classList.contains('is-collapsed')).toBe(true)
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.getAttribute('aria-label')).toBe('Show more')
  })

  it('collapses multiline user messages exceeding the line threshold and auto-reveals during search', () => {
    const multilineText = Array.from({ length: USER_BUBBLE_COLLAPSE_LINE_THRESHOLD + 2 }, (_, index) => `line ${index + 1}`).join('\n')
    const multilineMessage: TranscriptMessage = {
      id: 'user-long-lines',
      role: 'user',
      timestamp: 1_000,
      parts: [{ type: 'text', text: multilineText }],
    }

    act(() => root.render(<UserMessage message={multilineMessage} />))

    expect(container.querySelector('.user-bubble.is-collapsed')).not.toBeNull()
    expect(container.querySelector('.user-bubble__toggle')).not.toBeNull()

    act(() =>
      root.render(
        <SearchRevealContext.Provider value={true}>
          <UserMessage message={multilineMessage} />
        </SearchRevealContext.Provider>,
      ),
    )

    expect(container.querySelector('.user-bubble.is-collapsed')).toBeNull()
  })
})

describe('Accordion grid transitions on WorkDisclosure and AgentMessage', () => {
  it('wraps WorkDisclosure timeline in .accordion-grid.is-open > .accordion-grid__inner when open', () => {
    const completedMessage: TranscriptMessage = {
      id: 'assistant-work',
      role: 'assistant',
      timestamp: 1_000,
      startedAt: 1_000,
      completedAt: 3_000,
      streaming: false,
      parts: [{ type: 'toolCall', id: 'tool-1', name: 'read', args: { path: 'README.md' } }],
    }

    act(() => root.render(<WorkDisclosure message={completedMessage} parts={completedMessage.parts} showReasoning showTools />))

    expect(container.querySelector('.accordion-grid')).toBeNull()
    expect(container.querySelector('.work-timeline')).toBeNull()

    const button = container.querySelector<HTMLButtonElement>('.work-disclosure__button')
    act(() => button?.click())

    const inner = container.querySelector('.work-disclosure .accordion-grid.is-open > .accordion-grid__inner')
    expect(inner).not.toBeNull()
    expect(inner?.querySelector('.work-timeline')).not.toBeNull()
  })

  it('wraps AgentMessage content in .accordion-grid.is-open > .accordion-grid__inner when open', () => {
    const agentMessage: TranscriptMessage = {
      id: 'agent-msg-1',
      role: 'agent',
      agentName: 'Explorer',
      timestamp: 1_000,
      parts: [{ type: 'text', text: 'Subagent findings ready.' }],
    }

    act(() => root.render(<AgentMessage message={agentMessage} />))

    expect(container.querySelector('.accordion-grid')).toBeNull()
    expect(container.querySelector('.agent-message__content')).toBeNull()

    const summary = container.querySelector<HTMLButtonElement>('.agent-message__summary')
    act(() => summary?.click())

    const inner = container.querySelector('.message--agent .accordion-grid.is-open > .accordion-grid__inner')
    expect(inner).not.toBeNull()
    expect(inner?.querySelector('.agent-message__content')?.textContent).toContain('Subagent findings ready.')
  })

  it('reserves the accordion entrance animation for user-initiated opens, not remounts', () => {
    const runningMessage: TranscriptMessage = {
      id: 'assistant-work-running',
      role: 'assistant',
      timestamp: 1_000,
      startedAt: 1_000,
      streaming: true,
      parts: [{ type: 'toolCall', id: 'tool-1', name: 'read', args: { path: 'README.md' } }],
    }

    // Mounts already open (running turn): no ramp, so a restored scroll offset
    // lands on the final layout instead of chasing the animated height.
    act(() => root.render(<WorkDisclosure message={runningMessage} parts={runningMessage.parts} showReasoning showTools />))
    const mountedOpen = container.querySelector('.work-disclosure .accordion-grid.is-open')
    expect(mountedOpen?.classList.contains('is-animated')).toBe(false)

    const completedMessage: TranscriptMessage = {
      id: 'assistant-work-2',
      role: 'assistant',
      timestamp: 1_000,
      startedAt: 1_000,
      completedAt: 3_000,
      streaming: false,
      parts: [{ type: 'toolCall', id: 'tool-1', name: 'read', args: { path: 'README.md' } }],
    }
    act(() => root.render(<WorkDisclosure key="completed" message={completedMessage} parts={completedMessage.parts} showReasoning showTools />))
    act(() => container.querySelector<HTMLButtonElement>('.work-disclosure__button')?.click())
    expect(container.querySelector('.work-disclosure .accordion-grid.is-open')?.classList.contains('is-animated')).toBe(true)
  })
})
