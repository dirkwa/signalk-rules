import { useEffect, useState } from 'react'
import { useMetaStore } from '../stores/metaStore'
import { unitFor } from '../unitConvert'

interface NumberWithUnitProps {
  /** Path whose meta units drive the conversion. */
  path: string
  /** Raw SI value as stored in the rule. */
  value: number
  onChange(raw: number): void
  invalid?: boolean
}

/**
 * The user types display units (kn, %, °C); the rule stores raw SI.
 * Conversion happens on blur/Enter so partial input isn't mangled.
 */
export function NumberWithUnit({
  path,
  value,
  onChange,
  invalid
}: NumberWithUnitProps) {
  const units = useMetaStore((s) => s.paths[path]?.units)
  const u = unitFor(units)
  const display = u.toDisplay(value)
  const rounded = Number(display.toFixed(Math.max(u.decimals, 3)))
  const [text, setText] = useState(String(rounded))

  useEffect(() => {
    setText(String(Number(u.toDisplay(value).toFixed(Math.max(u.decimals, 3)))))
  }, [value, units])

  const commit = (): void => {
    const parsed = Number(text.replace(',', '.'))
    if (Number.isFinite(parsed)) {
      onChange(u.toRaw(parsed))
    } else {
      setText(String(rounded))
    }
  }

  return (
    <span className="number-with-unit">
      <input
        type="text"
        inputMode="decimal"
        className={invalid ? 'input-invalid' : ''}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit()
            e.currentTarget.blur()
          }
        }}
      />
      {u.display !== '' && <span className="unit-suffix">{u.display}</span>}
    </span>
  )
}
