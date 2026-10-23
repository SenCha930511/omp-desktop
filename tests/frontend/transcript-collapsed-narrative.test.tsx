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

function collapse(): void {
  const button = container.querySelector<HTMLButtonElement>('.work-disclosure__button')
  expect(button).not.toBeNull()
  act(() => button?.click())
}

describe('collapsed running disclosure keeps streamed narrative visible', () => {
  it('hoists narrative text below the button while a running turn is collapsed', () => {
    act(() => root.render(<WorkDisclosure message={runningMessage} parts={runningMessage.parts} showReasoning showTools running />))

    // Running rows mount open; collapsing hides the timeline but not the text.
    collapse()
    expect(container.querySelector('.accordion-grid')).toBeNull()
    expect(container.querySelector('.work-timeline')).toBeNull()

    const notes = [...container.querySelectorAll('.work-disclosure__notes .activity-line--note')]
    expect(notes.map((note) => note.textContent)).toEqual(['The config points at the staging cluster.'])
    // Punctuation-only chatter (the stray "…") stays filtered out.
    expect(container.textContent).not.toContain('…')
  })

  it('renders the narrative exactly once while the disclosure is open', () => {
    act(() => root.render(<WorkDisclosure message={runningMessage} parts={runningMessage.parts} showReasoning showTools running />))

    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(1)
    expect(container.querySelector('.work-disclosure__notes')).toBeNull()
  })

  it('keeps settled collapsed rows free of hoisted narrative', () => {
    act(() => root.render(<WorkDisclosure message={settledMessage} parts={settledMessage.parts} showReasoning showTools />))

    // Settled rows mount collapsed: no hoisted text until expanded.
    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(0)
    const button = container.querySelector<HTMLButtonElement>('.work-disclosure__button')
    act(() => button?.click())
    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(1)
    collapse()
    expect(container.querySelectorAll('.activity-line--note')).toHaveLength(0)
  })
})
