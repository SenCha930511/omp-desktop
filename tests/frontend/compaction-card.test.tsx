// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkTimeline } from '../../src/components/transcript/timeline'
import type { MessagePart } from '../../src/types/api'

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

function renderParts(parts: MessagePart[]): void {
  act(() => root.render(<WorkTimeline parts={parts} showReasoning showTools streaming />))
}

describe('compaction card', () => {
  it('renders label, reason, token count, state and spinner while running', () => {
    renderParts([{ type: 'compaction', status: 'running', reason: 'threshold', tokensBefore: 99_175 }])

    const card = container.querySelector('.compaction-card.is-running')
    expect(card).not.toBeNull()
    expect(card?.querySelector('.compaction-card__title')?.textContent).toBe('Compacting context')
    expect(card?.querySelector('.compaction-card__reason')?.textContent).toBe('automatic threshold')
    expect(card?.querySelector('.compaction-card__tokens')?.textContent).toBe('99,175 tokens before')
    expect(card?.querySelector('.compaction-card__state')?.textContent).toContain('running')
    expect(card?.querySelector('.compaction-card__icon .spin')).not.toBeNull()
    // Static status row: no disclosure affordance.
    expect(card?.querySelector('button')).toBeNull()
    expect(card?.getAttribute('aria-expanded')).toBeNull()
  })

  it('marks done compactions with the success state', () => {
    renderParts([{ type: 'compaction', status: 'done', reason: 'overflow', tokensBefore: 4_096 }])

    const card = container.querySelector('.compaction-card.is-done')
    expect(card).not.toBeNull()
    expect(card?.querySelector('.compaction-card__title')?.textContent).toBe('Context compacted')
    expect(card?.querySelector('.compaction-card__reason')?.textContent).toBe('overflow recovery')
    expect(card?.querySelector('.compaction-card__state')?.textContent).toContain('done')
    expect(card?.querySelector('.spin')).toBeNull()
  })

  it('flags failed and cancelled compactions with the danger state', () => {
    renderParts([{ type: 'compaction', status: 'failed', reason: 'manual' }, { type: 'compaction', status: 'cancelled', reason: 'requested' }])

    const [failed, cancelled] = [...container.querySelectorAll('.compaction-card')]
    expect(failed.classList.contains('is-failed')).toBe(true)
    expect(failed.querySelector('.compaction-card__state')?.textContent).toContain('needs attention')
    expect(cancelled.classList.contains('is-cancelled')).toBe(true)
    expect(cancelled.querySelector('.compaction-card__state')?.textContent).toContain('cancelled')
  })
})
