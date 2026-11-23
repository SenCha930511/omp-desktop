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

  it('renders genuine final wait jobs with native elapsed and keeps their raw result expandable', () => {
    let messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'wait-native', toolName: 'wait', args: {} },
      { type: 'tool_execution_update', toolCallId: 'wait-native', toolName: 'wait', partialResult: { content: [{ type: 'text', text: 'running snapshot' }], details: { op: 'wait', jobs: [{ id: 'job-a', type: 'bash', status: 'running', label: '初回', durationMs: 1_000 }] } } },
    ])
    renderParts(messages[0].parts, true)
    expect(previewText()).toBe('1 native job')

    messages = replayPrimeEvents(messages, [
      { type: 'tool_execution_end', toolCallId: 'wait-native', toolName: 'wait', result: { content: [{ type: 'text', text: 'final native output' }], details: { op: 'wait', jobs: [{ id: 'job-a', type: 'bash', status: 'completed', label: '最終結果', durationMs: 2_000, resultText: 'résultat brut' }] } } },
    ])
    renderParts(messages[0].parts, true)
    const summary = container.querySelector<HTMLButtonElement>('.activity-tool__summary')
    expect(summary?.disabled).toBe(false)
    expect(summary?.getAttribute('aria-expanded')).toBe('false')
    act(() => summary?.click())

    expect(container.querySelector('.activity-tool__wait-jobs')?.textContent).toContain('最終結果')
    expect(container.querySelector('.activity-tool__wait-jobs')?.textContent).toContain('job-a')
    expect(container.querySelector('.activity-tool__wait-jobs')?.textContent).toContain('completed')
    expect(container.querySelector('.activity-tool__wait-jobs')?.textContent).toContain('résultat brut')
    const elapsed = container.querySelector('.activity-tool__engine-elapsed')
    expect(elapsed?.textContent).toBe('Engine elapsed 2s')
    expect(elapsed?.getAttribute('title')).toBe('Engine elapsed 2s')
    expect(container.querySelector('.activity-tool__contents')?.textContent).toContain('final native output')
    expect(container.querySelector('.activity-line--tool .live-elapsed')).toBeNull()
  })

  it('renders only explicit bash timing and the latest reported Vitest totals beside original output', () => {
    const output = 'Test Files 1 failed | 1 passed (2)\nTests 2 failed | 3 passed | 1 expected fail | 1 skipped (7)'
    const messages = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'bash-native', toolName: 'bash', args: { command: 'vitest run' } },
      { type: 'tool_execution_end', toolCallId: 'bash-native', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: output }], details: { wallTimeMs: 3_000, exitCode: 2, timedOut: false } } },
    ])
    renderParts(messages[0].parts, true)
    act(() => container.querySelector<HTMLButtonElement>('.activity-tool__summary')?.click())

    const metadata = container.querySelector('.activity-tool__native-metadata')
    expect(metadata?.textContent).toContain('Engine elapsed3s')
    expect(metadata?.textContent).toContain('Exit code2')
    expect(metadata?.textContent).toContain('Test files 1 failed | 1 passed (2)')
    expect(metadata?.textContent).toContain('Tests 2 failed | 3 passed | 1 expected fail | 1 skipped (7)')
    expect(metadata?.textContent).not.toContain('Timed out')
    expect(metadata?.textContent).not.toContain('PID')
    expect(container.querySelector('.activity-tool__contents')?.textContent).toContain(output)
  })
})
