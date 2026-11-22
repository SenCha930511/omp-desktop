// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { createExtensionFormDraft, submitExtensionForm, type ExtensionFormControl } from '../../src/lib/extension-form'
import { parseFormHtml } from '../../src/lib/extension-form-html'

const parse = (html: string) => parseFormHtml(html, new DOMParser())
const named = (definition: { controls: readonly ExtensionFormControl[] }, name: string) => {
  const control = definition.controls.find(candidate => candidate.name === name)
  if (!control) throw new Error('missing test control')
  return control
}

describe('inert HTML projection', () => {
  it('keeps representative context, controls, constraints, source order and exact defaults', () => {
    const result = parse(`<!doctype html><p>outside</p><form>
      <p>Loose introduction</p><fieldset><legend>Service configuration</legend>
      <h2>Primary details</h2><p>Choose a deployment.</p><ul><li>Safe</li><li>Repeatable</li></ul>
      <pre>  retained\n  layout\n</pre><table><thead><tr><th>Tier</th><th>Limit</th></tr></thead><tr><td>Free</td><td>10</td></tr></table>
      <label for="title-token">Display title</label><label for="title-token">Ignored duplicate</label>
      <input id="title-token" name="title" maxlength="40" required value="Demo">
      <label>Notes<textarea name="notes" minlength="2" rows="99">\nInitial notes</textarea></label>
      <label>Replicas<input name="replicas" type="number" value="2.5" min="-1" max="5" step="2"></label>
      <label>Intensity<input name="intensity" type="range" value="0.3" min="0" max="1" step="0.2"></label>
      <div><label><input type="radio" name="mode" value="local" checked>Local</label></div>
      <section><label><input type="radio" name="mode" value="cloud" required>Cloud</label></section>
      <div><label><input type="checkbox" name="features" value="auth" checked>Auth</label></div>
      <div><label><input type="checkbox" name="features" value="logs">Logs</label></div>
      <label>Region<select name="region"><option value="disabled" disabled>Off</option><option value=" west ">West</option><option>east</option></select></label>
      <select name="tags" multiple><option selected>A</option><option value="b" selected>B</option></select>
      <input type="hidden" name="token" value="first"><input type="hidden" name="token" value="last">
      <input type="email" name="contact" pattern="[a-z@.]+" aria-label="Contact email">
      <button>Submit</button><input type="submit" name="ignored" value="no">
      </fieldset><p>after</p></form><p>outside too</p>`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const definition = result.definition
    expect(definition.sections.map(section => section.title)).toEqual(['', 'Service configuration', ''])
    expect(definition.sections[0]?.blocks[0]).toMatchObject({ text: 'Loose introduction' })
    expect(definition.sections[1]?.blocks.map(block => block.kind)).toEqual([
      'text', 'text', 'list', 'pre', 'table', 'text', 'field', 'field', 'field', 'field', 'field', 'field', 'field', 'field', 'field',
    ])
    expect(definition.sections[1]?.blocks[0]).toMatchObject({ text: 'Primary details', heading: 2 })
    expect(definition.sections[1]?.blocks[2]).toMatchObject({ kind: 'list', ordered: false, items: ['Safe', 'Repeatable'] })
    expect(definition.sections[1]?.blocks[4]).toMatchObject({ kind: 'table', headerRows: 1, rows: [['Tier', 'Limit'], ['Free', '10']] })
    expect(definition.sections[1]?.blocks[5]).toMatchObject({ text: 'Ignored duplicate' })
    expect(definition.sections[2]?.blocks[0]).toMatchObject({ text: 'after' })
    expect(named(definition, 'title')).toMatchObject({ label: 'Display title', required: true, maxLength: 40, initialValue: 'Demo' })
    expect(named(definition, 'notes')).toMatchObject({ initialValue: 'Initial notes', rows: 20, minLength: 2 })
    expect(named(definition, 'mode')).toMatchObject({ kind: 'radio', required: true, label: 'Service configuration', other: true })
    expect(named(definition, 'features')).toMatchObject({ kind: 'checkbox', other: true })
    expect(named(definition, 'region')).toMatchObject({ options: [
      { value: 'disabled', initiallyChecked: false, disabled: true },
      { value: ' west ', initiallyChecked: true },
      { value: 'east', initiallyChecked: false },
    ] })
    const submitted = submitExtensionForm(definition, createExtensionFormDraft(definition))
    expect(submitted).toMatchObject({ ok: true, data: {
      title: 'Demo', notes: 'Initial notes', replicas: 2.5, intensity: 0.3,
      mode: 'local', features: ['auth'], region: ' west ', tags: ['A', 'b'], token: 'last', contact: '',
    } })
    expect(JSON.stringify(submitted)).not.toContain('disabled')
  })

  it('defaults radios and checkboxes to on, groups by type and name without collisions, and handles fragments', () => {
    const result = parse(`<label><input type="radio" name="choice" checked> First</label><input type="radio" name="choice">
      <label><input type="checkbox" name="choice" checked> Different</label><input type="checkbox" name="other">`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const groups = result.definition.controls.filter(control => control.kind === 'radio' || control.kind === 'checkbox')
    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({ kind: 'radio', name: 'choice', options: [{ value: 'on' }, { value: 'on' }] })
    expect(groups[1]).toMatchObject({ kind: 'checkbox', name: 'choice' })
    const submitted = submitExtensionForm(result.definition, createExtensionFormDraft(result.definition))
    expect(submitted).toMatchObject({ ok: true, data: { choice: 'on' } })
  })

  it('keeps one generated group control when options are split across fieldsets and sections', () => {
    const result = parse(`<form><fieldset><legend>First</legend><label><input type="radio" name="split" value="a">A</label></fieldset>
      <fieldset><legend>Second</legend><label><input type="radio" name="split" value="b" required>B</label></fieldset></form>`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.definition.controls.filter(control => control.name === 'split')).toHaveLength(1)
    expect(named(result.definition, 'split')).toMatchObject({ required: true, options: [{ value: 'a' }, { value: 'b' }] })
    expect(result.definition.sections[1]?.title).toBe('Second')
    expect(result.definition.sections[1]?.blocks.some(block => block.kind === 'field')).toBe(false)
  })

  it('uses only literal source labels to decide whether generated Other exists', () => {
    for (const label of ['Other plans', 'other', 'Other (type your own)', '  OTHER things']) {
      const result = parse(`<input type="hidden" name="keep" value="1"><label><input type="radio" name="r" value="x">${label}</label><label><input type="radio" name="r" value="y">Second</label>`)
      expect(result.ok).toBe(true)
      if (result.ok) expect(named(result.definition, 'r')).toMatchObject({ other: false })
    }
    const emptyValue = parse(`<input type="radio" name="Other generated" value=""><input type="radio" name="Other generated" value="second">`)
    expect(emptyValue.ok).toBe(true)
    if (emptyValue.ok) expect(named(emptyValue.definition, 'Other generated')).toMatchObject({ other: true, options: [{ label: '' }, { label: 'second' }] })
    const fallback = parse(`<input type="hidden" name="keep" value="1"><label><input type="radio" name="r" value="Other fallback"></label><label><input type="radio" name="r" value="y"></label><select name="s"><option>Other plans</option><option>x</option></select>`)
    expect(fallback.ok).toBe(true)
    if (fallback.ok) {
      expect(named(fallback.definition, 'r')).toMatchObject({ other: false })
      expect(named(fallback.definition, 's')).not.toHaveProperty('other')
    }
  })

  it('drops executable/resource containers and their content, ignores URLs and handlers, and retains passive safe text', () => {
    const secret = 'never-copy-this-script'
    const result = parse(`<form onsubmit="globalThis.compromised=true"><script>${secret}</script><style>.x{content:'style-secret'}</style>
      <iframe srcdoc="<p>frame-secret</p>">frame-secret</iframe><object>object-secret</object><embed src="https://bad.test"><template><p>template-secret</p></template>
      <a href="javascript:globalThis.compromised=true" onclick="globalThis.compromised=true"><b>Safe bold</b><i> and italic</i></a>
      <img src="https://bad.test/image" onerror="globalThis.compromised=true" alt="Picture name">
      <svg onload="globalThis.compromised=true" aria-label="Chart title"><script>svg-secret</script><rect></rect></svg>
      <input name="safe" value="ok" onfocus="globalThis.compromised=true" formaction="https://bad.test">
      <select name="safeSelect"><option>Visible<script>option-secret</script></option></select>
      <date-widget>Unknown wrapper text</date-widget><input type="mystery" name="unknown" value="text"></form>`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const serialized = JSON.stringify(result.definition)
    for (const forbidden of [secret, 'style-secret', 'frame-secret', 'object-secret', 'template-secret', 'svg-secret', 'option-secret', 'javascript:', 'bad.test', 'onsubmit', 'onerror', 'formaction']) expect(serialized).not.toContain(forbidden)
    expect(serialized).toContain('Safe bold and italic')
    expect(serialized).toContain('Picture name')
    expect(serialized).toContain('Chart title')
    expect(serialized).toContain('Unknown wrapper text')
    expect(named(result.definition, 'unknown')).toMatchObject({ kind: 'text', inputType: 'text', initialValue: 'text' })
    expect(named(result.definition, 'safeSelect')).toMatchObject({ options: [{ label: 'Visible', value: 'Visible' }] })
    expect(serialized).not.toMatch(/"href"|"src"|"html"|"markup"/)
  })

  it('retains informational forms without named controls and hidden-only submissions', () => {
    const informational = parse(`<form><p>Read this before continuing.</p><button formaction="https://bad.test" onclick="globalThis.compromised=true">Ignored action</button><input type="file" name="upload"></form>`)
    expect(informational.ok).toBe(true)
    if (informational.ok) {
      expect(informational.definition.controls).toEqual([])
      expect(informational.definition.sections[0]?.blocks).toContainEqual({ kind: 'text', text: 'Read this before continuing.' })
      expect(JSON.stringify(informational.definition)).not.toMatch(/Ignored action|bad\.test|onclick|formaction/)
      expect(submitExtensionForm(informational.definition, createExtensionFormDraft(informational.definition))).toMatchObject({ ok: true, data: {} })
    }
    const hiddenOnly = parse(`<form><input type="hidden" name="token" value="first"><input type="hidden" name="token" value="last"></form>`)
    expect(hiddenOnly.ok).toBe(true)
    if (hiddenOnly.ok) expect(submitExtensionForm(hiddenOnly.definition, createExtensionFormDraft(hiddenOnly.definition))).toMatchObject({ ok: true, data: { token: 'last' } })
  })

  it('bounds labels and limits controls/options per group with value-free reasons', () => {
    const tooLong = 'secret-value-' + 'x'.repeat(1_048_576)
    expect(parse(`<form><input name="secret" value="${tooLong}"></form>`)).toEqual({ ok: false, reason: 'htmlTooLarge' })
    const longName = 'n'.repeat(1025)
    expect(parse(`<form><input name="${longName}" value="classified"></form>`)).toEqual({ ok: false, reason: 'nameTooLong' })
    const options = Array.from({ length: 513 }, (_, index) => `<option>${index}</option>`).join('')
    expect(parse(`<form><select name="items">${options}</select></form>`)).toEqual({ ok: false, reason: 'tooManyOptions' })
    const controls = Array.from({ length: 129 }, (_, index) => `<input name="n${index}">`).join('')
    expect(parse(`<form>${controls}</form>`)).toEqual({ ok: false, reason: 'tooManyControls' })
  })

  it('parses once inside a contained boundary and converts parser failures to safe reasons', () => {
    const parseFromString = vi.fn(() => { throw new Error('sensitive parser diagnostic') })
    expect(parseFormHtml('<form><input name="x" value="secret"></form>', { parseFromString } as unknown as Pick<DOMParser, 'parseFromString'>)).toEqual({ ok: false, reason: 'unreadableDocument' })
    expect(parseFromString).toHaveBeenCalledOnce()
    const spy = vi.spyOn(DOMParser.prototype, 'parseFromString')
    parse('<form><input name="x"></form>')
    expect(spy).toHaveBeenCalledOnce()
    spy.mockRestore()
  })
})
