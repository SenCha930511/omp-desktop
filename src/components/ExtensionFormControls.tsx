import { createElement, type FormEvent, useMemo, useState } from 'react'
import {
  createExtensionFormDraft,
  submitExtensionForm,
  type ExtensionFormBlock,
  type ExtensionFormControl,
  type ExtensionFormData,
  type ExtensionFormDefinition,
  type ExtensionFormDraft,
  type ExtensionFormDraftValue,
  type ExtensionFormViolation,
} from '@/lib/extension-form'
import { useI18n, type MessageKey } from '@/lib/i18n'
import './extension-form-controls.css'

interface ExtensionFormControlsProps {
  formId: string
  definition: ExtensionFormDefinition
  onSubmit(data: ExtensionFormData): void
}

function violationKey(code: ExtensionFormViolation['code']): MessageKey {
  switch (code) {
    case 'required': return 'extensionForm.required'
    case 'number': return 'extensionForm.number'
    case 'min': return 'extensionForm.min'
    case 'max': return 'extensionForm.max'
    case 'minLength': return 'extensionForm.minLength'
    case 'maxLength': return 'extensionForm.maxLength'
    case 'email': return 'extensionForm.email'
    case 'url': return 'extensionForm.url'
    case 'pattern': return 'extensionForm.pattern'
    case 'selection': return 'extensionForm.selection'
    default: return 'extensionForm.invalid'
  }
}

function textEntry(draft: ExtensionFormDraft, controlId: string): Extract<ExtensionFormDraftValue, { kind: 'text' }> {
  const entry = draft[controlId]
  return entry?.kind === 'text' ? entry : { kind: 'text', value: '' }
}

function singleEntry(draft: ExtensionFormDraft, controlId: string): Extract<ExtensionFormDraftValue, { kind: 'single-choice' }> {
  const entry = draft[controlId]
  return entry?.kind === 'single-choice' ? entry : { kind: 'single-choice', other: '' }
}

function multiEntry(draft: ExtensionFormDraft, controlId: string): Extract<ExtensionFormDraftValue, { kind: 'multi-choice' }> {
  const entry = draft[controlId]
  return entry?.kind === 'multi-choice' ? entry : { kind: 'multi-choice', selected: [], other: '' }
}

export function ExtensionFormControls({ formId, definition, onSubmit }: ExtensionFormControlsProps) {
  const { t } = useI18n()
  const [draft, setDraft] = useState<ExtensionFormDraft>(() => createExtensionFormDraft(definition))
  const [issues, setIssues] = useState<readonly ExtensionFormViolation[]>([])
  const controls = useMemo(() => new Map(definition.controls.map((control) => [control.id, control])), [definition])

  const update = (controlId: string, value: ExtensionFormDraftValue) => {
    setDraft((current) => ({ ...current, [controlId]: value }))
    setIssues((current) => current.filter((issue) => issue.controlId !== controlId))
  }

  const errorFor = (controlId: string) => issues.find((issue) => issue.controlId === controlId)
  const describedBy = (controlId: string) => errorFor(controlId) ? `${formId}-${controlId}-error` : undefined
  const error = (controlId: string) => {
    const issue = errorFor(controlId)
    return issue ? <p className="extension-form__error" id={`${formId}-${controlId}-error`}>{t(violationKey(issue.code), { limit: issue.limit ?? 0 })}</p> : null
  }
  const labelFor = (control: Exclude<ExtensionFormControl, { kind: 'hidden' }>) => control.label || control.name || t('extensionForm.title')

  const renderControl = (control: ExtensionFormControl) => {
    if (control.kind === 'hidden') return null
    const described = describedBy(control.id)
    if (control.kind === 'text' || control.kind === 'number' || control.kind === 'textarea') {
      const entry = textEntry(draft, control.id)
      const inputId = `${formId}-${control.id}`
      const common = {
        id: inputId,
        value: entry.value,
        placeholder: control.placeholder,
        required: control.required,
        'aria-invalid': errorFor(control.id) !== undefined,
        'aria-describedby': described,
        onChange: (event: FormEvent<HTMLInputElement | HTMLTextAreaElement>) => update(control.id, { kind: 'text', value: event.currentTarget.value }),
      }
      return (
        <div className="field extension-form__field" data-control-id={control.id} key={control.id}>
          <label htmlFor={inputId}>{labelFor(control)}</label>
          {control.kind === 'textarea' ? (
            <textarea {...common} rows={control.rows} />
          ) : control.kind === 'number' ? (
            <input {...common} type={control.presentation} min={control.min} max={control.max} step="any" />
          ) : (
            <input
              {...common}
              type={control.inputType}
              autoComplete={control.inputType === 'password' ? 'off' : undefined}
            />
          )}
          {error(control.id)}
        </div>
      )
    }

    const controlLabel = labelFor(control)
    if (control.kind === 'select') {
      const inputId = `${formId}-${control.id}`
      if (control.multiple) {
        const entry = multiEntry(draft, control.id)
        return (
          <div className="field extension-form__field" data-control-id={control.id} key={control.id}>
            <label htmlFor={inputId}>{controlLabel}</label>
            <select
              id={inputId}
              multiple
              required={control.required}
              aria-invalid={errorFor(control.id) !== undefined}
              aria-describedby={described}
              value={[...entry.selected]}
              onChange={(event) => update(control.id, { ...entry, selected: Array.from(event.currentTarget.selectedOptions, (option) => option.value) })}
            >
              {control.options.map((option) => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
            </select>
            {error(control.id)}
          </div>
        )
      }
      const entry = singleEntry(draft, control.id)
      return (
        <div className="field extension-form__field" data-control-id={control.id} key={control.id}>
          <label htmlFor={inputId}>{controlLabel}</label>
          <select
            id={inputId}
            required={control.required}
            aria-invalid={errorFor(control.id) !== undefined}
            aria-describedby={described}
            value={entry.selected ?? ''}
            onChange={(event) => update(control.id, { ...entry, selected: event.currentTarget.value || undefined, other: '' })}
          >
            <option value="" disabled={control.required}>{t('extensionForm.choose')}</option>
            {control.options.map((option) => <option key={option.id} value={option.id} disabled={option.disabled}>{option.label}</option>)}
          </select>
          {error(control.id)}
        </div>
      )
    }

    if (control.kind === 'radio') {
      const entry = singleEntry(draft, control.id)
      const otherId = `${formId}-${control.id}-other`
      return (
        <fieldset className="extension-form__choice" data-control-id={control.id} key={control.id} aria-describedby={described}>
          <legend>{controlLabel}</legend>
          {control.options.map((option) => (
            <label className="extension-form__option" key={option.id}>
              <input
                type="radio"
                name={`${formId}-${control.id}`}
                checked={entry.selected === option.id}
                disabled={option.disabled}
                required={control.required}
                onChange={() => update(control.id, { kind: 'single-choice', selected: option.id, other: '' })}
              />
              <span>{option.label}</span>
            </label>
          ))}
          {control.other ? (
            <>
              <label className="extension-form__option" htmlFor={otherId}>
                <input
                  type="radio"
                  name={`${formId}-${control.id}`}
                  checked={entry.selected === undefined && entry.other.length > 0}
                  onChange={() => update(control.id, { kind: 'single-choice', other: entry.other })}
                />
                <span>{t('extensionForm.other')}</span>
              </label>
              <input
                className="extension-form__other-input"
                id={otherId}
                type="text"
                value={entry.other}
                aria-label={t('extensionForm.other')}
                aria-invalid={errorFor(control.id) !== undefined}
                onChange={(event) => update(control.id, { kind: 'single-choice', other: event.currentTarget.value })}
              />
            </>
          ) : null}
          {error(control.id)}
        </fieldset>
      )
    }

    const entry = multiEntry(draft, control.id)
    const otherId = `${formId}-${control.id}-other`
    const toggle = (optionId: string, checked: boolean) => {
      const selected = checked ? [...entry.selected, optionId] : entry.selected.filter((id) => id !== optionId)
      update(control.id, { ...entry, selected: [...new Set(selected)] })
    }
    return (
      <fieldset className="extension-form__choice" data-control-id={control.id} key={control.id} aria-describedby={described}>
        <legend>{controlLabel}</legend>
        {control.options.map((option) => (
          <label className="extension-form__option" key={option.id}>
            <input
              type="checkbox"
              checked={entry.selected.includes(option.id)}
              disabled={option.disabled}
              onChange={(event) => toggle(option.id, event.currentTarget.checked)}
            />
            <span>{option.label}</span>
          </label>
        ))}
        {control.other ? (
          <label className="field extension-form__other" htmlFor={otherId}>
            <span>{t('extensionForm.other')}</span>
            <input id={otherId} type="text" value={entry.other} aria-invalid={errorFor(control.id) !== undefined} onChange={(event) => update(control.id, { ...entry, other: event.currentTarget.value })} />
          </label>
        ) : null}
        {error(control.id)}
      </fieldset>
    )
  }

  const renderBlock = (block: ExtensionFormBlock, index: number) => {
    switch (block.kind) {
      case 'text':
        return block.heading
          ? createElement(`h${block.heading}`, { key: index, className: 'extension-form__heading' }, block.text)
          : <p className="extension-form__text" key={index}>{block.text}</p>
      case 'list':
        return createElement(block.ordered ? 'ol' : 'ul', { key: index, className: 'extension-form__list' }, block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>))
      case 'pre': return <pre className="extension-form__pre" key={index}>{block.text}</pre>
      case 'table':
        return (
          <div className="extension-form__table-wrap" key={index}>
            <table className="extension-form__table">
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => rowIndex < block.headerRows ? <th scope="col" key={cellIndex}>{cell}</th> : <td key={cellIndex}>{cell}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case 'field': {
        const control = controls.get(block.controlId)
        return control ? renderControl(control) : null
      }
    }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = submitExtensionForm(definition, draft)
    if (!result.ok) {
      setIssues(result.issues)
      return
    }
    setIssues([])
    onSubmit(result.data)
  }

  const globalIssue = issues.find((issue) => issue.controlId === undefined)
  return (
    <form id={formId} className="extension-form" noValidate onSubmit={submit}>
      {globalIssue ? <p className="extension-form__error" role="alert">{t(violationKey(globalIssue.code))}</p> : null}
      {definition.sections.map((section, sectionIndex) => (
        <section className="extension-form__section" key={sectionIndex}>
          {section.title ? <h2 className="extension-form__section-title">{section.title}</h2> : null}
          {section.blocks.map(renderBlock)}
        </section>
      ))}
    </form>
  )
}
