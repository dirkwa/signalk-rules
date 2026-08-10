/**
 * Rule thresholds are stored in raw Signal K units; users think in
 * knots, percent and degrees. Conversion lives only at the input
 * widget and the inline live-value display — the engine never sees a
 * display unit.
 */

export interface UnitDef {
  /** Suffix shown next to inputs and live values, e.g. "kn". */
  display: string
  toDisplay(raw: number): number
  toRaw(display: number): number
  decimals: number
}

const identity = (unit: string | undefined, decimals = 1): UnitDef => ({
  display: unit ?? '',
  toDisplay: (v) => v,
  toRaw: (v) => v,
  decimals
})

const TABLE: Record<string, UnitDef> = {
  'm/s': {
    display: 'kn',
    toDisplay: (v) => v * 1.94384,
    toRaw: (v) => v / 1.94384,
    decimals: 1
  },
  ratio: {
    display: '%',
    toDisplay: (v) => v * 100,
    toRaw: (v) => v / 100,
    decimals: 0
  },
  K: {
    display: '°C',
    toDisplay: (v) => v - 273.15,
    toRaw: (v) => v + 273.15,
    decimals: 1
  },
  Pa: {
    display: 'hPa',
    toDisplay: (v) => v / 100,
    toRaw: (v) => v * 100,
    decimals: 1
  },
  rad: {
    display: '°',
    toDisplay: (v) => (v * 180) / Math.PI,
    toRaw: (v) => (v * Math.PI) / 180,
    decimals: 0
  },
  V: identity('V', 1),
  A: identity('A', 1),
  Hz: identity('Hz', 1),
  W: identity('W', 0)
}

export function unitFor(siUnit: string | undefined): UnitDef {
  if (siUnit === undefined) return identity(undefined)
  return TABLE[siUnit] ?? identity(siUnit)
}

export function formatValue(
  value: unknown,
  siUnit: string | undefined
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    if (value === undefined || value === null) return '—'
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
  }
  const u = unitFor(siUnit)
  const d = u.toDisplay(value)
  const text = d.toFixed(u.decimals)
  return u.display === '' ? text : `${text} ${u.display}`
}
