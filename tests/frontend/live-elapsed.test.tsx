// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveElapsed } from '../../src/components/transcript/timeline'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('LiveElapsed', () => {
  it('updates the elapsed label on each tick', async () => {
    await act(async () => {
      root.render(<LiveElapsed since={Date.now() - 65_000} />)
      await Promise.resolve()
    })
    expect(container.textContent).toBe('1m05s')

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(container.textContent).toBe('1m06s')
  })

  it('clears its interval when unmounted', async () => {
    const clearInterval = vi.spyOn(globalThis, 'clearInterval')
    await act(async () => {
      root.render(<LiveElapsed since={Date.now()} />)
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(1)

    act(() => root.unmount())
    expect(clearInterval).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops ticking when the turn finishes', async () => {
    function Turn({ running }: { running: boolean }) {
      return running ? <LiveElapsed since={Date.now()} /> : <span>finished</span>
    }

    await act(async () => {
      root.render(<Turn running />)
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBe(1)

    act(() => root.render(<Turn running={false} />))
    expect(container.textContent).toBe('finished')
    expect(vi.getTimerCount()).toBe(0)

    act(() => { vi.advanceTimersByTime(5_000) })
    expect(container.textContent).toBe('finished')
  })
})
