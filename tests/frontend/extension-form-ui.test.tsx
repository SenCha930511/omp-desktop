// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionUiModal } from '../../src/components/ExtensionUiModal'
import { I18nProvider } from '../../src/lib/i18n'
import { parseExtensionUiFrame, parseExtensionUiRequest, type ExtensionUiRequest } from '../../src/lib/extension-ui'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0) })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id: number) => window.clearTimeout(id) })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function formFrame(id: string, html: string, timeout?: number): Record<string, unknown> {
  return { type: 'extension_ui_request', id, method: 'form', html, ...(timeout === undefined ? {} : { timeout }) }
}

function requestFromHtml(html: string, id = 'form-1'): ExtensionUiRequest {
  const frame = parseExtensionUiFrame(formFrame(id, html))
  if (frame?.status !== 'ok') throw new Error('fixture form was not parsed')
  return frame.request
}

async function renderRequest(request: ExtensionUiRequest, onRespond = vi.fn(), locale: 'en' | 'zh-TW' = 'en') {
  await act(async () => {
    root.render(<I18nProvider preference={locale}><ExtensionUiModal request={request} onRespond={onRespond} /></I18nProvider>)
  })
  return onRespond
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
  act(() => { input.dispatchEvent(new Event('input', { bubbles: true })) })
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => { element.click() })
}

function field(name: string): HTMLInputElement {
  const match = Array.from(document.querySelectorAll<HTMLInputElement>('input')).find((candidate) => candidate.closest('[data-control-id]')?.querySelector('label,legend')?.textContent?.includes(name))
  if (!match) throw new Error(`input ${name} not rendered`)
  return match
}

function submitButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('.modal__footer button[type="submit"]')
  if (!button) throw new Error('form submit button not rendered')
  return button
}

describe('native form renderer from the raw RPC frame', () => {
  it('edits text, numeric, password, radio, checkbox and Other and emits exact normalized data without cancellation flags', async () => {
    const onRespond = vi.fn()
    const request = requestFromHtml(`
      <form action="https://invalid.example/submit" onsubmit="window.__formAttack = 1">
        <script>window.__formAttack = 1</script>
        <h1>Deployment</h1><ul><li>First</li><li>Second</li></ul><pre>literal &lt;unsafe&gt;</pre>
        <table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>B</td></tr></table>
        <a href="javascript:window.__formAttack = 1">Plain link text</a>
        <label for="project">Project</label><input id="project" name="project" required>
        <label>Workers <input name="workers" type="number" min="0" max="8" step="2"></label>
        <label>Access token <input name="token" type="password" autocomplete="on"></label>
        <fieldset><legend>Mode</legend>
          <label>Fast <input type="radio" name="mode" value="fast" checked></label>
          <label>Slow <input type="radio" name="mode" value="slow"></label>
        </fieldset>
        <fieldset><legend>Features</legend>
          <label>Alpha <input type="checkbox" name="features" value="alpha"></label>
          <label>Beta <input type="checkbox" name="features" value="beta" disabled></label>
        </fieldset>
        <input type="hidden" name="hiddenEcho" value="kept">
        <button type="submit" formaction="https://invalid.example/attack">Do not copy</button>
      </form>`)
    expect(request).toMatchObject({ method: 'form', id: 'form-1' })
    expect('html' in request).toBe(false)
    await renderRequest(request, onRespond)

    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.textContent).toContain('Deployment')
    expect(dialog?.textContent).toContain('First')
    expect(dialog?.textContent).toContain('literal <unsafe>')
    expect(dialog?.querySelector('table')?.textContent).toContain('Value')
    expect(dialog?.textContent).toContain('Plain link text')
    expect(dialog?.textContent).not.toContain('Do not copy')
    expect(dialog?.querySelector('.extension-form')?.querySelector('script,a,img,link,iframe,object,embed,style,template,svg')).toBeNull()
    expect(dialog?.querySelector('.extension-form')?.getAttribute('action')).toBeNull()
    expect(dialog?.querySelector('.extension-form')?.getAttribute('onsubmit')).toBeNull()
    expect((window as { __formAttack?: number }).__formAttack).toBeUndefined()

    setInputValue(field('Project'), 'desktop')
    setInputValue(field('Workers'), '2.5')
    const password = field('Access token')
    expect(password.type).toBe('password')
    expect(password.autocomplete).toBe('off')
    expect(password.getAttribute('autocomplete')).toBe('off')
    setInputValue(password, 's3cr3t-renderer')

    const otherInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[aria-label="Other (type your own answer)"]'))
    expect(otherInputs).toHaveLength(1)
    setInputValue(otherInputs[0], 'custom-mode')
    const alpha = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => input.closest('label')?.textContent?.includes('Alpha'))
    if (!alpha) throw new Error('Alpha checkbox missing')
    await click(alpha)
    const otherText = Array.from(document.querySelectorAll<HTMLInputElement>('.extension-form__other input'))[0]
    setInputValue(otherText, 'gamma')
    const errors = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'log')]
    await click(submitButton())

    expect(onRespond).toHaveBeenCalledTimes(1)
    expect(onRespond).toHaveBeenCalledWith({ data: {
      project: 'desktop', workers: 2.5, token: 's3cr3t-renderer', mode: 'custom-mode', features: ['alpha', 'gamma'], hiddenEcho: 'kept',
    } })
    const argument = onRespond.mock.calls[0][0] as Record<string, unknown>
    expect(argument).not.toHaveProperty('cancelled')
    expect(argument).not.toHaveProperty('timedOut')
    for (const logger of errors) {
      expect(logger.mock.calls.flat().join(' ')).not.toContain('s3cr3t-renderer')
    }
  })

  it('keeps required empties visible with a localized reason and does not respond', async () => {
    const onRespond = vi.fn()
    await renderRequest(requestFromHtml('<label>Required name<input name="requiredName" required></label>'), onRespond, 'zh-TW')
    await click(submitButton())
    expect(onRespond).not.toHaveBeenCalled()
    const required = field('Required name')
    expect(required.value).toBe('')
    expect(required.getAttribute('aria-invalid')).toBe('true')
    expect(document.querySelector('.extension-form')?.textContent).toContain('此欄位為必填。')
  })

  it('submits an informational unnamed form as empty data and retains hidden-only values', async () => {
    const informational = vi.fn()
    await renderRequest(requestFromHtml('<h2>Information only</h2><p>No named answers are required.</p>'), informational)
    await click(submitButton())
    expect(informational).toHaveBeenCalledWith({ data: {} })

    const hidden = vi.fn()
    await renderRequest(requestFromHtml('<input type="hidden" name="trace" value="unchanged">'), hidden)
    expect(document.querySelector('.extension-form')?.querySelectorAll('input')).toHaveLength(0)
    await click(submitButton())
    expect(hidden).toHaveBeenCalledWith({ data: { trace: 'unchanged' } })
  })

  it('drops the previous secret draft when a reused request id gets a new pending object', async () => {
    const first = requestFromHtml('<label>Old token<input name="old" type="password"></label>', 'reused-id')
    await renderRequest(first)
    setInputValue(field('Old token'), 'old-secret-never-leak')
    const second = requestFromHtml('<label>New token<input name="new" type="password"></label><input type="hidden" name="version" value="second">', 'reused-id')
    await renderRequest(second)
    const current = field('New token')
    expect(current.value).toBe('')
    expect(current.value).not.toContain('old-secret-never-leak')
    expect(document.body.textContent).not.toContain('old-secret-never-leak')
  })

  it('honors only the explicit raw secret hint on ordinary input dialogs', async () => {
    const onRespond = vi.fn()
    const labelledSecret = parseExtensionUiRequest({ type: 'extension_ui_request', id: 'plain', method: 'input', title: 'Secret token' })
    if (!labelledSecret) throw new Error('plain input failed to parse')
    await renderRequest(labelledSecret, onRespond)
    const ordinary = document.querySelector<HTMLInputElement>('.extension-question__field input')
    expect(ordinary?.type).toBe('text')

    const explicit = parseExtensionUiRequest({ type: 'extension_ui_request', id: 'secret', method: 'input', title: 'Account', secret: true })
    if (!explicit) throw new Error('secret input failed to parse')
    await renderRequest(explicit, onRespond)
    const protectedInput = document.querySelector<HTMLInputElement>('.extension-question__field input')
    expect(protectedInput?.type).toBe('password')
    expect(protectedInput?.getAttribute('autocomplete')).toBe('off')
  })
})
