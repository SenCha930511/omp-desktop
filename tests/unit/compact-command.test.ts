import { describe, expect, it } from 'vitest'
import { parseCompactCommand } from '../../src/hooks/useWorkspaceActions'

// 與上游 compact-modes.ts(Yke)同语义:第一个 token 不分大小寫比对
// soft|remote|snapcompact;snapcompact 不接受 focus 指示;其餘整段为自定指示。
describe('parseCompactCommand', () => {
  it('parses bare /compact command', () => {
    expect(parseCompactCommand('/compact')).toEqual({ kind: 'rpc' })
    expect(parseCompactCommand('  /compact  ')).toEqual({ kind: 'rpc' })
  })

  it('parses /compact with custom instructions', () => {
    expect(parseCompactCommand('/compact focus on auth')).toEqual({ kind: 'rpc', customInstructions: 'focus on auth' })
    expect(parseCompactCommand('/compact   keep current plan and tests  ')).toEqual({ kind: 'rpc', customInstructions: 'keep current plan and tests' })
  })

  it('parses modes case-insensitively like upstream', () => {
    expect(parseCompactCommand('/compact soft')).toEqual({ kind: 'mode', mode: 'soft' })
    expect(parseCompactCommand('/compact SOFT')).toEqual({ kind: 'mode', mode: 'soft' })
    expect(parseCompactCommand('/compact Soft')).toEqual({ kind: 'mode', mode: 'soft' })
    expect(parseCompactCommand('/compact REMOTE')).toEqual({ kind: 'mode', mode: 'remote' })
    expect(parseCompactCommand('/compact SnapCompact')).toEqual({ kind: 'mode', mode: 'snapcompact' })
  })

  it('routes mode plus extra text to the slash dispatcher without inventing custom instructions', () => {
    // soft/remote 接受 focus 指示,但 RPC 不承載模式与指示,交給上游 dispatcher。
    expect(parseCompactCommand('/compact soft keep the auth bits')).toEqual({ kind: 'mode', mode: 'soft' })
    expect(parseCompactCommand('/compact SOFT keep the auth bits')).toEqual({ kind: 'mode', mode: 'soft' })
    expect(parseCompactCommand('/compact remote summarize aggressively')).toEqual({ kind: 'mode', mode: 'remote' })
  })

  it('rejects focus instructions for snapcompact (upstream rejectsFocus)', () => {
    expect(parseCompactCommand('/compact snapcompact focus on tests')).toEqual({ kind: 'error', error: 'snapcompact-focus' })
    expect(parseCompactCommand('/compact SNAPCOMPACT focus on tests')).toEqual({ kind: 'error', error: 'snapcompact-focus' })
  })

  it('returns undefined for non-compact prompts or prefix matches', () => {
    expect(parseCompactCommand('/compacting')).toBeUndefined()
    expect(parseCompactCommand('please /compact')).toBeUndefined()
    expect(parseCompactCommand('/review')).toBeUndefined()
    expect(parseCompactCommand('hello world')).toBeUndefined()
  })
})
