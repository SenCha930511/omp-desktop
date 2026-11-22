import { describe, expect, it } from 'vitest'
import { MAX_EXTENSION_FORM_CHOICE_CHARS, MAX_EXTENSION_FORM_TEXT_CHARS } from '../../src/types/api'
import {
  createExtensionFormDraft,
  submitExtensionForm,
  validateExtensionFormData,
  type ExtensionFormChoiceControl,
  type ExtensionFormControl,
  type ExtensionFormDefinition,
  type ExtensionFormDraftValue,
} from '../../src/lib/extension-form'

let sequence = 0
const id = (): string => `c${++sequence}`
const hidden = (name: string, value: string): ExtensionFormControl => ({ kind: 'hidden', id: id(), name, value })
const text = (name: string, extra: Partial<Extract<ExtensionFormControl, { kind: 'text' }>> = {}): ExtensionFormControl => ({
  kind: 'text', id: id(), name, label: name, inputType: 'text', initialValue: '', placeholder: '', required: false, ...extra,
})
const numeric = (name: string, extra: Partial<Extract<ExtensionFormControl, { kind: 'number' }>> = {}): ExtensionFormControl => ({
  kind: 'number', id: id(), name, label: name, presentation: 'number', initialValue: '', placeholder: '', required: false, ...extra,
})
const choice = (kind: 'radio' | 'checkbox', name: string, values: readonly (string | { value: string; disabled?: boolean; checked?: boolean; label?: string })[], extra: { required?: boolean; other?: boolean } = {}): ExtensionFormChoiceControl => ({
  kind, id: id(), name, label: name, required: extra.required ?? false, other: extra.other ?? false,
  options: values.map(value => {
    const option = typeof value === 'string' ? { value } : value
    return { id: id(), value: option.value, label: option.label ?? option.value, disabled: option.disabled ?? false, initiallyChecked: option.checked ?? false }
  }),
})
const select = (name: string, values: readonly (string | { value: string; disabled?: boolean; checked?: boolean })[], multiple = false): ExtensionFormChoiceControl => ({
  kind: 'select', id: id(), name, label: name, required: false, multiple,
  options: values.map(value => {
    const option = typeof value === 'string' ? { value } : value
    return { id: id(), value: option.value, label: option.value, disabled: option.disabled ?? false, initiallyChecked: option.checked ?? false }
  }),
})
const form = (...controls: ExtensionFormControl[]): ExtensionFormDefinition => ({ sections: [], controls })
const dataOf = (input: unknown) => {
  const result = validateExtensionFormData(form(), input)
  return result
}

describe('draft defaults and cardinality', () => {
  it('uses generated ids, preserves checked defaults, and returns scalar or array values by source option count', () => {
    const lone = choice('checkbox', 'lone', [{ value: 'yes', checked: true }])
    const boxes = choice('checkbox', 'boxes', ['a', { value: 'b', checked: true }])
    const radios = choice('radio', 'radio', ['a', 'b'])
    const multiple = select('multi', ['a'], true)
    const single = select('single', [{ value: 'off', disabled: true }, { value: 'first', checked: true }])
    const definition = form(lone, boxes, radios, multiple, single)
    const draft = createExtensionFormDraft(definition)
    expect(Object.getPrototypeOf(draft)).toBeNull()
    expect(draft[lone.id]).toMatchObject({ kind: 'multi-choice', selected: [lone.options[0]?.id] })
    expect(draft[boxes.id]).toMatchObject({ selected: [boxes.options[1]?.id] })
    const submitted = submitExtensionForm(definition, draft)
    expect(submitted).toMatchObject({ ok: true, data: { lone: 'yes', boxes: ['b'], single: 'first' } })
    expect(submitted.ok && Object.hasOwn(submitted.data, 'multi')).toBe(false)
    expect(submitted.ok && submitted.data.radio).toBeUndefined()
    const disabled = choice('checkbox', 'disabled', [{ value: 'x', checked: true, disabled: true }])
    const disabledDefinition = form(disabled)
    expect(createExtensionFormDraft(disabledDefinition)[disabled.id]).toMatchObject({ selected: [] })
    expect(submitExtensionForm(disabledDefinition, createExtensionFormDraft(disabledDefinition))).toMatchObject({ ok: true, data: {} })
  })

  it('keeps numeric empties as strings, converts finite fractions/scientific notation, and does not enforce a step', () => {
    const empty = numeric('empty')
    const emptyRange = numeric('emptyRange', { presentation: 'range' })
    const range = numeric('range', { presentation: 'range', initialValue: '-1.25', min: -2, max: 4 })
    const exponent = numeric('exponent', { initialValue: '1e2' })
    const definition = form(empty, emptyRange, range, exponent)
    const result = submitExtensionForm(definition, createExtensionFormDraft(definition))
    expect(result).toMatchObject({ ok: true, data: { empty: '', emptyRange: '', range: -1.25, exponent: 100 } })
    const bad = numeric('bad', { initialValue: 'Infinity' })
    const badDefinition = form(bad)
    expect(submitExtensionForm(badDefinition, createExtensionFormDraft(badDefinition)).ok).toBe(false)
  })
})

describe('hidden echo and one-entry response semantics', () => {
  it('keeps hidden-only values, lets valid choices override them, and uses the last hidden declaration', () => {
    const group = choice('radio', 'mode', ['native', 'cloud'])
    const definition = form(hidden('mode', 'stale'), hidden('mode', 'native'), group)
    expect(submitExtensionForm(definition, createExtensionFormDraft(definition))).toMatchObject({ ok: true, data: { mode: 'native' } })
    expect(validateExtensionFormData(definition, { mode: 'cloud' })).toMatchObject({ ok: true, data: { mode: 'cloud' } })
    const empty = choice('checkbox', 'items', ['a', 'b'])
    expect(validateExtensionFormData(form(hidden('items', 'h'), empty), { items: [] })).toMatchObject({ ok: true, data: { items: [] } })
  })

  it('uses a matching enabled hidden echo as a selection, including for required groups', () => {
    const group = choice('radio', 'mode', ['native', 'cloud'], { required: true })
    expect(validateExtensionFormData(form(hidden('mode', 'native'), group), { mode: 'native' })).toMatchObject({ ok: true, data: { mode: 'native' } })
  })

  it('turns an otherwise invalid scalar echo into unanswered instead of satisfying required', () => {
    const group = choice('radio', 'mode', ['native', 'cloud'], { required: true })
    const accepted = validateExtensionFormData(form(hidden('mode', 'stale'), group), { mode: 'stale' })
    expect(accepted).toMatchObject({ ok: false, issues: [{ code: 'required', controlId: group.id }] })
    const optional = choice('radio', 'mode', ['native'])
    expect(validateExtensionFormData(form(hidden('mode', 'stale'), optional), { mode: 'stale' })).toMatchObject({ ok: true, data: { mode: 'stale' } })
  })

  it('removes one array echo when no option carries it, but first tries a valid original array', () => {
    const group = choice('checkbox', 'items', ['h', 'b'], { other: true })
    expect(validateExtensionFormData(form(hidden('items', 'h'), group), { items: ['h', 'b'] })).toMatchObject({ ok: true, data: { items: ['h', 'b'] } })
    const without = choice('checkbox', 'items', ['a', 'b'], { other: true })
    expect(validateExtensionFormData(form(hidden('items', 'h'), without), { items: ['h', 'custom'] })).toMatchObject({ ok: true, data: { items: ['custom'] } })
  })

  it('removes an array echo only as fallback when the original is invalid, without removing arbitrary entries', () => {
    const group = choice('checkbox', 'items', ['h', 'h'])
    expect(validateExtensionFormData(form(hidden('items', 'h'), group), { items: ['h', 'h'] })).toMatchObject({ ok: true, data: { items: ['h'] } })
    expect(validateExtensionFormData(form(hidden('items', 'h'), group), { items: ['h', 'bad'] })).toMatchObject({ ok: false, issues: [{ code: 'unexpectedChoice' }] })
    expect(validateExtensionFormData(form(hidden('items', 'h'), group), { items: ['h', 'bad', 'extra'] })).toMatchObject({ ok: false })
  })
})

describe('Other, enabled choices and duplicate handling', () => {
  it('trims one Other, replaces radio scalar, appends checkbox entries, and drops unchecked blank Other', () => {
    const radio = choice('radio', 'r', ['a', 'b'], { other: true })
    const boxes = choice('checkbox', 'c', ['a', 'b'], { other: true })
    const definition = form(radio, boxes)
    const draft = createExtensionFormDraft(definition)
    const result = submitExtensionForm(definition, {
      ...draft,
      [radio.id]: { kind: 'single-choice', other: '  custom  ' },
      [boxes.id]: { kind: 'multi-choice', selected: [boxes.options[0]?.id ?? ''], other: ' extra ' },
    })
    expect(result).toMatchObject({ ok: true, data: { r: 'custom', c: ['a', 'extra'] } })
    expect(validateExtensionFormData(definition, { r: '   ', c: [] })).toMatchObject({ ok: true, data: { c: [] } })
  })

  it('rejects a second unmatched string, duplicate option entries, and disabled values', () => {
    const other = choice('checkbox', 'items', ['a', 'b'], { other: true })
    expect(validateExtensionFormData(form(other), { items: ['one', 'two'] })).toMatchObject({ ok: false, issues: [{ code: 'unexpectedChoice' }] })
    expect(validateExtensionFormData(form(other), { items: ['a', 'a'] })).toMatchObject({ ok: false, issues: [{ code: 'duplicateChoice' }] })
    const disabled = choice('radio', 'r', [{ value: 'x', disabled: true }])
    expect(validateExtensionFormData(form(disabled), { r: 'x' })).toMatchObject({ ok: false, issues: [{ code: 'disabledOption' }] })
  })

  it('prefers an enabled duplicate over a disabled duplicate and rejects two selected controls resolving to one option', () => {
    const collision = choice('checkbox', 'items', [{ value: 'same', disabled: true }, 'same', 'same'])
    expect(validateExtensionFormData(form(collision), { items: ['same'] })).toMatchObject({ ok: true, data: { items: ['same'] } })
    expect(validateExtensionFormData(form(collision), { items: ['same', 'same'] })).toMatchObject({ ok: false, issues: [{ code: 'duplicateChoice' }] })
    const otherCollision = choice('checkbox', 'items', ['a', 'b'], { other: true })
    expect(validateExtensionFormData(form(otherCollision), { items: ['a', 'b', 'a'] })).toMatchObject({ ok: false, issues: [{ code: 'duplicateChoice' }] })
  })

  it('distinguishes scalar and array shape for singleton groups and singleton multi-selects', () => {
    const loneBox = choice('checkbox', 'box', ['yes'])
    const boxes = choice('checkbox', 'boxes', ['a', 'b'])
    const multi = select('multi', ['one'], true)
    expect(validateExtensionFormData(form(loneBox), { box: [] })).toMatchObject({ ok: false, issues: [{ code: 'wrongShape' }] })
    expect(validateExtensionFormData(form(boxes), { boxes: 'a' })).toMatchObject({ ok: false, issues: [{ code: 'wrongShape' }] })
    expect(validateExtensionFormData(form(multi), { multi: [] })).toMatchObject({ ok: false, issues: [{ code: 'wrongShape' }] })
    expect(validateExtensionFormData(form(multi), {})).toMatchObject({ ok: true, data: {} })
  })
})

describe('repeated names and mixed carriers', () => {
  it('evaluates every eligible control, answers incompatible controls as unanswered, and keeps the last carried result', () => {
    const firstText = text('shared')
    const radio = choice('radio', 'shared', ['a', 'b'], { other: true })
    const lastText = text('shared')
    const definition = form(firstText, radio, lastText)
    expect(validateExtensionFormData(definition, { shared: 'custom' })).toMatchObject({ ok: true, data: { shared: 'custom' } })
    expect(validateExtensionFormData(definition, { shared: 'a' })).toMatchObject({ ok: true, data: { shared: 'a' } })
    const requiredBoxes = choice('checkbox', 'shared', ['a', 'b'], { required: true })
    const result = validateExtensionFormData(form(requiredBoxes, radio), { shared: 'a' })
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'required', controlId: requiredBoxes.id }] })
  })

  it('does not let one text carrier silently legitimize a malformed choice for a lone name', () => {
    const radio = choice('radio', 'shared', ['a'])
    expect(validateExtensionFormData(form(radio), { shared: ['a'] })).toMatchObject({ ok: false, issues: [{ code: 'wrongShape' }] })
    const required = choice('checkbox', 'shared', ['a', 'b'], { required: true })
    const free = text('shared')
    expect(validateExtensionFormData(form(required, free), { shared: ['a'] })).toMatchObject({ ok: true, data: { shared: ['a'] } })
    expect(validateExtensionFormData(form(required, free), { shared: 'free text' })).toMatchObject({ ok: false, issues: [{ code: 'required' }] })
    const radioNoOther = choice('radio', 'none', ['a'])
    expect(validateExtensionFormData(form(radioNoOther, choice('checkbox', 'none', ['a', 'b'])), { none: 'custom' })).toMatchObject({ ok: false })
  })

  it('reports the first mismatch when no same-name control can carry an entry', () => {
    const firstChoice = choice('checkbox', 'shared', ['a', 'b'])
    expect(validateExtensionFormData(form(firstChoice, numeric('shared')), { shared: ['unknown'] })).toMatchObject({
      ok: false,
      issues: [{ code: 'unexpectedChoice', controlId: firstChoice.id }],
    })
  })

  it('lets the last carried compatible field determine string-versus-number normalization', () => {
    const numberFirst = numeric('shared')
    const textLast = text('shared')
    expect(validateExtensionFormData(form(numberFirst, textLast), { shared: '2.50' })).toMatchObject({ ok: true, data: { shared: '2.50' } })
    expect(validateExtensionFormData(form(numberFirst, textLast), { shared: 2.5 })).toMatchObject({ ok: true, data: { shared: 2.5 } })
    const textFirst = text('other')
    const numberLast = numeric('other')
    expect(validateExtensionFormData(form(textFirst, numberLast), { other: '2.50' })).toMatchObject({ ok: true, data: { other: 2.5 } })
  })
})

describe('constraints, hostile data and special keys', () => {
  it('enforces required, numeric limits, UTF-16 lengths, email, url and anchored patterns in upstream order', () => {
    const required = text('required', { required: true })
    const count = numeric('count', { min: -2, max: 4 })
    const length = text('length', { minLength: 2, maxLength: 2 })
    const email = text('email', { inputType: 'email' })
    const url = text('url', { inputType: 'url' })
    const pattern = text('pattern', { pattern: '[a-z]+' })
    const definition = form(required, count, length, email, url, pattern)
    expect(validateExtensionFormData(definition, { required: ' secret ', count: -1.5, length: '😀', email: 'user@example.', url: 'https://example.com/a', pattern: 'abc' }).ok).toBe(true)
    expect(validateExtensionFormData(definition, { required: '  ', count: 0, length: '😀', email: 'a@b', url: 'https://x.test', pattern: 'abc' })).toMatchObject({ ok: false, issues: [{ code: 'required' }] })
    expect(validateExtensionFormData(definition, { required: 'ok', count: 5, length: '😀', email: 'a@b', url: 'https://x.test', pattern: 'abc' })).toMatchObject({ ok: false, issues: [{ code: 'max', limit: 4 }] })
    expect(validateExtensionFormData(definition, { required: 'ok', count: 0, length: 'ab', email: 'a@b', url: 'https://x.test', pattern: 'abc1' })).toMatchObject({ ok: false, issues: [{ code: 'pattern' }] })
    const optional = numeric('optional', { min: 100, pattern: '[' })
    expect(validateExtensionFormData(form(optional), { optional: '   ' })).toMatchObject({ ok: true, data: { optional: '   ' } })
    const invalidPattern = text('invalidPattern', { pattern: '[' })
    expect(validateExtensionFormData(form(invalidPattern), { invalidPattern: 'anything' })).toMatchObject({ ok: true, data: { invalidPattern: 'anything' } })
  })

  it('enforces array-entry limits after Other normalization while retaining scalar bounds', () => {
    const exactChoiceLength = 'x'.repeat(MAX_EXTENSION_FORM_CHOICE_CHARS)
    const oversizedChoice = `${exactChoiceLength}x`
    const multi = choice('checkbox', 'features', [exactChoiceLength, oversizedChoice])
    expect(validateExtensionFormData(form(multi), { features: [exactChoiceLength] })).toMatchObject({ ok: true, data: { features: [exactChoiceLength] } })
    expect(validateExtensionFormData(form(multi), { features: [oversizedChoice] })).toMatchObject({ ok: false, issues: [{ code: 'malformedForm', controlId: multi.id }] })

    const otherMulti = choice('checkbox', 'features', ['a', 'b'], { other: true })
    expect(validateExtensionFormData(form(otherMulti), { features: [oversizedChoice] })).toMatchObject({ ok: false, issues: [{ code: 'malformedForm', controlId: otherMulti.id }] })
    expect(validateExtensionFormData(form(otherMulti), { features: [`${' '.repeat(MAX_EXTENSION_FORM_CHOICE_CHARS + 1)}custom`] })).toMatchObject({ ok: true, data: { features: ['custom'] } })

    const scalar = 'x'.repeat(MAX_EXTENSION_FORM_TEXT_CHARS)
    const radio = choice('radio', 'mode', ['fast', 'slow'], { other: true })
    expect(validateExtensionFormData(form(radio), { mode: scalar }).ok).toBe(true)
    const singleton = choice('checkbox', 'feature', [scalar])
    expect(validateExtensionFormData(form(singleton), { feature: scalar }).ok).toBe(true)
  })

  it('rejects unknown names, wrong container shapes, sparse arrays, non-string array entries and non-finite values without echoing secrets', () => {
    const field = text('token')
    const sparseText = [undefined, 'x']
    delete sparseText[0]
    expect(Object.hasOwn(sparseText, 0)).toBe(false)
    for (const submitted of [null, [], 3, { unknown: 'classified' }, { token: true }, { token: Infinity }, { token: NaN }, { token: ['x'] }, { token: sparseText }]) {
      const result = validateExtensionFormData(form(field), submitted)
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain('classified')
    }
    const boxes = choice('checkbox', 'items', ['a', 'b'])
    const sparseItems = ['a', undefined, 'a']
    delete sparseItems[1]
    expect(Object.hasOwn(sparseItems, 1)).toBe(false)
    expect(validateExtensionFormData(form(boxes), { items: ['a', 3] })).toMatchObject({ ok: false, issues: [{ code: 'malformedForm' }] })
    expect(validateExtensionFormData(form(boxes), { items: sparseItems })).toMatchObject({ ok: false, issues: [{ code: 'malformedForm' }] })
    expect(validateExtensionFormData(form(boxes), { [`x`.repeat(1025)]: 'unreported' })).toMatchObject({ ok: false, issues: [{ code: 'malformedForm' }] })
    expect(Array.from({ length: 514 }, () => 'x').length).toBe(514)
    expect(validateExtensionFormData(form(boxes), { items: Array.from({ length: 514 }, () => 'x') })).toMatchObject({ ok: false, issues: [{ code: 'malformedForm' }] })
    expect(dataOf({}).ok).toBe(true)
  })

  it('treats prototype-property and Unicode names as ordinary keys and round-trips normalized JSON safely', () => {
    const proto = text('__proto__')
    const ctor = text('constructor')
    const unicode = text('部署 .[名]')
    const definition = form(hidden('__proto__', 'hidden'), proto, ctor, unicode)
    const result = validateExtensionFormData(definition, JSON.parse('{"__proto__":"safe","constructor":"ctor","部署 .[名]":"值"}'))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.getPrototypeOf(result.data)).toBeNull()
      expect(Object.hasOwn(result.data, '__proto__')).toBe(true)
      expect({}.toString).toBeTypeOf('function')
      expect(JSON.parse(JSON.stringify(result.data))).toEqual(JSON.parse('{"__proto__":"safe","constructor":"ctor","部署 .[名]":"值"}'))
    }
  })

  it('rejects draft references to nonexistent option ids rather than manufacturing values', () => {
    const group = choice('checkbox', 'items', ['a', 'b'])
    const draft: Record<string, ExtensionFormDraftValue> = { [group.id]: { kind: 'multi-choice', selected: ['foreign'], other: '' } }
    expect(submitExtensionForm(form(group), draft)).toMatchObject({ ok: false, issues: [{ code: 'selection' }] })
    const optionId = group.options[0]?.id ?? ''
    expect(submitExtensionForm(form(group), { [group.id]: { kind: 'multi-choice', selected: [optionId, optionId], other: '' } })).toMatchObject({ ok: false, issues: [{ code: 'duplicateChoice' }] })
  })
})
