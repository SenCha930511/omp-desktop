// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

const runningMessage: TranscriptMessage = {
  id: 'assistant-running',
  role: 'assistant',
  timestamp: 1_000,
  startedAt: 1_000,
  streaming: true,
  parts: [
    { type: 'thinking', text: 'Checking the deployment config first.' },
    { type: 'toolCall', id: 'tool-1', name: 'read', args: { path: 'config.yaml' } },
    { type: 'text', text: 'The config points at the staging cluster.' },
    { type: 'text', text: '…' },
  ],
}

const settledMessage: TranscriptMessage = {
  id: 'assistant-settled',
  role: 'assistant',
  timestamp: 1_000,
  startedAt: 1_000,
  completedAt: 4_000,
  streaming: false,
  parts: [
    { type: 'thinking', text: 'Checking the deployment config first.' },
    { type: 'toolCall', id: 'tool-1', name: 'read', args: { path: 'config.yaml' } },
    { type: 'text', text: 'The config points at the staging cluster.' },
  ],
}

describe('running work disclosure stays expanded', () => {
  it('renders the live timeline with no collapse control while running', () => {
    act(() => root.render(<WorkDisclosure message={runningMessage} parts={runningMessage.parts} showReasoning showTools running />))

    // Running rows are always expanded: the header is a status line, not a
    // toggle, and the timeline with its narrative stays mounted.
    expect(container.querySelector('button.work-disclosure__button')).toBeNull()
    expect(container.querySelector('.work-disclosure__button')?.getAttribute('role')).toBe('status')
    expect(container.querySelector('.accordion-grid')).not.toBeNull()
    expect(container.querySelector('.work-timeline')).not.toBeNull()

    const notes = [...container.querySelectorAll('.activity-line--note')]
    expect(notes.map((note) => note.textContent)).toEqual(['The config points at the staging cluster.'])
    // Punctuation-only chatter (the stray "…") stays filtered out.
    expect(container.textContent).not.toContain('…')
  })

  it('renders the narrative exactly once while running', () => {
    act(() => root.render(<WorkDisclosure message={runningMessage} parts={runningMessage.parts} showReasoning showTools running />))

    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(1)
    expect(container.querySelector('.work-disclosure__notes')).toBeNull()
  })

  it('folds back to the collapsed summary once the turn settles', () => {
    act(() => root.render(<WorkDisclosure message={runningMessage} parts={runningMessage.parts} showReasoning showTools running />))
    expect(container.querySelector('.accordion-grid')).not.toBeNull()

    // The turn completes: the disclosure collapses on its own and only the
    // final output around it stays visible.
    act(() => root.render(<WorkDisclosure message={settledMessage} parts={settledMessage.parts} showReasoning showTools />))
    expect(container.querySelector('.accordion-grid')).toBeNull()
    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(0)

    // Settled rows keep an expand control for review.
    const button = container.querySelector<HTMLButtonElement>('button.work-disclosure__button')
    expect(button).not.toBeNull()
    act(() => button?.click())
    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(1)
    act(() => button?.click())
    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(0)
  })
})
