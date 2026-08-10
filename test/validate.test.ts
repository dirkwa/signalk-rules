import { describe, it, expect } from 'vitest'
import { validateRulesDoc } from '../src/shared/validate.js'
import type { RuleT } from '../src/shared/schemas.js'

const baseRule = (over: Partial<RuleT> = {}): RuleT => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  name: 'Test rule',
  enabled: true,
  dryRun: false,
  combinator: 'all',
  conditions: [
    {
      type: 'numeric',
      path: 'electrical.solar.258.current',
      operator: 'gt',
      threshold: 4
    }
  ],
  actions: [{ type: 'setSwitch', path: 'electrical.switches.bank.10.3.state' }],
  options: {},
  ...over
})

const doc = (...rules: RuleT[]) => ({ version: 1, rules })

describe('validateRulesDoc', () => {
  it('accepts an empty doc', () => {
    const r = validateRulesDoc({ version: 1, rules: [] })
    expect(r.ok).toBe(true)
  })

  it('accepts the three example rules', () => {
    const waterHeater = baseRule({
      name: 'Water heater on solar',
      conditions: [
        {
          type: 'numeric',
          path: 'electrical.solar.258.current',
          operator: 'gt',
          threshold: 4,
          clearThreshold: 1
        }
      ],
      options: { holdTrueSeconds: 60, holdFalseSeconds: 120 }
    })
    const anchorLight = baseRule({
      id: 'bbbbbbbb-1111-2222-3333-444444444444',
      name: 'Anchor light',
      conditions: [
        {
          type: 'numeric',
          path: 'electrical.solar.258.current',
          operator: 'gt',
          threshold: 0.5,
          negate: true
        },
        {
          type: 'numeric',
          path: 'electrical.ac.130.average.lineNeutralVoltage',
          operator: 'lt',
          threshold: 100
        },
        {
          type: 'numeric',
          path: 'navigation.speedOverGround',
          operator: 'lt',
          threshold: 0.514,
          clearThreshold: 0.77
        },
        { type: 'sun', during: 'night' }
      ],
      actions: [
        { type: 'setSwitch', path: 'electrical.switches.bank.11.2.state' }
      ]
    })
    const genStart = baseRule({
      id: 'cccccccc-1111-2222-3333-444444444444',
      name: 'Gen start at 25%',
      conditions: [
        {
          type: 'numeric',
          path: 'electrical.batteries.60.capacity.stateOfCharge',
          operator: 'lt',
          threshold: 0.25,
          clearThreshold: 0.3
        }
      ],
      actions: [
        {
          type: 'pulse',
          path: 'electrical.switches.bank.50.1.state',
          seconds: 30
        },
        {
          type: 'notification',
          pathSuffix: 'generator.autostart',
          state: 'alert',
          method: ['visual'],
          message: 'Generator autostart triggered'
        }
      ],
      options: { holdTrueSeconds: 120, cooldownSeconds: 1800 }
    })
    const r = validateRulesDoc(doc(waterHeater, anchorLight, genStart))
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.warnings).toEqual([])
  })

  it('applies schema defaults without mutating the input', () => {
    const input = {
      version: 1,
      rules: [
        {
          id: 'aaaaaaaa-1111-2222-3333-444444444444',
          name: 'No enabled field',
          combinator: 'all',
          conditions: [
            {
              type: 'switch',
              path: 'electrical.switches.bank.6.1.state',
              equals: 1
            }
          ],
          actions: [
            { type: 'setSwitch', path: 'electrical.switches.bank.6.2.state' }
          ]
        }
      ]
    }
    const r = validateRulesDoc(input)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.doc.rules[0]?.enabled).toBe(true)
      expect(r.doc.rules[0]?.dryRun).toBe(false)
      expect(r.doc.rules[0]?.options).toEqual({})
    }
    expect(
      (input.rules[0] as Record<string, unknown>)['enabled']
    ).toBeUndefined()
  })

  it('rejects structurally invalid docs with paths', () => {
    const r = validateRulesDoc({
      version: 1,
      rules: [baseRule({ name: '' })]
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.some((e) => e.path.includes('/rules/0'))).toBe(true)
    }
  })

  it('rejects duplicate rule ids', () => {
    const r = validateRulesDoc(doc(baseRule(), baseRule({ name: 'Dup' })))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0]?.message).toContain('duplicate rule id')
    }
  })

  it('rejects hysteresis on the wrong side', () => {
    const bad = baseRule({
      conditions: [
        {
          type: 'numeric',
          path: 'a.b',
          operator: 'gt',
          threshold: 1,
          clearThreshold: 2
        }
      ]
    })
    const r = validateRulesDoc(doc(bad))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors[0]?.message).toContain('below the trigger')
    }

    const badLt = baseRule({
      conditions: [
        {
          type: 'numeric',
          path: 'a.b',
          operator: 'lt',
          threshold: 2,
          clearThreshold: 1
        }
      ]
    })
    const r2 = validateRulesDoc(doc(badLt))
    expect(r2.ok).toBe(false)

    const badEq = baseRule({
      conditions: [
        {
          type: 'numeric',
          path: 'a.b',
          operator: 'eq',
          threshold: 1,
          clearThreshold: 0.5
        }
      ]
    })
    expect(validateRulesDoc(doc(badEq)).ok).toBe(false)
  })

  it('rejects reassert without a setSwitch action', () => {
    const bad = baseRule({
      actions: [
        {
          type: 'pulse',
          path: 'electrical.switches.bank.50.1.state',
          seconds: 5
        }
      ],
      options: { reassertMinutes: 10 }
    })
    const r = validateRulesDoc(doc(bad))
    expect(r.ok).toBe(false)
  })

  it('warns on cooldown without a pulse action', () => {
    const odd = baseRule({ options: { cooldownSeconds: 60 } })
    const r = validateRulesDoc(doc(odd))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.some((w) => w.message.includes('cooldown'))).toBe(true)
    }
  })

  it('warns when two enabled rules drive the same switch', () => {
    const a = baseRule({ name: 'A' })
    const b = baseRule({
      id: 'bbbbbbbb-1111-2222-3333-444444444444',
      name: 'B'
    })
    const r = validateRulesDoc(doc(a, b))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.some((w) => w.message.includes('may fight'))).toBe(true)
    }

    const bDisabled = { ...b, enabled: false }
    const r2 = validateRulesDoc(doc(a, bDisabled))
    expect(r2.ok).toBe(true)
    if (r2.ok) {
      expect(r2.warnings.some((w) => w.message.includes('may fight'))).toBe(
        false
      )
    }
  })

  it('rejects out-of-range pulse duration', () => {
    const bad = baseRule({
      actions: [
        {
          type: 'pulse',
          path: 'electrical.switches.bank.50.1.state',
          seconds: 300
        }
      ]
    })
    expect(validateRulesDoc(doc(bad)).ok).toBe(false)
  })

  it('warns on a zero-length time window', () => {
    const odd = baseRule({
      conditions: [{ type: 'timeOfDay', from: '10:00', to: '10:00' }]
    })
    const r = validateRulesDoc(doc(odd))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warnings.some((w) => w.message.includes('never active'))).toBe(
        true
      )
    }
  })
})
