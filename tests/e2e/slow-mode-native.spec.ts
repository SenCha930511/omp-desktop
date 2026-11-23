import { expect, test } from '@playwright/test'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchNativeFormProbe, readNativeWire, type NativeFormProbe } from './extension-form-native.fixture'

test('Slow uses native session scope and updates only from refreshed get_state', async () => {
  let probe: NativeFormProbe | undefined
  const diagnostics: string[] = []
  const evidence = join(process.cwd(), '.audit', 'slow-mode-native')
  try {
    probe = await launchNativeFormProbe({ slowMode: true })
    const { page, wireFile } = probe
    page.on('pageerror', (error) => diagnostics.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text())
    })

    const session = page.locator('.session-row[title="Native form fixture"]').first()
    await expect(session).toBeVisible()
    await session.click()
    expect(await page.evaluate(async () => (await window.desktop.settings.get()).locale)).toBe('en')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')

    const slowToggle = page.getByRole('button', { name: 'Slow', exact: true })
    await expect(slowToggle).toBeVisible()
    await expect(slowToggle).toHaveAttribute('aria-pressed', 'false')
    await expect(slowToggle).toHaveAttribute(
      'title',
      'Use OMP slow mode for the current model family in this session only. Each model family has its own preference.',
    )
    const controls = page.locator('.composer__controls')
    await expect(controls).toBeVisible()
    const toggleBounds = await slowToggle.boundingBox()
    const controlsBounds = await controls.boundingBox()
    if (!toggleBounds || !controlsBounds) throw new Error('Slow control must have measurable native-window bounds')
    expect(toggleBounds.x).toBeGreaterThanOrEqual(controlsBounds.x)
    expect(toggleBounds.x + toggleBounds.width).toBeLessThanOrEqual(controlsBounds.x + controlsBounds.width + 1)
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(toggleBounds.x).toBeGreaterThanOrEqual(0)
    expect(toggleBounds.x + toggleBounds.width).toBeLessThanOrEqual(viewportWidth + 1)

    await slowToggle.click()
    await expect.poll(() => readNativeWire(wireFile).length).toBe(1)
    const [enableCommand] = readNativeWire(wireFile)
    expect(enableCommand).toEqual({ type: 'set_slow_mode', enabled: true, id: expect.any(String) })
    await expect(slowToggle).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(async () => page.evaluate(async () => {
      const [runtime] = await window.desktop.agent.list()
      return {
        supported: runtime?.slowModeSupported,
        enabled: runtime?.slowModeEnabled,
        scope: runtime?.slowModeScope,
      }
    })).toEqual({ supported: true, enabled: true, scope: 'session' })

    await slowToggle.click()
    await expect.poll(() => readNativeWire(wireFile).length).toBe(2)
    await expect(slowToggle).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(async () => page.evaluate(async () => {
      const [runtime] = await window.desktop.agent.list()
      return { enabled: runtime?.slowModeEnabled, scope: runtime?.slowModeScope }
    })).toEqual({ enabled: false, scope: 'session' })

    const commands = readNativeWire(wireFile)
    expect(commands).toEqual([
      { type: 'set_slow_mode', enabled: true, id: enableCommand.id },
      { type: 'set_slow_mode', enabled: false, id: expect.any(String) },
    ])
    expect(commands[1]?.id).not.toBe(enableCommand.id)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(diagnostics).toEqual([])
    mkdirSync(evidence, { recursive: true })
    copyFileSync(wireFile, join(evidence, 'fake-omp-wire.jsonl'))
    writeFileSync(join(evidence, 'renderer-diagnostics.json'), `${JSON.stringify(diagnostics, null, 2)}\n`)
    writeFileSync(join(evidence, 'ui.json'), `${JSON.stringify({
      locale: 'en',
      viewportWidth,
      toggleBounds,
      controlsBounds,
      states: { initial: false, afterEnable: true, afterDisable: false },
      commands: commands.length,
    }, null, 2)}\n`)
  } finally {
    await probe?.close()
  }
})
