interface SwitchProps {
  checked: boolean
  onChange(next: boolean): void
  disabled?: boolean
  title?: string
}

export function Switch({ checked, onChange, disabled, title }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle ${checked ? 'toggle-on' : ''}`}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-knob" />
    </button>
  )
}
