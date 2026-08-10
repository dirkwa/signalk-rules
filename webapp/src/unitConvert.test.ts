import { describe, it, expect } from 'vitest'
import { unitFor, formatValue } from './unitConvert'

describe('unitConvert', () => {
  it('round-trips knots', () => {
    const u = unitFor('m/s')
    expect(u.display).toBe('kn')
    expect(u.toRaw(1)).toBeCloseTo(0.514444, 4)
    expect(u.toDisplay(u.toRaw(7.3))).toBeCloseTo(7.3, 6)
  })

  it('round-trips percent', () => {
    const u = unitFor('ratio')
    expect(u.toRaw(25)).toBeCloseTo(0.25)
    expect(u.toDisplay(0.84)).toBeCloseTo(84)
  })

  it('round-trips celsius', () => {
    const u = unitFor('K')
    expect(u.toDisplay(293.15)).toBeCloseTo(20)
    expect(u.toRaw(20)).toBeCloseTo(293.15)
  })

  it('passes through unknown units', () => {
    const u = unitFor('V')
    expect(u.toDisplay(12.6)).toBe(12.6)
    expect(unitFor('furlongs').display).toBe('furlongs')
    expect(unitFor(undefined).display).toBe('')
  })

  it('formats values with units', () => {
    expect(formatValue(0.514444, 'm/s')).toBe('1.0 kn')
    expect(formatValue(0.25, 'ratio')).toBe('25 %')
    expect(formatValue(undefined, 'm/s')).toBe('—')
    expect(formatValue('anchored', undefined)).toBe('anchored')
    expect(formatValue(1, undefined)).toBe('1.0')
  })
})
