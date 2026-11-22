import { expect, test } from '@playwright/test'
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { launchNativeFormProbe, readNativeWire, type NativeFormProbe } from './extension-form-native.fixture'

test('rpc-ui renders a native form and returns the exact validated wire response', async () => {
  let probe: NativeFormProbe | undefined
  const diagnostics: string[] = []
  const secret = 'native-probe-secret-do-not-log'
  try {
    probe = await launchNativeFormProbe()
    const { page, wireFile } = probe
    page.on('pageerror', (error) => diagnostics.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text())
    })

    const composer = page.getByRole('combobox', { name: 'Message OMP' })
    await composer.fill('show the native form')
    await composer.press('Enter')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('.extension-form')).toContainText('Native wire probe')
    expect(await dialog.locator('.extension-form').evaluate((form) => form.hasAttribute('action'))).toBe(false)
    await expect(dialog.locator('.extension-form script, .extension-form a, .extension-form iframe, .extension-form object')).toHaveCount(0)

    await dialog.getByLabel('Native project', { exact: true }).fill('desktop-wire')
    const token = dialog.getByLabel('Probe token', { exact: true })
    await expect(token).toHaveAttribute('type', 'password')
    await expect(token).toHaveAttribute('autocomplete', 'off')
    await token.fill(secret)
    await dialog.getByLabel('Threads', { exact: true }).fill('3.5')
    await dialog.getByLabel('Slow', { exact: true }).check()
    await dialog.getByLabel('Alpha', { exact: true }).check()
    await expect(dialog.getByLabel('Beta', { exact: true })).toBeDisabled()
    await dialog.locator('.extension-form__other input').fill('gamma')
    await dialog.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(dialog).toHaveCount(0)

    await expect.poll(() => readNativeWire(wireFile).length).toBe(1)
    const [command] = readNativeWire(wireFile)
    expect(command).toEqual({
      type: 'extension_ui_response',
      id: 'native-form-rpc-1',
      data: {
        project: 'desktop-wire',
        token: secret,
        threads: 3.5,
        mode: 'slow',
        features: ['alpha', 'gamma'],
        origin: 'from-native-frame',
      },
    })
    expect(command).not.toHaveProperty('cancelled')
    expect(command).not.toHaveProperty('timedOut')
    expect(diagnostics).toEqual([])
    expect(diagnostics.join('\n')).not.toContain(secret)
    const evidence = join(process.cwd(), '.audit', 'form-renderer')
    mkdirSync(evidence, { recursive: true })
    copyFileSync(wireFile, join(evidence, 'fake-omp-wire.jsonl'))
  } finally {
    await probe?.close()
  }
})
