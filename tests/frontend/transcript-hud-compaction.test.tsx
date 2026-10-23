// @vitest-environment jsdom

import './jsdom-storage'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkTimeline } from '../../src/components/transcript/timeline'
import { TranscriptHud } from '../../src/components/TranscriptHud'
import type { MessagePart, TranscriptMessage } from '../../src/types/api'

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

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.localStorage.clear()
})

function renderParts(parts: MessagePart[]): void {
  act(() => root.render(<WorkTimeline parts={parts} showReasoning showTools streaming />))
}

describe('compaction divider', () => {
  it('renders a quiet centered divider with label and tokens', () => {
    renderParts([{ type: 'compaction', status: 'running', reason: 'threshold', tokensBefore: 99_175 }])

    const divider = container.querySelector('.compaction-divider.is-running')
    expect(divider).not.toBeNull()
    expect(divider?.textContent).toContain('Compacting context')
    expect(divider?.textContent).toContain('99,175 tokens before')
    expect(divider?.querySelectorAll('.compaction-divider__rule')).toHaveLength(2)
    expect(divider?.querySelector('.spin')).not.toBeNull()
  })

  it('marks done compactions with the success color and skipped outcome', () => {
    renderParts([{ type: 'compaction', status: 'done', outcome: 'skipped', reason: 'overflow', tokensBefore: 4_096 }])

    const divider = container.querySelector('.compaction-divider.is-done')
    expect(divider).not.toBeNull()
    expect(divider?.textContent).toContain('Context compaction skipped')
    expect(divider?.querySelector('.spin')).toBeNull()
  })

  it('labels completed compactions with before, after and the size ratio', () => {
    renderParts([{ type: 'compaction', status: 'done', reason: 'manual', tokensBefore: 99_175, tokensAfter: 24_793 }])

    const divider = container.querySelector('.compaction-divider.is-done')
    expect(divider).not.toBeNull()
    expect(divider?.textContent).toContain('99,175 → 24,793 tokens (25% of original)')
  })

  it('flags failed and cancelled compactions with the danger color', () => {
    renderParts([{ type: 'compaction', status: 'failed', reason: 'manual' }, { type: 'compaction', status: 'cancelled', reason: 'requested' }])

    const [failed, cancelled] = [...container.querySelectorAll('.compaction-divider')]
    expect(failed.classList.contains('is-failed')).toBe(true)
    expect(failed.textContent).toContain('Context compaction failed')
    expect(cancelled.classList.contains('is-cancelled')).toBe(true)
    expect(cancelled.textContent).toContain('Context compaction cancelled')
  })

  it('stays out of the bottom HUD, which carries only the todo plan', () => {
    const message: TranscriptMessage = {
      id: 'message-1',
      role: 'system',
      timestamp: 1_000,
      parts: [{ type: 'compaction', status: 'done', reason: 'overflow' }],
    }
    act(() => root.render(<TranscriptHud messages={[message]} />))
    expect(container.querySelector('.transcript-hud')).toBeNull()
  })
})
