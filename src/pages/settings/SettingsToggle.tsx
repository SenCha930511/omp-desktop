interface SettingsToggleProps {
  checked: boolean
  onChange(value: boolean): void
  label: string
  description?: string
}

export function SettingsToggle({ checked, onChange, label, description }: SettingsToggleProps) {
  return (
    <label className="settings-toggle">
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true">
        <span />
      </i>
    </label>
  )
}
