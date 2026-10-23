// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useComposerImages } from '../../src/hooks/useComposerImages'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type Attachments = ReturnType<typeof useComposerImages>

let latest: Attachments
let container: HTMLDivElement
let root: Root

function Harness({ shortName, draftKey }: { shortName: string; draftKey?: string }) {
  latest = useComposerImages({ shortName, draftKey })
  return null
}

function mount(shortName: string, draftKey?: string) {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Harness shortName={shortName} draftKey={draftKey} />))
  return latest
}

function unmount() {
  act(() => root.unmount())
  container.remove()
}

function pngFile(name: string): File {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const file = new File([bytes], name, { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.buffer })
  return file
}

function txtFile(name: string): File {
  return new File(['notes'], name, { type: 'text/plain' })
}

beforeEach(() => {
  let id = 0
  vi.stubGlobal('crypto', {
    randomUUID: () => {
      id += 1
      return `attachment-${id}`
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('composer image store across remounts', () => {
  it('restores images for the same draft key after a remount', async () => {
    mount('OMP', 'project:alpha')
    await act(async () => {
      await latest.ingest([pngFile('shot.png')])
    })
    expect(latest.images).toHaveLength(1)
    const attached = latest.images[0]!
    expect(attached.name).toBe('shot.png')

    unmount()
    mount('OMP', 'project:alpha')
    expect(latest.images).toHaveLength(1)
    expect(latest.images[0]!.id).toBe(attached.id)
    expect(latest.images[0]!.data).toBe(attached.data)
  })

  it('restores unsupported files alongside images', async () => {
    mount('OMP', 'project:beta')
    await act(async () => {
      await latest.ingest([pngFile('shot.png'), txtFile('notes.txt')])
    })
    expect(latest.images).toHaveLength(1)
    expect(latest.unsupportedFiles).toHaveLength(1)

    unmount()
    mount('OMP', 'project:beta')
    expect(latest.images).toHaveLength(1)
    expect(latest.unsupportedFiles).toHaveLength(1)
    expect(latest.unsupportedFiles[0]!.name).toBe('notes.txt')
  })

  it('keeps different draft keys isolated', async () => {
    mount('OMP', 'project:gamma')
    await act(async () => {
      await latest.ingest([pngFile('shot.png')])
    })
    expect(latest.images).toHaveLength(1)
    unmount()

    mount('OMP', 'project:delta')
    expect(latest.images).toHaveLength(0)
    expect(latest.unsupportedFiles).toHaveLength(0)
    unmount()

    // The other key still holds its entry.
    mount('OMP', 'project:gamma')
    expect(latest.images).toHaveLength(1)
  })

  it('drops the stored entry on clear()', async () => {
    mount('OMP', 'project:epsilon')
    await act(async () => {
      await latest.ingest([pngFile('shot.png'), txtFile('notes.txt')])
    })
    expect(latest.images).toHaveLength(1)

    act(() => latest.clear())
    expect(latest.images).toHaveLength(0)
    expect(latest.unsupportedFiles).toHaveLength(0)

    unmount()
    mount('OMP', 'project:epsilon')
    expect(latest.images).toHaveLength(0)
    expect(latest.unsupportedFiles).toHaveLength(0)
  })

  it('keeps the failure-flow restore independent of the store', async () => {
    mount('OMP', 'project:zeta')
    await act(async () => {
      await latest.ingest([pngFile('shot.png')])
    })
    const sent = [...latest.images]
    act(() => latest.clear())
    expect(latest.images).toHaveLength(0)

    // The send failed: the composer re-attaches the submitted images through
    // restoreWithinLimits even though clear() dropped the store entry.
    let restoration: { restored: number; omitted: number } | undefined
    act(() => {
      restoration = latest.restoreWithinLimits(sent)
    })
    expect(restoration).toEqual({ restored: 1, omitted: 0 })
    expect(latest.images).toHaveLength(1)

    unmount()
    mount('OMP', 'project:zeta')
    // The store persisted the restored images again.
    expect(latest.images).toHaveLength(1)
    expect(latest.images[0]!.id).toBe(sent[0]!.id)
  })

  it('leaves a composer without a draft key ephemeral', async () => {
    mount('OMP')
    await act(async () => {
      await latest.ingest([pngFile('shot.png')])
    })
    expect(latest.images).toHaveLength(1)
    unmount()

    mount('OMP')
    expect(latest.images).toHaveLength(0)
  })
})
