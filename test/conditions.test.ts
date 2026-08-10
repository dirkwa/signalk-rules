import { describe, it, expect } from 'vitest'
import {
  combine,
  evalCondition,
  initialCondState,
  coerceSwitchValue,
  type EvalContext,
  type InputReading
} from '../src/conditions.js'
import { SunTracker } from '../src/sun.js'
import type { ConditionT } from '../src/shared/schemas.js'

function ctx(
  inputs: Record<string, InputReading>,
  over: Partial<EvalContext> = {}
): EvalContext {
  return {
    wallMs: 1_000_000,
    wallDate: new Date('2026-08-10T12:00:00'),
    defaultStaleSeconds: 300,
    getInput: (path) => inputs[path],
    sun: new SunTracker(),
    ...over
  }
}

const reading = (value: unknown, receivedAt = 1_000_000): InputReading => ({
  value,
  receivedAt
})

describe('numeric conditions', () => {
  const gt: ConditionT = {
    type: 'numeric',
    path: 'a.b',
    operator: 'gt',
    threshold: 4
  }

  it('compares without hysteresis', () => {
    expect(
      evalCondition(gt, initialCondState(), ctx({ 'a.b': reading(5) }))
    ).toBe('true')
    expect(
      evalCondition(gt, initialCondState(), ctx({ 'a.b': reading(4) }))
    ).toBe('false')
    expect(
      evalCondition(gt, initialCondState(), ctx({ 'a.b': reading(3) }))
    ).toBe('false')
  })

  it('returns unknown for missing, stale, or non-numeric input', () => {
    expect(evalCondition(gt, initialCondState(), ctx({}))).toBe('unknown')
    expect(
      evalCondition(
        gt,
        initialCondState(),
        ctx({ 'a.b': reading(5, 1_000_000 - 301_000) })
      )
    ).toBe('unknown')
    expect(
      evalCondition(gt, initialCondState(), ctx({ 'a.b': reading('high') }))
    ).toBe('unknown')
    expect(
      evalCondition(gt, initialCondState(), ctx({ 'a.b': reading(NaN) }))
    ).toBe('unknown')
  })

  it('honours per-condition staleSeconds override, 0 = never stale', () => {
    const never: ConditionT = { ...gt, staleSeconds: 0 }
    expect(
      evalCondition(
        never,
        initialCondState(),
        ctx({ 'a.b': reading(5, 1_000_000 - 999_999_000) })
      )
    ).toBe('true')
  })

  it('latches with clearThreshold (gt)', () => {
    const hyst: ConditionT = { ...gt, clearThreshold: 1 }
    const state = initialCondState()
    expect(evalCondition(hyst, state, ctx({ 'a.b': reading(3) }))).toBe('false')
    expect(evalCondition(hyst, state, ctx({ 'a.b': reading(5) }))).toBe('true')
    // Dips below trigger but above clear: stays latched
    expect(evalCondition(hyst, state, ctx({ 'a.b': reading(2) }))).toBe('true')
    // Below clear: releases
    expect(evalCondition(hyst, state, ctx({ 'a.b': reading(0.5) }))).toBe(
      'false'
    )
    // Between clear and trigger: stays released
    expect(evalCondition(hyst, state, ctx({ 'a.b': reading(2) }))).toBe('false')
  })

  it('latches with clearThreshold (lt) — the SOC generator case', () => {
    const soc: ConditionT = {
      type: 'numeric',
      path: 'soc',
      operator: 'lt',
      threshold: 0.25,
      clearThreshold: 0.3
    }
    const state = initialCondState()
    expect(evalCondition(soc, state, ctx({ soc: reading(0.5) }))).toBe('false')
    expect(evalCondition(soc, state, ctx({ soc: reading(0.24) }))).toBe('true')
    expect(evalCondition(soc, state, ctx({ soc: reading(0.27) }))).toBe('true')
    expect(evalCondition(soc, state, ctx({ soc: reading(0.31) }))).toBe('false')
  })

  it('latch survives a stale spell without a spurious edge', () => {
    const hyst: ConditionT = { ...gt, clearThreshold: 1 }
    const state = initialCondState()
    expect(evalCondition(hyst, state, ctx({ 'a.b': reading(5) }))).toBe('true')
    expect(
      evalCondition(
        hyst,
        state,
        ctx({ 'a.b': reading(5, 1_000_000 - 301_000) })
      )
    ).toBe('unknown')
    // Value returns on the same side: still latched, still true
    expect(evalCondition(hyst, state, ctx({ 'a.b': reading(2) }))).toBe('true')
  })

  it('negate flips true/false but leaves unknown alone', () => {
    const neg: ConditionT = { ...gt, negate: true }
    expect(
      evalCondition(neg, initialCondState(), ctx({ 'a.b': reading(5) }))
    ).toBe('false')
    expect(
      evalCondition(neg, initialCondState(), ctx({ 'a.b': reading(3) }))
    ).toBe('true')
    expect(evalCondition(neg, initialCondState(), ctx({}))).toBe('unknown')
  })
})

describe('switch conditions', () => {
  it('coerces bus value shapes', () => {
    expect(coerceSwitchValue(1)).toBe(1)
    expect(coerceSwitchValue(true)).toBe(1)
    expect(coerceSwitchValue('on')).toBe(1)
    expect(coerceSwitchValue(0)).toBe(0)
    expect(coerceSwitchValue(false)).toBe(0)
    expect(coerceSwitchValue('off')).toBe(0)
    expect(coerceSwitchValue(0.5)).toBe(null)
    expect(coerceSwitchValue(undefined)).toBe(null)
  })

  it('compares against equals', () => {
    const cond: ConditionT = { type: 'switch', path: 's', equals: 1 }
    expect(
      evalCondition(cond, initialCondState(), ctx({ s: reading(1) }))
    ).toBe('true')
    expect(
      evalCondition(cond, initialCondState(), ctx({ s: reading(true) }))
    ).toBe('true')
    expect(
      evalCondition(cond, initialCondState(), ctx({ s: reading(0) }))
    ).toBe('false')
    expect(
      evalCondition(cond, initialCondState(), ctx({ s: reading('x') }))
    ).toBe('unknown')
  })
})

describe('string conditions', () => {
  it('matches exactly', () => {
    const cond: ConditionT = {
      type: 'string',
      path: 'navigation.state',
      equals: 'anchored'
    }
    expect(
      evalCondition(
        cond,
        initialCondState(),
        ctx({ 'navigation.state': reading('anchored') })
      )
    ).toBe('true')
    expect(
      evalCondition(
        cond,
        initialCondState(),
        ctx({ 'navigation.state': reading('sailing') })
      )
    ).toBe('false')
    expect(
      evalCondition(
        cond,
        initialCondState(),
        ctx({ 'navigation.state': reading(3) })
      )
    ).toBe('unknown')
  })
})

describe('timeOfDay conditions', () => {
  const at = (hhmm: string): EvalContext =>
    ctx({}, { wallDate: new Date(`2026-08-10T${hhmm}:00`) })

  it('handles a normal window', () => {
    const cond: ConditionT = { type: 'timeOfDay', from: '09:00', to: '17:00' }
    expect(evalCondition(cond, initialCondState(), at('12:00'))).toBe('true')
    expect(evalCondition(cond, initialCondState(), at('08:59'))).toBe('false')
    expect(evalCondition(cond, initialCondState(), at('17:00'))).toBe('false')
  })

  it('wraps midnight', () => {
    const cond: ConditionT = { type: 'timeOfDay', from: '22:00', to: '06:00' }
    expect(evalCondition(cond, initialCondState(), at('23:30'))).toBe('true')
    expect(evalCondition(cond, initialCondState(), at('05:59'))).toBe('true')
    expect(evalCondition(cond, initialCondState(), at('12:00'))).toBe('false')
  })

  it('zero-length window is never active', () => {
    const cond: ConditionT = { type: 'timeOfDay', from: '10:00', to: '10:00' }
    expect(evalCondition(cond, initialCondState(), at('10:00'))).toBe('false')
  })
})

describe('sun conditions', () => {
  it('is unknown without a position, then resolves day/night', () => {
    const cond: ConditionT = { type: 'sun', during: 'day' }
    const noPos = ctx({})
    expect(evalCondition(cond, initialCondState(), noPos)).toBe('unknown')

    const sun = new SunTracker()
    // Sydney harbour, midday local (UTC+10 in August)
    sun.setPosition({ latitude: -33.86, longitude: 151.2 })
    const noonUtc = new Date('2026-08-10T02:00:00Z')
    const midnightUtc = new Date('2026-08-10T14:00:00Z')
    expect(
      evalCondition(
        cond,
        initialCondState(),
        ctx({}, { sun, wallDate: noonUtc })
      )
    ).toBe('true')
    expect(
      evalCondition(
        cond,
        initialCondState(),
        ctx({}, { sun, wallDate: midnightUtc })
      )
    ).toBe('false')

    const night: ConditionT = { type: 'sun', during: 'night' }
    expect(
      evalCondition(
        night,
        initialCondState(),
        ctx({}, { sun, wallDate: midnightUtc })
      )
    ).toBe('true')
  })

  it('ignores invalid positions', () => {
    const sun = new SunTracker()
    sun.setPosition({ latitude: 'x', longitude: 3 })
    sun.setPosition(null)
    sun.setPosition(42)
    expect(sun.position).toBe(null)
  })
})

describe('Kleene combine', () => {
  it('ALL truth table', () => {
    expect(combine('all', ['true', 'true'])).toBe('true')
    expect(combine('all', ['true', 'false'])).toBe('false')
    expect(combine('all', ['unknown', 'false'])).toBe('false')
    expect(combine('all', ['true', 'unknown'])).toBe('unknown')
    expect(combine('all', [])).toBe('true')
  })

  it('ANY truth table', () => {
    expect(combine('any', ['false', 'true'])).toBe('true')
    expect(combine('any', ['unknown', 'true'])).toBe('true')
    expect(combine('any', ['false', 'unknown'])).toBe('unknown')
    expect(combine('any', ['false', 'false'])).toBe('false')
    expect(combine('any', [])).toBe('false')
  })
})
