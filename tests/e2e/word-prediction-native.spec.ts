import { expect, test } from '@playwright/test'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchNativeFormProbe, readNativeWire, type NativeFormProbe } from './extension-form-native.fixture'

test('native prediction preserves draft ownership, exact feedback, and mirror dimensions', async () => {
  let probe: NativeFormProbe | undefined
  const diagnostics: string[] = []
  const evidence = join(process.cwd(), '.audit', 'word-prediction-native')
  try {
    probe = await launchNativeFormProbe({ wordPrediction: true })
    const { page, wireFile } = probe
    page.on('pageerror', (error) => diagnostics.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') diagnostics.push(message.text())
    })
    await page.locator('.session-row[title="Native form fixture"]').first().click()
    await expect.poll(() => page.evaluate(async () => (await window.desktop.agent.list()).map((runtime) => ({ runtimeId: runtime.runtimeId, sessionId: runtime.sessionId })))).toEqual([
      { runtimeId: expect.any(String), sessionId: 'native-form-session' },
    ])

    const textarea = page.getByRole('combobox', { name: 'Message OMP' })
    await expect(textarea).toBeVisible()
    writeFileSync(wireFile, '')
    await textarea.pressSequentially('hello')
    const suffix = page.locator('.composer-ghost-text__suffix')
    await expect(suffix).toHaveText(' world')
    await expect(textarea).toHaveValue('hello')
    await expect(textarea).toHaveAttribute('aria-autocomplete', 'inline')
    await expect.poll(() => readNativeWire(wireFile).filter((command) => command.type === 'predict_word').length).toBe(1)
    expect(readNativeWire(wireFile)).toHaveLength(1)
    expect(readNativeWire(wireFile)[0]).toEqual({ type: 'predict_word', text: 'hello', cursor: 5, id: expect.any(String) })

    const mirror = page.locator('.composer-ghost-text')
    await page.setViewportSize({ width: 1440, height: 900 })
    const initialWidth = await textarea.evaluate((element) => element.clientWidth)
    await page.setViewportSize({ width: 1160, height: 900 })
    const narrowWidth = await textarea.evaluate((element) => element.clientWidth)
    expect(narrowWidth).toBeLessThan(initialWidth)
    const narrowHeight = await textarea.evaluate((element) => element.clientHeight)
    await expect.poll(() => mirror.evaluate((element) => ({
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      styleWidth: element.style.width,
      styleHeight: element.style.height,
    }))).toEqual({
      clientWidth: narrowWidth,
      clientHeight: narrowHeight,
      styleWidth: `${narrowWidth}px`,
      styleHeight: `${narrowHeight}px`,
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    const wideWidth = await textarea.evaluate((element) => element.clientWidth)
    expect(wideWidth).toBeGreaterThan(narrowWidth)
    await expect.poll(() => mirror.evaluate((element) => ({
      clientWidth: element.clientWidth,
      styleWidth: element.style.width,
    }))).toEqual({
      clientWidth: wideWidth,
      styleWidth: `${wideWidth}px`,
    })
    await expect(suffix).toHaveText(' world')

    await textarea.pressSequentially('!')
    await expect(suffix).toHaveText(' world')
    await expect.poll(() => readNativeWire(wireFile).filter((command) => command.type === 'predict_word').length).toBe(2)
    expect(readNativeWire(wireFile).filter((command) => command.type === 'predict_word')[1]).toEqual({ type: 'predict_word', text: 'hello!', cursor: 6, id: expect.any(String) })
    await textarea.pressSequentially('?')
    await expect(suffix).toHaveText(' world')
    expect(readNativeWire(wireFile).filter((command) => command.type === 'predict_word_feedback' && command.accepted === false)).toEqual([
      { type: 'predict_word_feedback', text: 'hello', cursor: 5, suggestion: ' world', accepted: false, id: expect.any(String) },
      { type: 'predict_word_feedback', text: 'hello!', cursor: 6, suggestion: ' world', accepted: false, id: expect.any(String) },
    ])
    await expect.poll(() => readNativeWire(wireFile).filter((command) => command.type === 'predict_word' && command.text === 'hello!?').length).toBe(1)
    expect(readNativeWire(wireFile).find((command) => command.type === 'predict_word' && command.text === 'hello!?')?.cursor).toBe(7)
    mkdirSync(evidence, { recursive: true })
    await textarea.screenshot({ path: join(evidence, 'ghost-with-suffix.png') })
    await textarea.press('Tab')
    await expect(textarea).toHaveValue('hello!? world')
    await expect.poll(() => textarea.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(13)
    await expect(textarea).toHaveAttribute('aria-autocomplete', 'list')
    await expect(suffix).toHaveCount(0)
    const feedback = readNativeWire(wireFile).filter((command) => command.type === 'predict_word_feedback')
    expect(feedback).toHaveLength(3)
    expect(feedback.map(({ text, cursor, suggestion, accepted }) => ({ text, cursor, suggestion, accepted }))).toEqual([
      { text: 'hello', cursor: 5, suggestion: ' world', accepted: false },
      { text: 'hello!', cursor: 6, suggestion: ' world', accepted: false },
      { text: 'hello!?', cursor: 7, suggestion: ' world', accepted: true },
    ])

    await textarea.blur()
    await textarea.fill('silent')
    await expect.poll(() => readNativeWire(wireFile).filter((command) => command.type === 'predict_word' && command.text === 'silent').length).toBe(1)
    await expect(suffix).toHaveCount(0)
    await expect(page.locator('[role="alert"]').filter({ hasText: 'predict_word' })).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Message OMP' })).toHaveValue('silent')
    expect(readNativeWire(wireFile).filter((command) => command.type === 'predict_word_feedback')).toHaveLength(3)
    const cursor = readNativeWire(wireFile).find((command) => command.type === 'predict_word' && command.text === 'silent')?.cursor
    expect(cursor).toBe(6)
    expect(diagnostics).toEqual([])

    mkdirSync(evidence, { recursive: true })
    await textarea.screenshot({ path: join(evidence, 'input-lifecycle.png') })
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    writeFileSync(join(evidence, 'diagnostics.json'), `${JSON.stringify({ diagnostics, viewport }, null, 2)}\n`)
    copyFileSync(wireFile, join(evidence, 'wire.jsonl'))
  } finally {
    await probe?.close()
  }
})
