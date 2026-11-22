import type {
  ExtensionFormBlock,
  ExtensionFormControl,
  ExtensionFormDefinition,
  ExtensionFormOption,
  ExtensionFormTextType,
  FormControlId,
} from './extension-form'

export type ExtensionFormHtmlResult =
  | { readonly ok: true; readonly definition: ExtensionFormDefinition }
  | { readonly ok: false; readonly reason: string }

const MAX_HTML = 1_048_576
const MAX_CONTROLS = 128
const MAX_OPTIONS = 512
const MAX_BLOCKS = 512
const MAX_SECTIONS = 128
const MAX_NAME = 1024
const MAX_TEXT = 32_000
const MAX_VALUE = 1_048_576
const TEXT_TYPES = new Set<ExtensionFormTextType>(['text', 'search', 'tel', 'email', 'url', 'password', 'date', 'datetime-local', 'month', 'week', 'time', 'color'])
const SKIPPED = new Set(['base', 'button', 'embed', 'head', 'iframe', 'link', 'meta', 'noscript', 'object', 'script', 'style', 'template', 'title'])
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figure', 'figcaption', 'footer', 'header', 'li', 'main', 'nav', 'p', 'section'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'summary'])
const IGNORED_INPUTS = new Set(['button', 'file', 'image', 'reset', 'submit'])
const CONTROL_SELECTOR = 'input, select, textarea'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type ChoiceControl = ExtensionFormControl extends infer Control
  ? Control extends { kind: 'radio' | 'checkbox' | 'select' }
    ? Mutable<Omit<Control, 'options'>> & { options: Mutable<ExtensionFormOption>[] }
    : never
  : never
interface SectionData { title: string; blocks: ExtensionFormBlock[] }
interface GroupData { control: ChoiceControl; section: SectionData }

class RejectedForm extends Error {
  constructor(readonly reason: string) { super(reason) }
}

function normalize(parts: readonly string[]): string {
  return parts.join('').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').trim()
}

function bounded(text: string, limit: number, reason: string): string {
  if (text.length > limit) throw new RejectedForm(reason)
  return text
}

function numberAttr(element: Element, name: string): number | undefined {
  const raw = element.getAttribute(name)
  if (raw === null || raw.trim() === '') return undefined
  bounded(raw, MAX_TEXT, 'attributeTooLong')
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function directChildren(element: Element, tag?: string): Element[] {
  return Array.from(element.children).filter(child => tag === undefined || child.localName === tag)
}

class FormBuilder {
  readonly #sections: SectionData[] = []
  readonly #controls: ExtensionFormControl[] = []
  readonly #groups = new Map<string, GroupData>()
  readonly #labelFor = new Map<string, Element>()
  readonly #byId = new Map<FormControlId, ExtensionFormControl>()
  #section: SectionData = { title: '', blocks: [] }
  #inline: string[] = []
  #fieldsetDepth = 0
  #controlCount = 0
  #optionCount = 0
  #blockCount = 0

  readonly #root: Document | Element

  constructor(root: Document | Element) {
    this.#root = root
    this.#sections.push(this.#section)
  }

  build(): ExtensionFormDefinition {
    const ids = new Set<string>()
    for (const control of this.#root.querySelectorAll(CONTROL_SELECTOR)) if (control.id) ids.add(control.id)
    for (const label of this.#root.querySelectorAll('label')) {
      const target = label.getAttribute('for')
      if (target && ids.has(target) && !this.#labelFor.has(target)) this.#labelFor.set(target, label)
    }
    this.#children(this.#root)
    this.#flush()
    for (const control of this.#controls) {
      if ((control.kind === 'radio' || control.kind === 'checkbox') && control.options.length >= 2) {
        ;(control as Mutable<Extract<ExtensionFormControl, { kind: 'radio' | 'checkbox' }>>).other =
          !control.options.some(option => /^\s*other\b/i.test(option.label))
      }
    }
    const sections = this.#sections.filter(section => section.blocks.length > 0 || section.title.length > 0)
    for (const section of sections) {
      let caption = ''
      for (const block of section.blocks) {
        if (block.kind !== 'field') {
          caption = block.kind === 'text' ? block.text : ''
          continue
        }
        const control = this.#byId.get(block.controlId)
        if (!control || control.kind === 'hidden' || control.kind === 'text' || control.kind === 'number' || control.kind === 'textarea') {
          caption = ''
          continue
        }
        if (!control.label) {
          const lone = control.options.length === 1 ? control.options[0]?.label ?? '' : ''
          ;(control as Mutable<typeof control>).label = caption || section.title || lone || control.name
        }
        caption = ''
      }
    }
    return { sections, controls: this.#controls }
  }

  #pushBlock(block: ExtensionFormBlock): void {
    if (++this.#blockCount > MAX_BLOCKS) throw new RejectedForm('tooManyBlocks')
    this.#section.blocks.push(block)
  }

  #children(node: Document | Element): void {
    for (const child of node.childNodes) this.#walk(child)
  }

  #walk(node: Node): void {
    if (node.nodeType === 3) {
      this.#inline.push((node as Text).data)
      return
    }
    if (node.nodeType !== 1) return
    const element = node as Element
    const tag = element.localName
    if (SKIPPED.has(tag)) return
    switch (tag) {
      case 'br': this.#inline.push('\n'); return
      case 'hr': this.#flush(); return
      case 'input':
      case 'select':
      case 'textarea': this.#control(element); return
      case 'label': this.#label(element); return
      case 'fieldset': this.#fieldset(element); return
      case 'legend': this.#flush(); this.#children(element); this.#flush(2); return
      case 'ul':
      case 'ol': this.#list(element, tag === 'ol'); return
      case 'pre': this.#flush(); this.#pushBlock({ kind: 'pre', text: bounded(this.#rawText(element).replace(/^\n/, '').trimEnd(), MAX_TEXT, 'contextTooLong') }); return
      case 'table': this.#table(element); return
      case 'img': {
        const alt = (element.getAttribute('alt') ?? '').trim()
        if (alt) { this.#flush(); this.#pushBlock({ kind: 'text', text: bounded(alt, MAX_TEXT, 'labelTooLong') }) }
        return
      }
      case 'svg': {
        const title = this.#svgTitle(element)
        if (title) { this.#flush(); this.#pushBlock({ kind: 'text', text: title }) }
        return
      }
    }
    if (HEADINGS.has(tag)) {
      const level = tag === 'summary' ? 2 : Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6
      this.#flush(); this.#children(element); this.#flush(level)
    } else if (BLOCK.has(tag)) {
      this.#flush(); this.#children(element); this.#flush()
    } else this.#children(element)
  }

  #flush(heading?: 1 | 2 | 3 | 4 | 5 | 6): void {
    const text = normalize(this.#inline)
    this.#inline = []
    if (text) this.#pushBlock({ kind: 'text', text: bounded(text, MAX_TEXT, 'contextTooLong'), ...(heading ? { heading } : {}) })
  }

  #rawText(element: Element): string {
    let text = ''
    const visit = (node: Node): void => {
      if (node.nodeType === 3) { text += (node as Text).data; return }
      if (node.nodeType !== 1) return
      const child = node as Element
      if (SKIPPED.has(child.localName) || child.localName === 'svg' || child.localName === 'input' || child.localName === 'select' || child.localName === 'textarea') return
      if (child.localName === 'br') { text += '\n'; return }
      if (child.localName === 'img') { text += child.getAttribute('alt') ?? ''; return }
      for (const grandchild of child.childNodes) visit(grandchild)
    }
    for (const child of element.childNodes) visit(child)
    return text
  }

  #textOf(element: Element): string {
    const parts: string[] = []
    const visit = (node: Node): void => {
      if (node.nodeType === 3) { parts.push((node as Text).data); return }
      if (node.nodeType !== 1) return
      const child = node as Element
      const tag = child.localName
      if (SKIPPED.has(tag) || tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'svg') return
      if (tag === 'br') { parts.push('\n'); return }
      if (tag === 'img') { parts.push(child.getAttribute('alt') ?? ''); return }
      if (BLOCK.has(tag) || HEADINGS.has(tag)) parts.push(' ')
      for (const grandchild of child.childNodes) visit(grandchild)
    }
    for (const child of element.childNodes) visit(child)
    return bounded(normalize(parts), MAX_TEXT, 'labelTooLong')
  }

  #svgTitle(svg: Element): string {
    const aria = svg.getAttribute('aria-label')?.trim()
    const title = directChildren(svg, 'title')[0]
    return bounded(aria || (title ? this.#textOf(title) : ''), MAX_TEXT, 'labelTooLong')
  }

  #label(label: Element): void {
    const target = label.getAttribute('for')
    if (target && this.#labelFor.get(target) === label) return
    const controls = Array.from(label.querySelectorAll(CONTROL_SELECTOR))
    if (controls.length === 0) { this.#children(label); return }
    this.#flush()
    const text = this.#textOf(label)
    for (const control of controls) this.#control(control, text)
  }

  #detachedLabel(control: Element): string {
    const label = control.id ? this.#labelFor.get(control.id) : undefined
    if (label) return this.#textOf(label)
    return bounded(control.getAttribute('aria-label') ?? control.getAttribute('title') ?? '', MAX_TEXT, 'labelTooLong')
  }

  #fieldset(fieldset: Element): void {
    this.#flush()
    const legend = directChildren(fieldset, 'legend')[0]
    if (this.#fieldsetDepth > 0) {
      if (legend) this.#walk(legend)
    } else this.#startSection(legend ? this.#textOf(legend) : '')
    this.#fieldsetDepth++
    for (const child of fieldset.childNodes) if (child !== legend) this.#walk(child)
    this.#flush()
    this.#fieldsetDepth--
    if (this.#fieldsetDepth === 0) this.#startSection('')
  }

  #startSection(title: string): void {
    if (!this.#section.blocks.length && !this.#section.title) { this.#section.title = title; return }
    this.#section = { title, blocks: [] }
    if (this.#sections.push(this.#section) > MAX_SECTIONS) throw new RejectedForm('tooManySections')
  }

  #list(list: Element, ordered: boolean): void {
    this.#flush()
    if (list.querySelector(CONTROL_SELECTOR)) { this.#children(list); this.#flush(); return }
    const items = directChildren(list, 'li').map(item => this.#textOf(item)).filter(Boolean)
    if (items.length) this.#pushBlock({ kind: 'list', items, ordered })
  }

  #table(table: Element): void {
    this.#flush()
    const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table)
    const cellsOf = (row: Element): Element[] => Array.from(row.children).filter(cell => cell.localName === 'td' || cell.localName === 'th')
    if (!table.querySelector(CONTROL_SELECTOR)) {
      const cells = rows.map(row => cellsOf(row).map(cell => this.#textOf(cell)))
      let headerRows = 0
      while (headerRows < rows.length && (rows[headerRows]?.closest('thead') !== null || cellsOf(rows[headerRows] as Element).every(cell => cell.localName === 'th'))) headerRows++
      if (cells.some(row => row.length > 0)) this.#pushBlock({ kind: 'table', rows: cells, headerRows })
      return
    }
    let header: string[] = []
    for (const row of rows) {
      const cells = cellsOf(row)
      if (cells.every(cell => cell.localName === 'th') && !row.querySelector(CONTROL_SELECTOR)) { header = cells.map(cell => this.#textOf(cell)); continue }
      const text = cells.filter(cell => !cell.querySelector(CONTROL_SELECTOR)).map(cell => this.#textOf(cell)).filter(Boolean).join(' · ')
      if (text) this.#pushBlock({ kind: 'text', text: bounded(text, MAX_TEXT, 'contextTooLong') })
      cells.forEach((cell, column) => {
        for (const control of cell.querySelectorAll(CONTROL_SELECTOR)) {
          const own = control.closest('label')
          const label = own && cell.contains(own) ? this.#textOf(own) : this.#textOf(cell)
          this.#control(control, label || header[column] || '')
        }
      })
    }
  }

  #id(): FormControlId {
    if (++this.#controlCount > MAX_CONTROLS) throw new RejectedForm('tooManyControls')
    return `control-${this.#controlCount}`
  }

  #addControl(control: ExtensionFormControl): void {
    this.#controls.push(control)
    this.#byId.set(control.id, control)
    if (control.kind !== 'hidden') this.#pushBlock({ kind: 'field', controlId: control.id })
  }

  #control(control: Element, wrapping = ''): void {
    this.#flush()
    const label = wrapping || this.#detachedLabel(control)
    const name = bounded(control.getAttribute('name') ?? '', MAX_NAME, 'nameTooLong')
    const required = control.hasAttribute('required')
    const tag = control.localName
    if (tag === 'select') {
      const source = Array.from(control.querySelectorAll('option'))
      if (source.length > MAX_OPTIONS) throw new RejectedForm('tooManyOptions')
      const multiple = control.hasAttribute('multiple')
      const options: Mutable<ExtensionFormOption>[] = source.map(option => {
        const text = bounded(this.#textOf(option).replace(/\s+/g, ' ').trim(), MAX_TEXT, 'labelTooLong')
        return { id: `option-${++this.#optionCount}`, value: bounded(option.getAttribute('value') ?? text, MAX_VALUE, 'valueTooLong'), label: text, initiallyChecked: option.hasAttribute('selected'), disabled: option.hasAttribute('disabled') }
      })
      if (!multiple && !options.some(option => option.initiallyChecked)) {
        const first = options.find(option => !option.disabled)
        if (first) first.initiallyChecked = true
      }
      this.#addControl({ kind: 'select', id: this.#id(), name, label, options, required, multiple })
      return
    }
    if (tag === 'textarea') {
      const value = bounded((control.textContent ?? '').replace(/^\r?\n/, ''), MAX_VALUE, 'valueTooLong')
      const rows = Math.max(1, Math.min(20, numberAttr(control, 'rows') ?? 4))
      this.#addControl({ kind: 'textarea', id: this.#id(), name, label: label || name.replace(/[_-]+/g, ' '), initialValue: value, placeholder: bounded(control.getAttribute('placeholder') ?? '', MAX_TEXT, 'attributeTooLong'), required, minLength: numberAttr(control, 'minlength'), maxLength: numberAttr(control, 'maxlength'), rows })
      return
    }
    const type = (control.getAttribute('type') ?? 'text').toLowerCase()
    if (IGNORED_INPUTS.has(type)) return
    const rawValue = bounded(control.getAttribute('value') ?? '', MAX_VALUE, 'valueTooLong')
    if (type === 'hidden') {
      if (name) this.#addControl({ kind: 'hidden', id: this.#id(), name, value: rawValue })
      return
    }
    if (type === 'radio' || type === 'checkbox') {
      const fallbackLabel = control.getAttribute('value') === null ? name : rawValue
      const option: Mutable<ExtensionFormOption> = { id: `option-${++this.#optionCount}`, value: control.getAttribute('value') === null ? 'on' : rawValue, label: bounded(label || fallbackLabel, MAX_TEXT, 'labelTooLong'), initiallyChecked: control.hasAttribute('checked'), disabled: control.hasAttribute('disabled') }
      const key = `${type}\0${name}`
      const existing = this.#groups.get(key)
      if (existing) {
        if (existing.control.options.length >= MAX_OPTIONS) throw new RejectedForm('tooManyOptions')
        existing.control.options.push(option)
        existing.control.required ||= required
        return
      }
      const grouped: ChoiceControl = { kind: type, id: this.#id(), name, label: '', options: [option], other: false, required }
      this.#addControl(grouped)
      this.#groups.set(key, { control: grouped, section: this.#section })
      return
    }
    const common = { id: this.#id(), name, label: label || name.replace(/[_-]+/g, ' '), initialValue: rawValue, placeholder: bounded(control.getAttribute('placeholder') ?? '', MAX_TEXT, 'attributeTooLong'), required, pattern: control.getAttribute('pattern') ?? undefined, minLength: numberAttr(control, 'minlength'), maxLength: numberAttr(control, 'maxlength') }
    if (common.pattern) bounded(common.pattern, MAX_TEXT, 'attributeTooLong')
    if (type === 'number' || type === 'range') {
      this.#addControl({ ...common, kind: 'number', presentation: type, min: numberAttr(control, 'min'), max: numberAttr(control, 'max') })
    } else {
      this.#addControl({ ...common, kind: 'text', inputType: TEXT_TYPES.has(type as ExtensionFormTextType) ? type as ExtensionFormTextType : 'text' })
    }
  }
}

export function parseFormHtml(html: string, parser: Pick<DOMParser, 'parseFromString'>): ExtensionFormHtmlResult {
  if (typeof html !== 'string' || html.length > MAX_HTML) return { ok: false, reason: 'htmlTooLarge' }
  try {
    const document = parser.parseFromString(html, 'text/html')
    return { ok: true, definition: new FormBuilder(document.querySelector('form') ?? document).build() }
  } catch (error) {
    return { ok: false, reason: error instanceof RejectedForm ? error.reason : 'unreadableDocument' }
  }
}
