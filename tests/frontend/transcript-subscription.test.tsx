// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useWorkspaceRuntime } from '../../src/hooks/useWorkspaceRuntime'
import { ConversationTranscript } from '../../src/components/ConversationTranscript'
import { createTranscriptStore } from '../../src/app/transcript-store'
import { conversationExecution } from '../../src/lib/execution-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('notifies the shell when external runtime signals make an otherwise idle tool interactive', () => {
  const store = createTranscriptStore([{ id: 'a', role: 'assistant', timestamp: 1, parts: [{ type: 'toolCall', id: 'tool', name: 'Read' }] }])
  const notify = vi.fn()
  const unsubscribe = store.subscribeSummary(notify)
  try {
    store.update([{ id: 'a', role: 'assistant', timestamp: 1, parts: [{ type: 'toolCall', id: 'tool', name: 'ask_user' }] }])
    expect(notify).toHaveBeenCalledOnce()
    expect(conversationExecution({ runtime: { runtimeId: 'r', harness: 'omp', cwd: '/project', isStreaming: true },
      messages: store.getSnapshot(), submitting: false, waiting: false })).toMatchObject({ phase: 'waiting', detail: 'ask_user' })
  } finally { unsubscribe() }
})

it('renders streamed frames in the conversation without rerendering the workspace owner', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', clearTimeout)
  const host = document.createElement('div')
  const root = createRoot(host)
  const reportError = vi.fn()
  let renders = 0
  let workspace!: ReturnType<typeof useWorkspaceRuntime>
  function Harness() {
    renders += 1
    workspace = useWorkspaceRuntime({ bridge: null, sessions: [], reportError,
      initialMessages: [{ id: 'live', role: 'assistant', timestamp: 1, streaming: true, parts: [{ type: 'text', text: 'Answer:' }] }] })
    return <ConversationTranscript transcript={workspace.transcriptStore} git={{ isRepo: false, files: [] }} active={workspace.transcriptSummary.streaming}
      onOpenChanges={() => undefined} onSuggestion={() => undefined} />
  }
  try {
    await act(async () => root.render(<Harness />))
    const initial = renders
    for (let frame = 0; frame < 5; frame += 1) {
      act(() => {
        for (let token = 0; token < 20; token += 1) workspace.queueAgentEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
        vi.advanceTimersByTime(100)
      })
    }
    expect(renders).toBe(initial)
    expect(host.querySelector('.prose')?.textContent).toBe(`Answer:${'x'.repeat(100)}`)
    act(() => { workspace.queueAgentEvent({ type: 'agent_end' }); vi.advanceTimersByTime(100) })
    expect(renders).toBeGreaterThan(initial)
    expect(workspace.transcriptSummary.streaming).toBe(false)
  } finally { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() }
})
