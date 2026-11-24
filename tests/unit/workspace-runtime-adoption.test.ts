import { describe, expect, it } from 'vitest'
import { findAdoptableRuntime, runtimeSatisfiesSelection, type ComposerSelection } from '../../src/lib/workspace'
import type { RuntimeInfo } from '../../src/types/api'

const runtime = (overrides: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  runtimeId: 'runtime-1',
  harness: 'omp',
  cwd: '/repo',
  sessionFile: '/repo/session.jsonl',
  isStreaming: false,
  model: { provider: 'openai-codex', id: 'gpt-5.6', name: 'GPT-5.6' },
  thinkingLevel: 'medium',
  configuredThinkingLevel: 'medium',
  fastModeSupported: true,
  serviceTier: 'default',
  ...overrides,
})

const selection = (overrides: Partial<ComposerSelection> = {}): ComposerSelection => ({
  model: 'openai-codex/gpt-5.6',
  effort: 'medium',
  fast: false,
  ...overrides,
})

describe('runtimeSatisfiesSelection', () => {
  it('matches a runtime that already reports the selected model, effort, and fast tier', () => {
    expect(runtimeSatisfiesSelection(runtime(), selection())).toBe(true)
  })

  it('rejects a different model, effort, or fast preference', () => {
    expect(runtimeSatisfiesSelection(runtime(), selection({ model: 'openai-codex/gpt-5.5' }))).toBe(false)
    expect(runtimeSatisfiesSelection(runtime(), selection({ effort: 'high' }))).toBe(false)
    expect(runtimeSatisfiesSelection(runtime(), selection({ fast: true }))).toBe(false)
  })

  it('treats an empty selection model as no model preference', () => {
    // peekSelection returns null instead, but an empty key must not make a
    // runtime unadoptable when the rest of the selection still matches.
    expect(runtimeSatisfiesSelection(runtime({ model: null }), selection({ model: '' }))).toBe(true)
    expect(runtimeSatisfiesSelection(runtime({ model: null }), selection({ model: 'openai-codex/gpt-5.6' }))).toBe(false)
  })

  it('compares effort against the configured level and treats auto as unconstrained', () => {
    expect(runtimeSatisfiesSelection(runtime({ configuredThinkingLevel: 'high', thinkingLevel: 'low' }), selection({ effort: 'high' }))).toBe(true)
    expect(runtimeSatisfiesSelection(runtime({ configuredThinkingLevel: 'high', thinkingLevel: 'low' }), selection({ effort: 'low' }))).toBe(false)
    expect(runtimeSatisfiesSelection(runtime({ configuredThinkingLevel: undefined, thinkingLevel: 'low' }), selection({ effort: 'low' }))).toBe(true)
    expect(runtimeSatisfiesSelection(runtime({ configuredThinkingLevel: undefined, thinkingLevel: 'low' }), selection({ effort: 'auto' }))).toBe(true)
  })

  it('ignores fast when the runtime does not report support', () => {
    expect(runtimeSatisfiesSelection(runtime({ fastModeSupported: undefined, serviceTier: 'default' }), selection({ fast: true }))).toBe(true)
    expect(runtimeSatisfiesSelection(runtime({ fastModeSupported: false, serviceTier: undefined }), selection({ fast: true }))).toBe(true)
  })
  it('allows an authoritative priority runtime to attach before the composer sees it', () => {
    expect(runtimeSatisfiesSelection(runtime({ serviceTier: 'priority' }), selection({ fast: false }))).toBe(true)
  })

})

describe('findAdoptableRuntime', () => {
  it('adopts an idle runtime that agrees with the current selection', () => {
    expect(findAdoptableRuntime([runtime()], '/repo', '/repo/session.jsonl', selection())).toEqual(runtime())
  })

  it('refuses an idle runtime that disagrees with the current selection', () => {
    expect(findAdoptableRuntime([runtime()], '/repo', '/repo/session.jsonl', selection({ model: 'openai-codex/gpt-5.5' }))).toBeUndefined()
    expect(findAdoptableRuntime([runtime()], '/repo', '/repo/session.jsonl', selection({ effort: 'high' }))).toBeUndefined()
    expect(findAdoptableRuntime([runtime()], '/repo', '/repo/session.jsonl', selection({ fast: true }))).toBeUndefined()
  })

  it('still adopts a streaming runtime that disagrees, because it owns the live transcript', () => {
    const streaming = runtime({ isStreaming: true })
    expect(findAdoptableRuntime([streaming], '/repo', '/repo/session.jsonl', selection({ model: 'openai-codex/gpt-5.5' }))).toEqual(streaming)
  })

  it('preserves the existing lookup when no selection is known', () => {
    expect(findAdoptableRuntime([runtime()], '/repo', '/repo/session.jsonl', undefined)).toEqual(runtime())
    expect(findAdoptableRuntime([runtime()], '/repo', '/repo/session.jsonl', null)).toEqual(runtime())
    expect(findAdoptableRuntime([runtime()], '/repo', '/repo/session.jsonl')).toEqual(runtime())
  })

  it('keeps the session-file fallback ordering of findRuntimeForWorkspace', () => {
    const drifted = runtime({ runtimeId: 'drifted', cwd: '/other-folder' })
    expect(findAdoptableRuntime([drifted], '/repo', '/repo/session.jsonl', selection())).toEqual(drifted)
    expect(findAdoptableRuntime([drifted], '/repo', '/repo/session.jsonl', selection({ model: 'openai-codex/gpt-5.5' }))).toBeUndefined()
  })

  it('never adopts a runtime for another session', () => {
    expect(findAdoptableRuntime([runtime({ sessionFile: '/repo/other.jsonl' })], '/repo', '/repo/session.jsonl', selection())).toBeUndefined()
    expect(findAdoptableRuntime([runtime()], '/repo', undefined, selection())).toBeUndefined()
    expect(findAdoptableRuntime([runtime()], undefined, '/repo/session.jsonl', selection())).toBeUndefined()
  })
})
