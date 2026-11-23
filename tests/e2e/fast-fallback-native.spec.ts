import { expect, test } from '@playwright/test'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchNativeFormProbe, readNativeWire, type NativeFormProbe } from './extension-form-native.fixture'

test('Retry Fast re-arms the preference without claiming activation, then the ordinary toggle disables it', async () => {
  let probe: NativeFormProbe | undefined
  const diagnostics: string[] = []
  const evidence = join(process.cwd(), '.audit', 'fast-fallback-native')
  try {
    probe = await launchNativeFormProbe({ fastFallback: true })
    const { page, wireFile } = probe
    page.on('pageerror', (error) => diagnostics.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text())
    })

    // Re-selecting the restored session attaches the already-running RPC
    // runtime through the normal workspace reconciliation path.
    const session = page.locator('.session-row[title="Native form fixture"]').first()
    await expect(session).toBeVisible()
    await session.click()
    // Re-read the fake's authoritative preference after catalog decoration;
    // this uses the same native command/state pipeline as ordinary refreshes.
    await expect.poll(async () => page.evaluate(async () => {
      const [runtime] = await window.desktop.agent.list()
      if (!runtime) return false
      await window.desktop.agent.command(runtime.runtimeId, { type: 'get_state' })
      return true
    })).toBe(true)
    expect(await page.evaluate(async () => (await window.desktop.settings.get()).locale)).toBe('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const fastToggle = page.getByRole('button', { name: 'Fast', exact: true })
    const retry = page.getByRole('button', { name: 'Retry Fast', exact: true })
    await expect(fastToggle).toBeVisible()
    await expect(fastToggle).toHaveAttribute('aria-pressed', 'true')
    await expect(retry).toBeVisible()
    await expect(retry).toHaveAttribute(
      'title',
      'Fast mode is enabled, but OMP is not using its priority service. Retry without changing your Fast preference.',
    )
    expect(await retry.getAttribute('aria-pressed')).toBeNull()

    const controls = page.locator('.composer__controls')
    await expect(controls).toBeVisible()
    await expect(retry).toBeInViewport({ ratio: 1 })
    const retryBounds = await retry.boundingBox()
    const controlsBounds = await controls.boundingBox()
    if (!retryBounds || !controlsBounds) throw new Error('Fast controls must have measurable native-window bounds')
    expect(retryBounds.x).toBeGreaterThanOrEqual(controlsBounds.x)
    expect(retryBounds.x + retryBounds.width).toBeLessThanOrEqual(controlsBounds.x + controlsBounds.width + 1)
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    expect(retryBounds.x).toBeGreaterThanOrEqual(0)
    expect(retryBounds.x + retryBounds.width).toBeLessThanOrEqual(viewport.width + 1)
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, 'retry-visible.png') })

    // Start capture after bootstrap/manual reconciliation so subsequent state
    // reads can be attributed to Retry or the ordinary Fast toggle.
    writeFileSync(wireFile, '')
    await retry.click()
    await expect.poll(() => readNativeWire(wireFile).filter((command) => command.type === 'set_fast_mode').length).toBe(1)
    const [retryCommand] = readNativeWire(wireFile).filter((command) => command.type === 'set_fast_mode')
    expect(retryCommand).toEqual({ type: 'set_fast_mode', enabled: true, id: expect.any(String) })
    await page.evaluate(async () => {
      const [runtime] = await window.desktop.agent.list()
      if (!runtime) throw new Error('The native fixture runtime must remain available')
      await window.desktop.agent.command(runtime.runtimeId, { type: 'get_state' })
    })
    await expect.poll(async () => page.evaluate(async () => {
      const [runtime] = await window.desktop.agent.list()
      return { preference: runtime?.serviceTier, active: runtime?.serviceTierActive }
    })).toEqual({ preference: 'priority', active: false })
    await expect(retry).toBeVisible()
    await expect(fastToggle).toHaveAttribute('aria-pressed', 'true')

    await fastToggle.click()
    await expect.poll(() => readNativeWire(wireFile).filter((command) => command.type === 'set_fast_mode').length).toBe(2)
    // No user-generated get_state here: the UI mutation itself must request
    // the authoritative state that makes Retry disappear.
    await expect(retry).toHaveCount(0)
    await expect(fastToggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => page.evaluate(async () => {
      const [runtime] = await window.desktop.agent.list()
      return {
        fastModeSupported: runtime?.fastModeSupported,
        preference: runtime?.serviceTier,
        active: runtime?.serviceTierActive,
      }
    })).toEqual({ fastModeSupported: true, preference: 'default', active: false })

    const commands = readNativeWire(wireFile)
    const fastCommands = commands.filter((command) => command.type === 'set_fast_mode')
    const stateReads = commands.filter((command) => command.type === 'get_state')
    expect(fastCommands).toEqual([
      { type: 'set_fast_mode', enabled: true, id: retryCommand.id },
      { type: 'set_fast_mode', enabled: false, id: expect.any(String) },
    ])
    // One manual read verifies Retry/re-arm; the second must have been issued
    // automatically by changeFast after the disable command succeeded.
    expect(stateReads).toHaveLength(2)
    expect(commands.at(-1)?.type).toBe('get_state')
    expect(fastCommands[1]?.id).not.toBe(retryCommand.id)
    expect(diagnostics).toEqual([])
    copyFileSync(wireFile, join(evidence, 'fake-omp-wire.jsonl'))
    writeFileSync(join(evidence, 'renderer-diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`)
    writeFileSync(join(evidence, 'ui.json'), `${JSON.stringify({ locale: 'en', viewport, retryBounds, controlsBounds, commands: fastCommands.length, stateReads: stateReads.length }, null, 2)}\n`)
  } finally {
    await probe?.close()
  }
})
