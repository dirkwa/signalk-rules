import { describe, it, expect } from 'vitest'
import { RuleRuntime, type RuleClock } from '../src/rule-runtime.js'
import type { RuleT } from '../src/shared/schemas.js'

class FakeClock implements RuleClock {
  mono = 0
  wall = 1_700_000_000_000
  monoMs(): number {
    return this.mono
  }
  wallMs(): number {
    return this.wall
  }
  advance(ms: number): void {
    this.mono += ms
    this.wall += ms
  }
}

const rule = (options: RuleT['options'] = {}): RuleT => ({
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  name: 'r',
  enabled: true,
  dryRun: false,
  combinator: 'all',
  conditions: [{ type: 'switch', path: 's', equals: 1 }],
  actions: [{ type: 'setSwitch', path: 't' }],
  options
})

describe('RuleRuntime', () => {
  it('commits immediately with zero hold and emits edges', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule(), clock)
    expect(rt.decision).toBe('unknown')

    expect(rt.advance('true')).toEqual([{ kind: 'edge', edge: 'rising' }])
    expect(rt.decision).toBe('on')

    expect(rt.advance('true')).toEqual([])

    expect(rt.advance('false')).toEqual([{ kind: 'edge', edge: 'falling' }])
    expect(rt.decision).toBe('off')
  })

  it('waits out holdTrueSeconds before committing', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule({ holdTrueSeconds: 60 }), clock)

    expect(rt.advance('true')).toEqual([])
    expect(rt.decision).toBe('unknown')
    expect(rt.pendingHoldRemainingMs()).toBe(60_000)

    clock.advance(30_000)
    expect(rt.advance('true')).toEqual([])
    expect(rt.pendingHoldRemainingMs()).toBe(30_000)

    clock.advance(30_000)
    expect(rt.advance('true')).toEqual([{ kind: 'edge', edge: 'rising' }])
    expect(rt.decision).toBe('on')
    expect(rt.pendingHoldRemainingMs()).toBe(null)
  })

  it('cancels a pending hold when raw flips back', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule({ holdTrueSeconds: 60 }), clock)

    // Baseline the decision at off first (zero hold on false).
    rt.advance('false')
    expect(rt.decision).toBe('off')

    rt.advance('true')
    clock.advance(59_000)
    expect(rt.advance('false')).toEqual([])
    expect(rt.pending).toBe(null)
    expect(rt.decision).toBe('off')

    // Restarting requires the full hold again
    rt.advance('true')
    clock.advance(59_000)
    expect(rt.advance('true')).toEqual([])
    clock.advance(1_000)
    expect(rt.advance('true')).toEqual([{ kind: 'edge', edge: 'rising' }])
  })

  it('commits the first definite decision from unknown (startup baseline)', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule(), clock)
    // Even a "false" start is an edge — the engine's actual-state
    // comparison suppresses the PUT when the switch already agrees.
    expect(rt.advance('false')).toEqual([{ kind: 'edge', edge: 'falling' }])
    expect(rt.decision).toBe('off')
  })

  it('unknown cancels pending and holds the committed decision', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule({ holdFalseSeconds: 30 }), clock)

    rt.advance('true')
    expect(rt.decision).toBe('on')

    rt.advance('false')
    expect(rt.pending).not.toBe(null)
    expect(rt.advance('unknown')).toEqual([])
    expect(rt.pending).toBe(null)
    expect(rt.decision).toBe('on')

    // Data returns false: hold starts fresh
    rt.advance('false')
    clock.advance(30_000)
    expect(rt.advance('false')).toEqual([{ kind: 'edge', edge: 'falling' }])
  })

  it('distinct holds for on and off directions', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(
      rule({ holdTrueSeconds: 10, holdFalseSeconds: 20 }),
      clock
    )
    rt.advance('true')
    clock.advance(10_000)
    expect(rt.advance('true')).toEqual([{ kind: 'edge', edge: 'rising' }])

    rt.advance('false')
    clock.advance(10_000)
    expect(rt.advance('false')).toEqual([])
    clock.advance(10_000)
    expect(rt.advance('false')).toEqual([{ kind: 'edge', edge: 'falling' }])
  })

  it('fires reassert on schedule while decision is definite', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule({ reassertMinutes: 1 }), clock)

    expect(rt.advance('true')).toEqual([{ kind: 'edge', edge: 'rising' }])
    expect(rt.advance('true')).toEqual([])

    clock.advance(59_999)
    expect(rt.advance('true')).toEqual([])
    clock.advance(1)
    expect(rt.advance('true')).toEqual([{ kind: 'reassert' }])

    // Rearmed for the next interval
    clock.advance(60_000)
    expect(rt.advance('true')).toEqual([{ kind: 'reassert' }])

    // Continues even while raw is unknown (decision is held definite)
    clock.advance(60_000)
    expect(rt.advance('unknown')).toEqual([{ kind: 'reassert' }])
  })

  it('does not reassert before the first commit', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule({ reassertMinutes: 1 }), clock)
    clock.advance(600_000)
    expect(rt.advance('unknown')).toEqual([])
  })

  it('keeps only the last five action records', () => {
    const clock = new FakeClock()
    const rt = new RuleRuntime(rule(), clock)
    for (let i = 0; i < 8; i++) {
      rt.recordAction({
        ts: i,
        kind: 'put',
        target: 't',
        value: i,
        result: 'ok'
      })
    }
    expect(rt.lastActions).toHaveLength(5)
    expect(rt.lastActions[0]?.value).toBe(7)
  })
})
