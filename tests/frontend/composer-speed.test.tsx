// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../../src/components/Composer'
import type { UsageLimitState } from '../../src/types/api'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface SpeedProps {
  fast?: boolean
  usageLimit?: UsageLimitState
}

function renderSpeedControls(root: Root, container: HTMLDivElement, props: SpeedProps) {
  act(() => root.render(<Composer
    busy={false}
    submitting={false}
    loading={false}
    disabled={false}
    model="openai-codex/gpt-5.6"
    effort="medium"
    modelsByProvider={new Map()}
    providers={[]}
    reasoningLevels={['medium']}
    fast={props.fast ?? false}
    fastSupported
    fastAvailable
    usageLimit={props.usageLimit}
    imageInputSupported={false}
    messageEnterAction="queue"
    skills={[]}
    onModelChange={vi.fn()}
    onEffortChange={vi.fn()}
    onFastChange={vi.fn()}
    onSend={vi.fn()}
    onStop={vi.fn()}
  />))
  return container
}

describe('composer speed controls', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('surfaces the low-priority usage limit with its reset time and allowance', () => {
    renderSpeedControls(root, container, {
      usageLimit: { stage: 'low_priority', resetsAtSec: 1_900_000_000, allowanceLeftPercent: 12 },
    })
    const badge = container.querySelector('.usage-limit-badge')
    expect(badge?.textContent).toContain('Low priority')
    expect((badge as HTMLElement | null)?.title).toContain('low-priority lane')
    expect((badge as HTMLElement | null)?.title).toContain(new Date(1_900_000_000 * 1000).toLocaleString())
    expect((badge as HTMLElement | null)?.title).toContain('12% of the low-priority allowance remains.')
  })

  it('surfaces the wrap-up usage limit including the paid extra-usage note', () => {
    renderSpeedControls(root, container, {
      usageLimit: { stage: 'wrap_up', extraUsage: true },
    })
    const badge = container.querySelector('.usage-limit-badge')
    expect(badge?.textContent).toContain('Wrap-up')
    expect((badge as HTMLElement | null)?.title).toContain('short wrap-up allowance')
    expect((badge as HTMLElement | null)?.title).toContain('Paid extra usage serves requests once the allowance is spent.')
  })

})
