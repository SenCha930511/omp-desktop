// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkTimeline } from '../../src/components/transcript/timeline'
import { replayPrimeEvents } from '../../src/lib/events'
import type { MessagePart, TranscriptMessage } from '../../src/types/api'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderParts(parts: MessagePart[], streaming: boolean): void {
  act(() => root.render(createElement(WorkTimeline, { parts, showReasoning: true, showTools: true, streaming })))
}

function previewText(): string | null | undefined {
  return container.querySelector('.activity-tool__preview')?.textContent
}

describe('wait tool summaries', () => {
  it('describes an empty-schema live wait and preserves its output after completion', () => {
    const streamed = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'wait-1', toolName: 'wait', args: {} },
    ])
    renderParts(streamed[0].parts, true)

    expect(previewText()).toBe('Pending work')
    expect(container.querySelector('.activity-line--tool .live-elapsed')).toBeNull()
    expect(previewText()).not.toContain('{}')

    const finished: TranscriptMessage[] = replayPrimeEvents(streamed, [
      { type: 'tool_execution_end', toolCallId: 'wait-1', toolName: 'wait', result: 'wait raw output' },
    ])
    renderParts(finished[0].parts, true)
    expect(previewText()).toBe('Waiting finished')
    expect(previewText()).not.toBe('Pending work')

    const summary = container.querySelector<HTMLButtonElement>('.activity-tool__summary')
    act(() => summary?.click())
    const contents = container.querySelector('.activity-tool__contents')?.textContent
    expect(contents).toContain('{}')
    expect(contents).toContain('wait raw output')
  })

  it('uses an explicit target without claiming that an empty handle names a job', () => {
    renderParts([{ type: 'toolCall', id: 'wait-target', name: 'wait', args: { jobId: 'job-17' } }], true)
    expect(previewText()).toBe('job-17')
    expect(previewText()).not.toContain('Pending work')
  })

  it('bounds a supplied target and declines to infer an unknown persisted state', () => {
    renderParts([{ type: 'toolCall', id: 'wait-long', name: 'wait', args: { target_session_id: 'j'.repeat(180) } }], true)
    expect(previewText()).toHaveLength(121)
    expect(previewText()?.endsWith('…')).toBe(true)

    renderParts([{ type: 'toolCall', id: 'wait-history', name: 'wait', args: {} }], false)
    expect(previewText()).toBe('Wait status unavailable')
    expect(previewText()).not.toBe('Pending work')
    expect(previewText()).not.toBe('Waiting finished')
  })
})
