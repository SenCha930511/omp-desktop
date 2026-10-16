import { describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HarnessDiscoveryService, detectedHarnesses, probeHarnessExecutable, reconcileActiveHarness, type HarnessProbeFailure } from '../../electron/main/harness-discovery'
import { defaultSettings, type DesktopState } from '../../electron/main/store'
import { HARNESSES, type HarnessDescriptor } from '../../electron/main/harness'
import { findHarnessExecutable } from '../../electron/main/process-utils'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
describe('HarnessDiscoveryService', () => {
  it('reconciles against the settings state inside the serialized transaction', async () => {
    const state = { settings: defaultSettings() } as DesktopState
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    let queue = Promise.resolve()
    let gated = false
    const store = {
      update<T>(mutator: (draft: DesktopState) => T): Promise<T> {
        const operation = queue.then(async () => {
          if (!gated) {
            gated = true
            await firstGate
          }
          return mutator(state)
        })
        queue = operation.then(() => undefined, () => undefined)
        return operation
      },
    }
    const userSelection = store.update((draft) => { draft.settings.ompApprovalMode = 'yolo'; return structuredClone(draft.settings) })
    const reconciliation = reconcileActiveHarness(store, {
      omp: { path: '/bin/omp', version: '1' },
    })
    releaseFirst()

    await userSelection
    await expect(reconciliation).resolves.toMatchObject({ activeHarness: 'omp' })
    expect(state.settings.activeHarness).toBe('omp')
  })

  it('publishes one atomic status snapshot using the current runtime overrides', async () => {
    const runtimePaths = { omp: '/configured/omp' }
    const findExecutable = vi.fn(async (descriptor: HarnessDescriptor, configured?: string, accept?: (candidate: string) => Promise<boolean>) => {
      const candidate = descriptor.id === 'omp' ? configured ?? null : null
      return candidate && await accept?.(candidate) ? candidate : null
    })
    const probeExecutable = vi.fn(async (path: string) => ({ runnable: true, version: `${path}-version` }))
    const discovery = new HarnessDiscoveryService(() => runtimePaths, { findExecutable, probeExecutable })

    const statuses = await discovery.refresh()

    expect(statuses).toEqual({
      omp: { path: '/configured/omp', version: '/configured/omp-version' },
    })
    expect(discovery.executable('omp')).toBe('/configured/omp')
    expect(detectedHarnesses(statuses)).toEqual(['omp'])
    expect(findExecutable).toHaveBeenCalledWith(expect.objectContaining({ id: 'omp' }), '/configured/omp', expect.any(Function), expect.any(Function))
  })


  it('excludes existing but non-runnable candidates and continues discovery', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '/broken/omp' }),
      {
        findExecutable: async (descriptor, _configured, accept) => {
          if (descriptor.id !== 'omp' || !accept) return null
          for (const candidate of ['/broken/omp', '/working/omp']) if (await accept(candidate)) return candidate
          return null
        },
        probeExecutable: async (path) => path.includes('working')
          ? { runnable: true, version: '2.0.0' }
          : { runnable: false, version: null },
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      omp: { path: '/working/omp', version: '2.0.0' },
    })
  })

  it('prevents an older overlapping refresh from replacing newer results', async () => {
    const firstOmp = deferred<string | null>()
    let generation = 0
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '' }),
      {
        findExecutable: async (descriptor, _configured, accept) => {
          if (descriptor.id !== 'omp') return null
          generation += 1
          const candidate = generation === 1 ? await firstOmp.promise : '/new/omp'
          return candidate && await accept?.(candidate) ? candidate : null
        },
        probeExecutable: async () => ({ runnable: true, version: null }),
      },
    )

    const stale = discovery.refresh()
    const current = await discovery.refresh()
    firstOmp.resolve('/old/omp')

    expect(current.omp.path).toBe('/new/omp')
    await expect(stale).resolves.toMatchObject({ omp: { path: '/new/omp' } })
    expect(discovery.executable('omp')).toBe('/new/omp')
  })


  it.each([
    ['exit', { kind: 'exit', code: 1, detail: 'Node.js is too old' }],
    ['spawn', { kind: 'spawn', detail: 'path does not exist' }],
    ['timeout', { kind: 'timeout', detail: 'after 10 seconds' }],
    ['overflow', { kind: 'overflow', detail: 'output exceeded the probe limit' }],
  ] as const)('reports a %s probe failure', async (_label, failure) => {
    const probeFailure = failure as HarnessProbeFailure
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '' }),
      {
        findExecutable: async (descriptor, _configured, accept, onFailure) => {
          if (descriptor.id !== 'omp' || !accept) return null
          await accept('/broken/omp')
          onFailure?.({ path: '/broken/omp', reason: 'probe failed', kind: 'rejected' })
          return null
        },
        probeExecutable: async () => ({ runnable: false, version: null, failure: probeFailure }),
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      omp: { path: null, version: null, problem: { path: '/broken/omp', reason: expect.stringContaining(failure.kind === 'exit' ? 'exited with code 1' : failure.kind === 'spawn' ? 'could not start' : failure.kind === 'timeout' ? 'timed out' : 'output exceeded') } },
    })
  })

  it('reports missing and non-executable configured candidates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gooeypi-discovery-'))
    const missing = join(dir, 'missing-omp')
    const nonExecutable = join(dir, 'omp')
    writeFileSync(nonExecutable, '#!/bin/sh\nexit 0\n')
    chmodSync(nonExecutable, 0o644)
    try {
      const missingFailures: Array<{ path: string; reason: string }> = []
      await findHarnessExecutable(HARNESSES.omp, missing, async () => false, (failure) => missingFailures.push(failure))
      expect(missingFailures.find((failure) => failure.path === missing)).toEqual({ path: missing, reason: 'path does not exist', kind: 'missing' })

      const nonExecutableFailures: Array<{ path: string; reason: string }> = []
      await findHarnessExecutable(HARNESSES.omp, nonExecutable, async () => false, (failure) => nonExecutableFailures.push(failure))
      expect(nonExecutableFailures.find((failure) => failure.path === nonExecutable)).toEqual({ path: nonExecutable, reason: 'not executable', kind: 'rejected' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not report an absent automatic candidate', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '' }),
      {
        findExecutable: async (descriptor, _configured, _accept, onFailure) => {
          if (descriptor.id === 'omp') onFailure?.({ path: '/automatic/omp', reason: 'path does not exist', kind: 'missing' })
          return null
        },
      },
    )

    const statuses = await discovery.refresh()
    expect(statuses).toMatchObject({
      omp: { path: null, version: null },
    })
    expect(statuses.omp.problem).toBeUndefined()
  })

  it('reports an automatic candidate that exists but is rejected', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '' }),
      {
        findExecutable: async (descriptor, _configured, _accept, onFailure) => {
          if (descriptor.id === 'omp') onFailure?.({ path: '/automatic/omp', reason: 'probe failed', kind: 'rejected' })
          return null
        },
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      omp: { path: null, version: null, problem: { path: '/automatic/omp', reason: 'probe failed' } },
    })
  })

  it('reports an absent configured override', async () => {
    const discovery = new HarnessDiscoveryService(
      () => ({ omp: '/configured/omp' }),
      {
        findExecutable: async (descriptor, _configured, _accept, onFailure) => {
          if (descriptor.id === 'omp') onFailure?.({ path: '/configured/omp', reason: 'path does not exist', kind: 'missing' })
          return null
        },
      },
    )

    await expect(discovery.refresh()).resolves.toMatchObject({
      omp: { path: null, version: null, problem: { path: '/configured/omp', reason: 'path does not exist' } },
    })
  })

  it('keeps the meaningful last stderr line in a probe failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gooeypi-probe-'))
    const executable = join(dir, 'omp')
    writeFileSync(executable, '#!/bin/sh\nprintf "warning noise\\n(node:123) ExperimentalWarning: noisy\\nTypeError: webidl.util.markAsUncloneable is not a function\\n" >&2\nexit 1\n')
    chmodSync(executable, 0o755)
    try {
      await expect(probeHarnessExecutable(executable)).resolves.toMatchObject({
        runnable: false,
        failure: { kind: 'exit', detail: 'TypeError: webidl.util.markAsUncloneable is not a function' },
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
