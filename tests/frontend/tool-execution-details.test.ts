import { describe, expect, it } from 'vitest'
import { replayPrimeEvents } from '../../src/lib/events'
import { MAX_WAIT_JOBS, projectToolExecutionDetails, projectToolResult } from '../../src/lib/tool-execution-details'

function textResult(text: string, details: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text }], details }
}

describe('native tool execution projections', () => {
  it('projects a genuine wait snapshot with native elapsed and untranslated external labels', () => {
    const details = projectToolExecutionDetails(' wait ', textResult('1 running', {
      op: 'wait', cancelled: false,
      jobs: [{
        id: '作業-α', type: 'task', status: 'running', intent: 'レビュー', label: 'Élève 測試', stage: '進行中',
        durationMs: 18_400.5, resultText: 'résultat brut', errorText: '錯誤原文', ignoredSecret: 'not projected',
      }],
    }))
    expect(details).toMatchObject({
      kind: 'wait',
      jobs: [{ id: '作業-α', type: 'task', status: 'running', intent: 'レビュー', label: 'Élève 測試', stage: '進行中', durationMs: 18_400.5, resultText: 'résultat brut', errorText: '錯誤原文' }],
    })
    expect(JSON.stringify(details)).not.toContain('not projected')
    expect(JSON.stringify(details)).not.toContain('cancelled')
  })

  it('distinguishes missing jobs from a genuine empty native job list', () => {
    expect(projectToolExecutionDetails('wait', textResult('', { op: 'wait' }))).toBeUndefined()
    expect(projectToolExecutionDetails('wait', textResult('', { op: 'wait', jobs: [] }))).toMatchObject({ kind: 'wait', jobs: [] })
    expect(projectToolExecutionDetails('wait', textResult('', { op: 'other', jobs: [] }))).toBeUndefined()
    expect(projectToolExecutionDetails('wait', 'plain output')).toBeUndefined()
  })

  it('rejects malformed job arrays instead of inventing partial or zero native counts', () => {
    expect(projectToolExecutionDetails('wait', textResult('', {
      op: 'wait', jobs: [{ id: 'valid' }, null, { id: 'would-otherwise-be-dropped' }],
    }))).toBeUndefined()
    expect(projectToolExecutionDetails('wait', textResult('', { op: 'wait', jobs: ['bad', { unexpected: true }] }))).toBeUndefined()
  })

  it('ignores invalid elapsed fields while preserving otherwise parseable jobs', () => {
    const details = projectToolExecutionDetails('wait', textResult('', {
      op: 'wait',
      jobs: [{ id: 4, label: 'safe', durationMs: -1 }, { id: 'zero', durationMs: 0 }, { id: 'maximum', durationMs: Number.MAX_VALUE }, { id: 'infinite', durationMs: Infinity }, { id: 'nan', durationMs: Number.NaN }],
    }))
    expect(details?.kind).toBe('wait')
    if (details?.kind !== 'wait') throw new Error('wait projection missing')
    expect(details.jobs.map((job) => [job.id ?? job.label, job.durationMs])).toEqual([['safe', undefined], ['zero', 0], ['maximum', Number.MAX_VALUE], ['infinite', undefined], ['nan', undefined]])
  })

  it('caps jobs and strings instead of copying an unbounded native object', () => {
    const jobs = Array.from({ length: MAX_WAIT_JOBS + 8 }, (_, index) => ({ id: `job-${index}`, label: index === 0 ? '界'.repeat(1_100) : `job ${index}`, resultText: index === 0 ? 'x'.repeat(4_100) : undefined }))
    const details = projectToolExecutionDetails('wait', textResult('', { op: 'wait', jobs }))
    expect(details?.kind).toBe('wait')
    if (details?.kind !== 'wait') throw new Error('wait projection missing')
    expect(details.jobs).toHaveLength(MAX_WAIT_JOBS)
    expect(details.truncated).toBe(true)
    expect(details.jobs[0]?.label).toHaveLength(1_000)
    expect(details.jobs[0]?.resultText).toHaveLength(4_000)
    expect(details.jobs.at(-1)?.id).toBe(`job-${MAX_WAIT_JOBS - 1}`)
  })

  it('accepts explicit bash timing, exit and async metadata without treating a job id as a pid', () => {
    const details = projectToolExecutionDetails('Bash', textResult('failed', {
      wallTimeMs: 1234.5, exitCode: 7, timedOut: true, terminalId: 'term-9',
      async: { type: 'bash', state: 'failed', jobId: 'job-abc' }, pid: 999, stdout: 'not separately available',
    }))
    expect(details).toEqual({ kind: 'bash', wallTimeMs: 1234.5, exitCode: 7, timedOut: true, terminalId: 'term-9', async: { jobId: 'job-abc', state: 'failed' } })
    expect(JSON.stringify(details)).not.toContain('999')
    expect(JSON.stringify(details)).not.toContain('not separately available')
  })

  it('supports every observed async state and rejects unknown state or invalid exit/timing fields', () => {
    for (const state of ['running', 'completed', 'failed', 'cancelled'] as const) {
      expect(projectToolExecutionDetails('bash', textResult('', { async: { type: 'bash', jobId: 'j', state } }))).toMatchObject({ async: { state } })
    }
    expect(projectToolExecutionDetails('bash', textResult('', { async: { type: 'bash', jobId: 'j', state: 'queued' } }))).toBeUndefined()
    expect(projectToolExecutionDetails('bash', textResult('', { wallTimeMs: -2, exitCode: 1.5, timedOut: 'yes', async: { type: 'eval', jobId: 'j', state: 'running' } }))).toBeUndefined()
    expect(projectToolExecutionDetails('bash', textResult('', { exitCode: -1 }))).toBeUndefined()
    expect(projectToolExecutionDetails('bash', textResult('', { exitCode: 0 }))).toMatchObject({ exitCode: 0 })
    expect(projectToolExecutionDetails('read', textResult('', { wallTimeMs: 2 }))).toBeUndefined()
  })

  it('projects a complete Vitest summary without treating generic shell output as a report', () => {
    const output = 'Test Files  1 passed (1)\nTests  2 passed (2)'
    expect(projectToolResult('bash', output, textResult(output, {}))).toMatchObject({ testReport: { files: { total: 1 }, tests: { total: 2 } } })
    const terminal = projectToolResult('bash', output, textResult(output, { terminalId: 'term-native', wallTimeMs: 12 }))
    expect(terminal.details).toMatchObject({ kind: 'bash', terminalId: 'term-native', wallTimeMs: 12 })
    expect(terminal.testReport).toBeUndefined()
    expect(projectToolResult('sh', output, textResult(output, {}))).toEqual({})
    expect(projectToolResult('bash', 'Wall time: 42 seconds\nTests 220 passed', textResult('', {}))).toEqual({})
  })
})

describe('tool execution replay snapshots', () => {
  it('replaces a live wait job list with the final native snapshot and retains raw expansion text', () => {
    const initial = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'wait-1', toolName: 'wait', args: {} },
      { type: 'tool_execution_update', toolCallId: 'wait-1', toolName: 'wait', partialResult: textResult('running', { op: 'wait', jobs: [{ id: 'a', status: 'running', durationMs: 1_000 }] }) },
    ])
    expect(initial[0]?.parts[1]).toMatchObject({ type: 'toolResult', streaming: true, text: 'running', details: { kind: 'wait', jobs: [{ id: 'a', status: 'running', durationMs: 1_000 }] } })

    const finished = replayPrimeEvents(initial, [
      { type: 'tool_execution_end', toolCallId: 'wait-1', toolName: 'wait', result: textResult('finished raw output', { op: 'wait', jobs: [{ id: 'a', status: 'completed', durationMs: 2_000, resultText: 'done' }] }) },
    ])
    expect(finished[0]?.parts).toHaveLength(2)
    const result = finished[0]?.parts[1]
    expect(result).toMatchObject({ type: 'toolResult', text: 'finished raw output', details: { kind: 'wait', jobs: [{ id: 'a', status: 'completed', durationMs: 2_000, resultText: 'done' }] } })
    if (result?.type !== 'toolResult') throw new Error('final tool result missing')
    expect(result.streaming).toBeUndefined()

    const malformed = replayPrimeEvents(finished, [
      { type: 'tool_execution_update', toolCallId: 'wait-1', toolName: 'wait', partialResult: textResult('raw fallback remains', { op: 'wait', jobs: [{ id: 'a' }, null] }) },
    ])
    const replacement = malformed[0]?.parts[1]
    expect(replacement).toMatchObject({ type: 'toolResult', text: 'raw fallback remains' })
    if (replacement?.type !== 'toolResult') throw new Error('malformed wait result missing')
    expect(replacement.details).toBeUndefined()
  })

  it('clears stale metadata and report facts when a later full snapshot is malformed', () => {
    const validOutput = 'Test Files 1 passed (1)\nTests 1 passed (1)'
    const initial = replayPrimeEvents([], [
      { type: 'agent_start' },
      { type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'vitest' } },
      { type: 'tool_execution_update', toolCallId: 'bash-1', toolName: 'bash', partialResult: textResult(validOutput, { wallTimeMs: 5 }) },
    ])
    expect(initial[0]?.parts[1]).toMatchObject({ details: { wallTimeMs: 5 }, testReport: { tests: { total: 1 } } })
    const later = replayPrimeEvents(initial, [
      { type: 'tool_execution_update', toolCallId: 'bash-1', toolName: 'bash', partialResult: textResult('partial replacement', { wallTimeMs: -1 }) },
    ])
    const result = later[0]?.parts[1]
    expect(result).toMatchObject({ type: 'toolResult', text: 'partial replacement' })
    if (result?.type !== 'toolResult') throw new Error('replacement tool result missing')
    expect(result.details).toBeUndefined()
    expect(result.testReport).toBeUndefined()
  })
})
