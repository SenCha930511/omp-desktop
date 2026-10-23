// @vitest-environment jsdom

import './jsdom-storage'
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useTranscriptSearch } from '../../src/components/TranscriptSearch'
import type { TranscriptMessage } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

it('highlights a historical match mounted after the initial animation frame and cleans up on close', async () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  class TestHighlight extends Set<Range> {
    constructor(...ranges: Range[]) { super(ranges) }
  }
  const highlights = new Map<string, TestHighlight>()
  vi.stubGlobal('Highlight', TestHighlight)
  vi.stubGlobal('CSS', { escape: (value: string) => value, highlights })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const flushFrames = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  }
  const messages: TranscriptMessage[] = [{ id: 'historical', role: 'assistant', timestamp: 1, parts: [{ type: 'text', text: 'Historical reasoning needle' }] }]
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Harness({ mounted }: { mounted: boolean }) {
    const ref = useRef<HTMLDivElement>(null)
    const search = useTranscriptSearch(messages, ref, () => undefined)
    return <><button type="button" onClick={() => { search.show(); search.changeQuery('reasoning needle') }}>Find</button><button type="button" onClick={search.close}>Close</button><div ref={ref}>{mounted ? <div data-message-id="historical">Historical reasoning needle</div> : null}</div></>
  }
  try {
    await act(async () => root.render(<Harness mounted={false} />))
    await act(async () => container.querySelector('button')?.click())
    act(flushFrames)
    expect(highlights.has('conversation-search')).toBe(false)
    // Only the visible window changes; query, message array, and match id stay fixed.
    await act(async () => root.render(<Harness mounted />))
    act(flushFrames)
    const ranges = highlights.get('conversation-search')
    expect(ranges?.size).toBe(1)
    expect([...ranges ?? []][0]?.toString()).toBe('reasoning needle')
    await act(async () => container.querySelectorAll<HTMLButtonElement>('button')[1]?.click())
    expect(highlights.has('conversation-search')).toBe(false)
    expect(frames.size).toBe(0)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  }
})
