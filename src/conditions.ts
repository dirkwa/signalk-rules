import type { ConditionT, NumericConditionT } from './shared/schemas.js'
import type { Tri } from './shared/state-types.js'
import type { SunTracker } from './sun.js'

export interface InputReading {
  value: unknown
  /** Wall-clock arrival time (millis). We deliberately do not trust
   *  delta timestamps — log replays and skewed gateways lie. */
  receivedAt: number
}

export interface EvalContext {
  wallMs: number
  wallDate: Date
  defaultStaleSeconds: number
  getInput(path: string): InputReading | undefined
  sun: SunTracker
}

/** Per-condition mutable memory (the hysteresis latch). */
export interface CondState {
  latched: boolean
}

export const initialCondState = (): CondState => ({ latched: false })

/** 1 for on-ish values, 0 for off-ish, null for anything else. */
export function coerceSwitchValue(v: unknown): 0 | 1 | null {
  if (v === 1 || v === true || v === '1' || v === 'on') return 1
  if (v === 0 || v === false || v === '0' || v === 'off') return 0
  return null
}

function compare(
  value: number,
  operator: NumericConditionT['operator'],
  threshold: number
): boolean {
  switch (operator) {
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'eq':
      return value === threshold
    case 'ne':
      return value !== threshold
  }
}

/**
 * Evaluate one condition to three-valued truth. Mutates `state.latched`
 * for numeric conditions with a clearThreshold; a stale spell preserves
 * the latch so the value coming back on the same side produces no
 * spurious edge.
 */
export function evalCondition(
  cond: ConditionT,
  state: CondState,
  ctx: EvalContext
): Tri {
  const truth = evalRaw(cond, state, ctx)
  if (truth === 'unknown') return 'unknown'
  if (cond.negate === true) return truth === 'true' ? 'false' : 'true'
  return truth
}

function evalRaw(cond: ConditionT, state: CondState, ctx: EvalContext): Tri {
  switch (cond.type) {
    case 'numeric': {
      const value = freshNumericValue(cond, ctx)
      if (value === null) return 'unknown'
      if (cond.clearThreshold === undefined) {
        return compare(value, cond.operator, cond.threshold) ? 'true' : 'false'
      }
      if (!state.latched) {
        if (compare(value, cond.operator, cond.threshold)) state.latched = true
      } else {
        // Release side is opposite to the trigger side; validated by
        // validateRulesDoc to sit strictly beyond the threshold.
        const released =
          cond.operator === 'gt' || cond.operator === 'gte'
            ? value < cond.clearThreshold
            : value > cond.clearThreshold
        if (released) state.latched = false
      }
      return state.latched ? 'true' : 'false'
    }
    case 'switch': {
      const reading = freshReading(cond, ctx)
      if (reading === null) return 'unknown'
      const v = coerceSwitchValue(reading.value)
      if (v === null) return 'unknown'
      return v === cond.equals ? 'true' : 'false'
    }
    case 'string': {
      const reading = freshReading(cond, ctx)
      if (reading === null) return 'unknown'
      if (typeof reading.value !== 'string') return 'unknown'
      return reading.value === cond.equals ? 'true' : 'false'
    }
    case 'timeOfDay': {
      const minutes = ctx.wallDate.getHours() * 60 + ctx.wallDate.getMinutes()
      const from = parseHHMM(cond.from)
      const to = parseHHMM(cond.to)
      if (from === to) return 'false'
      const active =
        from < to
          ? minutes >= from && minutes < to
          : minutes >= from || minutes < to
      return active ? 'true' : 'false'
    }
    case 'sun': {
      const day = ctx.sun.isDay(
        ctx.wallDate,
        cond.startOffsetMinutes ?? 0,
        cond.endOffsetMinutes ?? 0
      )
      if (day === null) return 'unknown'
      const active = cond.during === 'day' ? day : !day
      return active ? 'true' : 'false'
    }
  }
}

function freshReading(
  cond: { path: string; staleSeconds?: number },
  ctx: EvalContext
): InputReading | null {
  const reading = ctx.getInput(cond.path)
  if (reading === undefined) return null
  const ttl = cond.staleSeconds ?? ctx.defaultStaleSeconds
  if (ttl > 0 && ctx.wallMs - reading.receivedAt > ttl * 1000) return null
  return reading
}

function freshNumericValue(
  cond: NumericConditionT,
  ctx: EvalContext
): number | null {
  const reading = freshReading(cond, ctx)
  if (reading === null) return null
  return typeof reading.value === 'number' && Number.isFinite(reading.value)
    ? reading.value
    : null
}

function parseHHMM(s: string): number {
  const h = Number(s.slice(0, 2))
  const m = Number(s.slice(3, 5))
  return h * 60 + m
}

/** Kleene three-valued AND/OR over the condition truths. */
export function combine(combinator: 'all' | 'any', truths: Tri[]): Tri {
  if (combinator === 'all') {
    if (truths.some((t) => t === 'false')) return 'false'
    if (truths.some((t) => t === 'unknown')) return 'unknown'
    return 'true'
  }
  if (truths.some((t) => t === 'true')) return 'true'
  if (truths.some((t) => t === 'unknown')) return 'unknown'
  return 'false'
}
