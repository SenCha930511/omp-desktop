export type ExtensionFormValue = string | number | string[]
export type ExtensionFormData = Record<string, ExtensionFormValue>
export type FormControlId = string
export type FormOptionId = string

export interface ExtensionFormDefinition {
  readonly sections: readonly ExtensionFormSection[]
  readonly controls: readonly ExtensionFormControl[]
}

export interface ExtensionFormSection {
  readonly title: string
  readonly blocks: readonly ExtensionFormBlock[]
}

export type ExtensionFormBlock =
  | { readonly kind: 'text'; readonly text: string; readonly heading?: 1 | 2 | 3 | 4 | 5 | 6 }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly string[] }
  | { readonly kind: 'pre'; readonly text: string }
  | { readonly kind: 'table'; readonly headerRows: number; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'field'; readonly controlId: FormControlId }

interface NamedControl {
  readonly id: FormControlId
  readonly name: string
  readonly label: string
}

export interface ExtensionFormOption {
  readonly id: FormOptionId
  readonly value: string
  readonly label: string
  readonly initiallyChecked: boolean
  readonly disabled: boolean
}

interface ChoiceBase extends NamedControl {
  readonly required: boolean
  readonly options: readonly ExtensionFormOption[]
}

export type ExtensionFormChoiceControl =
  | (ChoiceBase & { readonly kind: 'radio'; readonly other: boolean })
  | (ChoiceBase & { readonly kind: 'checkbox'; readonly other: boolean })
  | (ChoiceBase & { readonly kind: 'select'; readonly multiple: boolean })

interface TextRules {
  readonly minLength?: number
  readonly maxLength?: number
  readonly pattern?: string
}

export type ExtensionFormTextType =
  | 'text' | 'search' | 'tel' | 'email' | 'url' | 'password' | 'date'
  | 'datetime-local' | 'month' | 'week' | 'time' | 'color'

export type ExtensionFormControl =
  | { readonly kind: 'hidden'; readonly id: FormControlId; readonly name: string; readonly value: string }
  | ExtensionFormChoiceControl
  | (NamedControl & TextRules & {
      readonly kind: 'text'
      readonly inputType: ExtensionFormTextType
      readonly initialValue: string
      readonly placeholder: string
      readonly required: boolean
    })
  | (NamedControl & TextRules & {
      readonly kind: 'number'
      readonly presentation: 'number' | 'range'
      readonly initialValue: string
      readonly placeholder: string
      readonly required: boolean
      readonly min?: number
      readonly max?: number
    })
  | (NamedControl & TextRules & {
      readonly kind: 'textarea'
      readonly initialValue: string
      readonly placeholder: string
      readonly required: boolean
      readonly rows: number
    })

export type ExtensionFormDraftValue =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'single-choice'; readonly selected?: FormOptionId; readonly other: string }
  | { readonly kind: 'multi-choice'; readonly selected: readonly FormOptionId[]; readonly other: string }

export type ExtensionFormDraft = Readonly<Record<FormControlId, ExtensionFormDraftValue>>

export interface ExtensionFormViolation {
  readonly controlId?: FormControlId
  readonly code:
    | 'malformedForm' | 'unknownName' | 'wrongShape' | 'disabledOption'
    | 'duplicateChoice' | 'unexpectedChoice' | 'required' | 'number' | 'min' | 'max'
    | 'minLength' | 'maxLength' | 'email' | 'url' | 'pattern' | 'selection'
  readonly limit?: number
  readonly field?: string
}

export type ExtensionFormDataResult =
  | { readonly ok: true; readonly data: ExtensionFormData }
  | { readonly ok: false; readonly issues: readonly ExtensionFormViolation[] }

const MAX_NAMES = 512
const MAX_ARRAY_ENTRIES = 513
const MAX_SCALAR = 1_048_576

function emptyData(): ExtensionFormData {
  return Object.create(null) as ExtensionFormData
}

function failure(code: ExtensionFormViolation['code'], controlId?: string, limit?: number, field?: string): ExtensionFormDataResult {
  return { ok: false, issues: [{ code, controlId, limit, field }] }
}

function isArrayChoice(control: ExtensionFormChoiceControl): boolean {
  return control.kind === 'checkbox' ? control.options.length > 1 : control.kind === 'select' && control.multiple && control.options.length > 1
}

function choiceValue(control: ExtensionFormChoiceControl, checked: ReadonlySet<number>, other?: string): ExtensionFormValue | undefined {
  const typed = control.kind !== 'select' && control.other ? other?.trim() : undefined
  const values = control.options.flatMap((option, index) => checked.has(index) && !option.disabled ? [option.value] : [])
  if (isArrayChoice(control)) return typed ? [...values, typed] : values
  return typed || values[0]
}

function textValue(control: Extract<ExtensionFormControl, { kind: 'text' | 'number' | 'textarea' }>, text: string): ExtensionFormValue {
  if (control.kind === 'number' && text.trim() !== '') {
    const numeric = Number(text)
    if (Number.isFinite(numeric)) return numeric
  }
  return text
}

export function createExtensionFormDraft(definition: ExtensionFormDefinition): ExtensionFormDraft {
  const draft: Record<FormControlId, ExtensionFormDraftValue> = Object.create(null) as Record<FormControlId, ExtensionFormDraftValue>
  for (const control of definition.controls) {
    if (control.kind === 'hidden') continue
    if (control.kind === 'text' || control.kind === 'number' || control.kind === 'textarea') {
      draft[control.id] = { kind: 'text', value: control.initialValue }
    } else if (control.kind === 'radio' || control.kind === 'select' && !control.multiple) {
      const selected = control.options.find(option => option.initiallyChecked && !option.disabled)
      draft[control.id] = { kind: 'single-choice', selected: selected?.id, other: '' }
    } else {
      draft[control.id] = {
        kind: 'multi-choice',
        selected: control.options.filter(option => option.initiallyChecked && !option.disabled).map(option => option.id),
        other: '',
      }
    }
  }
  return draft
}

export function submitExtensionForm(definition: ExtensionFormDefinition, draft: ExtensionFormDraft): ExtensionFormDataResult {
  const proposed = emptyData()
  for (const control of definition.controls) {
    if (control.kind === 'hidden' && control.name) proposed[control.name] = control.value
  }
  for (const control of definition.controls) {
    if (control.kind === 'hidden' || !control.name) continue
    const entry = Object.hasOwn(draft, control.id) ? draft[control.id] : undefined
    let value: ExtensionFormValue | undefined
    if (control.kind === 'text' || control.kind === 'number' || control.kind === 'textarea') {
      if (entry?.kind !== 'text' && entry !== undefined) return failure('selection', control.id)
      value = textValue(control, entry?.kind === 'text' ? entry.value : '')
    } else {
      const allowOther = control.kind !== 'select' && control.other
      const other = allowOther && (entry?.kind === 'single-choice' || entry?.kind === 'multi-choice') ? entry.other : undefined
      if (control.kind === 'radio' || control.kind === 'select' && !control.multiple) {
        if (entry?.kind !== 'single-choice' && entry !== undefined) return failure('selection', control.id)
        const selectedId = entry?.kind === 'single-choice' ? entry.selected : undefined
        const index = selectedId === undefined ? -1 : control.options.findIndex(option => option.id === selectedId)
        if (selectedId !== undefined && index < 0) return failure('selection', control.id)
        value = choiceValue(control, new Set(index < 0 ? [] : [index]), other)
      } else {
        if (entry?.kind !== 'multi-choice' && entry !== undefined) return failure('selection', control.id)
        const checked = new Set<number>()
        if (entry?.kind === 'multi-choice') {
          for (const selectedId of entry.selected) {
            const index = control.options.findIndex(option => option.id === selectedId)
            if (index < 0) return failure('selection', control.id)
            if (checked.has(index)) return failure('duplicateChoice', control.id)
            checked.add(index)
          }
        }
        value = choiceValue(control, checked, other)
      }
    }
    if (value !== undefined) proposed[control.name] = value
  }
  return validateExtensionFormData(definition, proposed)
}

type Carrier = { readonly ok: true; readonly value: ExtensionFormValue | undefined } | { readonly ok: false; readonly code: ExtensionFormViolation['code'] }

function parseChoice(control: ExtensionFormChoiceControl, value: unknown): Carrier {
  const array = isArrayChoice(control)
  if (value === undefined) return { ok: true, value: choiceValue(control, new Set()) }
  if (array !== Array.isArray(value)) return { ok: false, code: 'wrongShape' }
  const entries: readonly unknown[] = Array.isArray(value) ? value : [value]
  const checked = new Set<number>()
  let other: string | undefined
  for (const entry of entries) {
    if (typeof entry !== 'string') return { ok: false, code: 'wrongShape' }
    const enabled = control.options.findIndex(option => !option.disabled && option.value === entry)
    const index = enabled >= 0 ? enabled : control.options.findIndex(option => option.value === entry)
    if (index >= 0 && control.options[index]?.disabled) return { ok: false, code: 'disabledOption' }
    if (index >= 0 && !checked.has(index)) checked.add(index)
    else if (index < 0 && control.kind !== 'select' && control.other && other === undefined) other = entry
    else return { ok: false, code: index >= 0 ? 'duplicateChoice' : 'unexpectedChoice' }
  }
  return { ok: true, value: choiceValue(control, checked, other) }
}

function parseChoiceOrHidden(control: ExtensionFormChoiceControl, value: unknown, hidden: string | undefined): Carrier {
  if (hidden === undefined) return parseChoice(control, value)
  const echo = Array.isArray(value) ? value.indexOf(hidden) : value === hidden ? 0 : -1
  if (echo < 0) return parseChoice(control, value)
  const without: unknown = Array.isArray(value) ? value.filter((_, index) => index !== echo) : undefined
  if (Array.isArray(value) && !control.options.some(option => option.value === hidden)) return parseChoice(control, without)
  const original = parseChoice(control, value)
  return original.ok ? original : parseChoice(control, without)
}

function parseText(control: Extract<ExtensionFormControl, { kind: 'text' | 'number' | 'textarea' }>, value: unknown): Carrier {
  if (value === undefined) return { ok: true, value: textValue(control, '') }
  const numeric = control.kind === 'number'
  if (typeof value === 'string' || numeric && typeof value === 'number' && Number.isFinite(value)) {
    return { ok: true, value: textValue(control, String(value)) }
  }
  return { ok: false, code: 'wrongShape' }
}

function constraintError(control: Exclude<ExtensionFormControl, { kind: 'hidden' }>, value: ExtensionFormValue | undefined): ExtensionFormViolation | undefined {
  if (control.kind === 'radio' || control.kind === 'checkbox' || control.kind === 'select') {
    const empty = value === undefined || Array.isArray(value) && value.length === 0
    return control.required && empty ? { controlId: control.id, code: 'required' } : undefined
  }
  const text = value === undefined ? '' : String(value)
  if (text.trim() === '') return control.required ? { controlId: control.id, code: 'required' } : undefined
  if (control.kind === 'number') {
    const numeric = Number(text)
    if (!Number.isFinite(numeric)) return { controlId: control.id, code: 'number' }
    if (control.min !== undefined && numeric < control.min) return { controlId: control.id, code: 'min', limit: control.min }
    if (control.max !== undefined && numeric > control.max) return { controlId: control.id, code: 'max', limit: control.max }
  }
  if (control.minLength !== undefined && text.length < control.minLength) return { controlId: control.id, code: 'minLength', limit: control.minLength }
  if (control.maxLength !== undefined && text.length > control.maxLength) return { controlId: control.id, code: 'maxLength', limit: control.maxLength }
  if (control.kind === 'text' && control.inputType === 'email' && !/^[^\s@]+@[^\s@]+$/.test(text)) return { controlId: control.id, code: 'email' }
  if (control.kind === 'text' && control.inputType === 'url' && !URL.canParse(text)) return { controlId: control.id, code: 'url' }
  if (control.pattern) {
    try {
      if (!new RegExp(`^(?:${control.pattern})$`, 'v').test(text)) return { controlId: control.id, code: 'pattern' }
    } catch {
      // Invalid source patterns are ignored by upstream.
    }
  }
  return undefined
}

export function validateExtensionFormData(definition: ExtensionFormDefinition, submitted: unknown): ExtensionFormDataResult {
  if (submitted === null || typeof submitted !== 'object' || Array.isArray(submitted)) return failure('malformedForm')
  const input = submitted as Record<string, unknown>
  const names = Object.keys(input)
  if (names.length > MAX_NAMES) return failure('malformedForm')
  const named: Exclude<ExtensionFormControl, { kind: 'hidden' }>[] = []
  for (const control of definition.controls) if (control.kind !== 'hidden' && control.name) named.push(control)
  const known = new Set<string>()
  const hidden = new Map<string, string>()
  const data = emptyData()
  for (const control of definition.controls) {
    if (control.kind === 'hidden' && control.name) {
      known.add(control.name)
      hidden.set(control.name, control.value)
      data[control.name] = control.value
    } else if (control.name) known.add(control.name)
  }
  for (const name of names) {
    if (name.length > 1024) return failure('malformedForm')
    if (!known.has(name)) return failure('unknownName', undefined, undefined, name)
    const value = input[name]
    if (typeof value === 'string' && value.length > MAX_SCALAR) return failure('malformedForm')
    if (typeof value === 'number' && !Number.isFinite(value)) return failure('malformedForm')
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ENTRIES) return failure('malformedForm')
      for (const entry of value) if (typeof entry !== 'string' || entry.length > MAX_SCALAR) return failure('malformedForm')
    } else if (typeof value !== 'string' && typeof value !== 'number') return failure('malformedForm')
  }
  const byName = new Map<string, Exclude<ExtensionFormControl, { kind: 'hidden' }>[]>()
  for (const control of named) {
    const group = byName.get(control.name)
    if (group) group.push(control)
    else byName.set(control.name, [control])
  }
  for (const [name, controls] of byName) {
    const entry = Object.hasOwn(input, name) ? input[name] : undefined
    const hiddenValue = hidden.get(name)
    let firstMismatch: ExtensionFormViolation['code'] | undefined
    const values = controls.map(control => {
      const parsed = control.kind === 'text' || control.kind === 'number' || control.kind === 'textarea'
        ? parseText(control, entry)
        : parseChoiceOrHidden(control, entry, hiddenValue)
      if (parsed.ok) return { control, value: parsed.value, carried: true }
      firstMismatch ??= parsed.code
      if (controls.length === 1) return { control, error: parsed.code, carried: false }
      const fallback = control.kind === 'text' || control.kind === 'number' || control.kind === 'textarea'
        ? parseText(control, undefined)
        : parseChoice(control, undefined)
      return { control, value: fallback.ok ? fallback.value : undefined, carried: false }
    })
    for (const result of values) {
      if ('error' in result && result.error !== undefined) return failure(result.error, result.control.id)
    }
    if (!values.some(result => result.carried)) return failure(firstMismatch ?? 'malformedForm', controls[0]?.id)
    for (const result of values) {
      const problem = constraintError(result.control, result.value)
      if (problem) return { ok: false, issues: [problem] }
      if (result.carried && result.value !== undefined) data[name] = result.value
    }
  }
  return { ok: true, data }
}
