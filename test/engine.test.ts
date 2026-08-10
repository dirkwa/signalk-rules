import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Engine, type EngineClock, type EngineDeps } from '../src/engine.js'
import { RulesStore } from '../src/store.js'
import type { RuleT, RulesDocT } from '../src/shared/schemas.js'

class FakeClock implements EngineClock {
  mono = 0
  wall = new Date('2026-08-10T12:00:00Z').getTime()
  monoMs(): number {
    return this.mono
  }
  wallMs(): number {
    return this.wall
  }
  wallDate(): Date {
    return new Date(this.wall)
  }
  advance(ms: number): void {
    this.mono += ms
    this.wall += ms
  }
}

interface Harness {
  engine: Engine
  clock: FakeClock
  push(path: string, value: unknown): void
  puts: Array<{ path: string; value: unknown }>
  deltas: object[]
  model: Record<string, unknown>
  dir: string
}

const SOLAR = 'electrical.solar.258.current'
const HEATER = 'electrical.switches.bank.10.3.state'

function waterHeaterRule(over: Partial<RuleT> = {}): RuleT {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    name: 'Water heater on solar',
    enabled: true,
    dryRun: false,
    combinator: 'all',
    conditions: [
      {
        type: 'numeric',
        path: SOLAR,
        operator: 'gt',
        threshold: 4,
        clearThreshold: 1
      }
    ],
    actions: [{ type: 'setSwitch', path: HEATER }],
    options: {},
    ...over
  }
}

const doc = (...rules: RuleT[]): RulesDocT => ({ version: 1, rules })

function harness(model: Record<string, unknown> = {}): Harness {
  const clock = new FakeClock()
  const subs = new Map<string, (value: unknown) => void>()
  const puts: Array<{ path: string; value: unknown }> = []
  const deltas: object[] = []
  const dir = mkdtempSync(path.join(tmpdir(), 'sk-rules-test-'))

  const deps: EngineDeps = {
    subscribe: (p, cb) => {
      subs.set(p, cb)
      return () => subs.delete(p)
    },
    getCurrent: (p) => {
      const v = model[p]
      return v === undefined ? undefined : { value: v }
    },
    put: async (p, value) => {
      puts.push({ path: p, value })
      model[p] = value
      // Real switching echoes the new state back as a bus delta.
      subs.get(p)?.(value)
      return { state: 'COMPLETED', statusCode: 200 }
    },
    sendDelta: (d) => deltas.push(d),
    setStatus: () => undefined,
    setError: () => undefined,
    debug: () => undefined,
    store: new RulesStore(dir),
    clock,
    scheduleTick: false
  }
  const engine = new Engine(
    { tickSeconds: 1, defaultStaleSeconds: 300, verbose: false },
    deps
  )
  return {
    engine,
    clock,
    push: (p, value) => {
      model[p] = value
      subs.get(p)?.(value)
    },
    puts,
    deltas,
    model,
    dir
  }
}

let h: Harness
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  h.engine.stop()
  rmSync(h.dir, { recursive: true, force: true })
  vi.useRealTimers()
})

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('Engine — follow rules', () => {
  it('drives the water heater from solar current with hysteresis', async () => {
    h = harness({ [HEATER]: 0 })
    h.engine.start(doc(waterHeaterRule()))
    await flush()
    // No solar data yet: decision unknown, nothing sent
    expect(h.puts).toEqual([])

    h.push(SOLAR, 5)
    await flush()
    expect(h.puts).toEqual([{ path: HEATER, value: 1 }])

    // Dip below trigger but above clear threshold: latched, no traffic
    h.clock.advance(5000)
    h.push(SOLAR, 2)
    await flush()
    expect(h.puts).toHaveLength(1)

    // Below clear threshold: off
    h.clock.advance(5000)
    h.push(SOLAR, 0.3)
    await flush()
    expect(h.puts).toEqual([
      { path: HEATER, value: 1 },
      { path: HEATER, value: 0 }
    ])
  })

  it('suppresses the startup PUT when the switch already agrees', async () => {
    h = harness({ [HEATER]: 1, [SOLAR]: 6 })
    h.engine.start(doc(waterHeaterRule()))
    await flush()
    expect(h.puts).toEqual([])
    const state = h.engine.getState()
    expect(state.rules[0]?.decision).toBe('on')
    expect(state.rules[0]?.lastActions[0]?.kind).toBe('skippedAlreadySet')
  })

  it('lets a manual override stick until the next transition', async () => {
    h = harness({ [HEATER]: 0 })
    h.engine.start(doc(waterHeaterRule()))
    h.push(SOLAR, 5)
    await flush()
    expect(h.puts).toHaveLength(1)

    // Someone turns the heater off at the panel; solar keeps shining.
    h.clock.advance(60_000)
    h.push(HEATER, 0)
    h.push(SOLAR, 6)
    h.push(SOLAR, 7)
    await flush()
    expect(h.puts).toHaveLength(1) // no re-PUT: decision didn't change

    // Falling edge finds the switch already off: still no traffic.
    h.clock.advance(5000)
    h.push(SOLAR, 0.2)
    await flush()
    expect(h.puts).toHaveLength(1)
    expect(h.engine.getState().rules[0]?.lastActions[0]?.kind).toBe(
      'skippedAlreadySet'
    )

    // The next rising transition re-takes control.
    h.clock.advance(5000)
    h.push(SOLAR, 6)
    await vi.advanceTimersByTimeAsync(2100) // PUT throttle spacing
    expect(h.puts.at(-1)).toEqual({ path: HEATER, value: 1 })
  })

  it('reasserts on schedule when configured', async () => {
    h = harness({ [HEATER]: 0 })
    h.engine.start(doc(waterHeaterRule({ options: { reassertMinutes: 1 } })))
    h.push(SOLAR, 5)
    await flush()
    expect(h.puts).toHaveLength(1)

    // Manual off, then the reassert interval elapses.
    h.push(HEATER, 0)
    h.clock.advance(61_000)
    h.engine.tick()
    await vi.advanceTimersByTimeAsync(2100) // PUT throttle spacing
    expect(h.puts.at(-1)).toEqual({ path: HEATER, value: 1 })
  })

  it('holds the last decision while inputs are stale', async () => {
    h = harness({ [HEATER]: 0 })
    h.engine.start(doc(waterHeaterRule()))
    h.push(SOLAR, 5)
    await flush()
    expect(h.puts).toHaveLength(1)

    // Solar path goes silent past the TTL
    h.clock.advance(301_000)
    h.engine.tick()
    await flush()
    const state = h.engine.getState()
    expect(state.rules[0]?.raw).toBe('unknown')
    expect(state.rules[0]?.decision).toBe('on') // held
    expect(state.rules[0]?.conditions[0]?.stale).toBe(true)
    expect(h.puts).toHaveLength(1) // no flapping
  })

  it('dry-run records but never PUTs', async () => {
    h = harness({ [HEATER]: 0 })
    h.engine.start(doc(waterHeaterRule({ dryRun: true })))
    h.push(SOLAR, 5)
    await flush()
    expect(h.puts).toEqual([])
    const state = h.engine.getState()
    expect(state.rules[0]?.lastActions[0]?.kind).toBe('dryRun')
  })
})

describe('Engine — pulse and notification rules', () => {
  const SOC = 'electrical.batteries.60.capacity.stateOfCharge'
  const STARTER = 'electrical.switches.bank.50.1.state'

  const genRule = (over: Partial<RuleT> = {}): RuleT => ({
    id: 'cccccccc-1111-2222-3333-444444444444',
    name: 'Gen start',
    enabled: true,
    dryRun: false,
    combinator: 'all',
    conditions: [
      {
        type: 'numeric',
        path: SOC,
        operator: 'lt',
        threshold: 0.25,
        clearThreshold: 0.3
      }
    ],
    actions: [
      { type: 'pulse', path: STARTER, seconds: 30 },
      {
        type: 'notification',
        pathSuffix: 'generator.autostart',
        state: 'alert',
        method: ['visual'],
        message: 'Generator autostart'
      }
    ],
    options: { cooldownSeconds: 1800 },
    ...over
  })

  it('pulses on the rising edge, reverts after the duration', async () => {
    h = harness({ [STARTER]: 0 })
    h.engine.start(doc(genRule()))
    h.push(SOC, 0.2)
    await flush()
    expect(h.puts).toEqual([{ path: STARTER, value: 1 }])
    expect(h.deltas).toHaveLength(1) // notification raised

    h.clock.advance(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.puts.at(-1)).toEqual({ path: STARTER, value: 0 })
  })

  it('enforces cooldown across edges and persists it', async () => {
    h = harness({ [STARTER]: 0 })
    h.engine.start(doc(genRule()))
    h.push(SOC, 0.2)
    await flush()
    h.clock.advance(30_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.puts).toHaveLength(2) // on + revert

    // SOC recovers past clear, then drops again inside the cooldown
    h.push(SOC, 0.35)
    await flush()
    h.clock.advance(60_000)
    h.push(SOC, 0.2)
    await flush()
    expect(h.puts).toHaveLength(2) // suppressed
    const state = h.engine.getState()
    expect(
      state.rules[0]?.lastActions.some((a) => a.kind === 'suppressedCooldown')
    ).toBe(true)
    expect(state.rules[0]?.cooldownRemainingMs ?? 0).toBeGreaterThan(0)

    // Past the cooldown it fires again
    h.push(SOC, 0.35)
    await flush()
    h.clock.advance(1800_000)
    h.push(SOC, 0.2)
    await vi.advanceTimersByTimeAsync(2100)
    expect(h.puts.at(-1)).toEqual({ path: STARTER, value: 1 })
  })

  it('clears the notification when the rule is paused via reload', async () => {
    h = harness({ [STARTER]: 0 })
    const rule = genRule()
    h.engine.start(doc(rule))
    h.push(SOC, 0.2)
    await flush()
    expect(h.deltas).toHaveLength(1)

    h.engine.reload(doc({ ...rule, enabled: false }))
    await flush()
    expect(h.deltas).toHaveLength(2)
    const last = h.deltas.at(-1) as {
      updates: Array<{ values: Array<{ value: { state: string } }> }>
    }
    expect(last.updates[0]?.values[0]?.value.state).toBe('normal')
  })

  it('recovers a crashed pulse on the next start', async () => {
    h = harness({ [STARTER]: 1 })
    const store = new RulesStore(h.dir)
    store.saveRuntimeStateSync({
      pulses: [
        {
          ruleId: 'cccccccc-1111-2222-3333-444444444444',
          target: STARTER,
          revertValue: 0,
          deadlineWall: h.clock.wallMs() - 1000
        }
      ],
      lastPulseAt: {},
      lastPosition: null
    })
    h.engine.start(doc(genRule()))
    await flush()
    expect(h.puts[0]).toEqual({ path: STARTER, value: 0 })
  })
})

describe('Engine — reload and state', () => {
  it('reload swaps rules without leaking subscriptions', async () => {
    h = harness({ [HEATER]: 0 })
    h.engine.start(doc(waterHeaterRule()))
    h.push(SOLAR, 5)
    await flush()
    expect(h.puts).toHaveLength(1)

    // Remove the rule; pushing solar must no longer do anything
    h.engine.reload(doc())
    h.push(SOLAR, 0.1)
    h.push(SOLAR, 9)
    await flush()
    expect(h.puts).toHaveLength(1)
    expect(h.engine.getState().rules).toHaveLength(0)
  })

  it('getState reports a paused rule with live condition display', async () => {
    h = harness({ [HEATER]: 0, [SOLAR]: 5 })
    h.engine.start(doc(waterHeaterRule({ enabled: false })))
    await flush()
    expect(h.puts).toEqual([])
    const state = h.engine.getState()
    expect(state.rules[0]?.enabled).toBe(false)
    expect(state.rules[0]?.conditions[0]?.value).toBe(5)
    expect(state.rules[0]?.decision).toBe('unknown')
  })

  it('testRule evaluates without mutating latches or acting', async () => {
    h = harness({ [HEATER]: 0, [SOLAR]: 5 })
    h.engine.start(doc(waterHeaterRule({ dryRun: false })))
    await flush()
    const before = h.puts.length
    const result = h.engine.testRule('aaaaaaaa-1111-2222-3333-444444444444')
    expect(result?.raw).toBe('true')
    expect(result?.wouldDo[0]).toContain('set')
    expect(h.puts).toHaveLength(before)
    expect(h.engine.testRule('nope')).toBe(null)
  })
})
