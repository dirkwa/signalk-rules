import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  PutExecutor,
  PulseManager,
  notificationDelta,
  type PutFn
} from '../src/actions.js'
import type { ActionRecord } from '../src/shared/state-types.js'

let mono = 0
let wall = 1_700_000_000_000

const advance = async (ms: number): Promise<void> => {
  mono += ms
  wall += ms
  await vi.advanceTimersByTimeAsync(ms)
}
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}

const okReply = { state: 'COMPLETED', statusCode: 200 }
const failReply = { state: 'COMPLETED', statusCode: 502, message: 'no handler' }

beforeEach(() => {
  vi.useFakeTimers()
  mono = 0
  wall = 1_700_000_000_000
})
afterEach(() => {
  vi.useRealTimers()
})

describe('PutExecutor', () => {
  it('resolves ok on an immediate COMPLETED reply', async () => {
    const calls: Array<{ path: string; value: unknown }> = []
    const put: PutFn = async (path, value) => {
      calls.push({ path, value })
      return okReply
    }
    const exec = new PutExecutor(put, { monoMs: () => mono })
    const done = vi.fn()
    exec.request('a.b', 1, done)
    await flush()
    expect(calls).toEqual([{ path: 'a.b', value: 1 }])
    expect(done).toHaveBeenCalledWith(true, undefined)
    exec.dispose()
  })

  it('waits for the terminal reply via updateCb after PENDING', async () => {
    let updateCb: ((reply?: unknown) => void) | null = null
    const put: PutFn = async (_path, _value, cb) => {
      updateCb = cb
      return { state: 'PENDING' }
    }
    const exec = new PutExecutor(put, { monoMs: () => mono })
    const done = vi.fn()
    exec.request('a.b', 1, done)
    await flush()
    expect(done).not.toHaveBeenCalled()
    updateCb?.({ state: 'PENDING' }) // non-terminal update: ignored
    await flush()
    expect(done).not.toHaveBeenCalled()
    updateCb?.(okReply)
    await flush()
    expect(done).toHaveBeenCalledWith(true, undefined)
    exec.dispose()
  })

  it('retries once on failure, then reports failure', async () => {
    let attempts = 0
    const put: PutFn = async () => {
      attempts++
      return failReply
    }
    const exec = new PutExecutor(put, {
      monoMs: () => mono,
      retryDelayMs: 5000,
      minIntervalMs: 0
    })
    const done = vi.fn()
    exec.request('a.b', 1, done)
    await flush()
    expect(attempts).toBe(1)
    expect(done).not.toHaveBeenCalled()
    await advance(5000)
    expect(attempts).toBe(2)
    expect(done).toHaveBeenCalledWith(false, 'no handler')
    exec.dispose()
  })

  it('times out a PUT that never answers', async () => {
    const put: PutFn = async () => ({ state: 'PENDING' })
    const exec = new PutExecutor(put, {
      monoMs: () => mono,
      timeoutMs: 1000,
      retryDelayMs: 500,
      minIntervalMs: 0
    })
    const done = vi.fn()
    exec.request('a.b', 1, done)
    await advance(1000) // first attempt times out
    await advance(500) // retry scheduled
    await advance(1000) // retry times out
    expect(done).toHaveBeenCalledWith(false, 'timeout')
    exec.dispose()
  })

  it('throttles per path with latest-wins queueing', async () => {
    const calls: unknown[] = []
    const put: PutFn = async (_p, value) => {
      calls.push(value)
      return okReply
    }
    const exec = new PutExecutor(put, {
      monoMs: () => mono,
      minIntervalMs: 2000
    })
    const done1 = vi.fn()
    const done2 = vi.fn()
    const done3 = vi.fn()
    exec.request('a.b', 1, done1)
    await flush()
    expect(calls).toEqual([1])

    exec.request('a.b', 0, done2)
    exec.request('a.b', 1, done3) // supersedes the queued 0
    await flush()
    expect(calls).toEqual([1])
    expect(done2).toHaveBeenCalledWith(false, 'superseded')

    await advance(2000)
    expect(calls).toEqual([1, 1])
    expect(done3).toHaveBeenCalledWith(true, undefined)
    exec.dispose()
  })
})

interface PulseHarness {
  pulses: PulseManager
  putCalls: Array<{ path: string; value: unknown }>
  directCalls: Array<{ path: string; value: unknown }>
  events: string[]
  records: Array<{ ruleId: string; rec: ActionRecord }>
  failNext: { count: number }
}

function pulseHarness(): PulseHarness {
  const putCalls: Array<{ path: string; value: unknown }> = []
  const directCalls: Array<{ path: string; value: unknown }> = []
  const events: string[] = []
  const records: Array<{ ruleId: string; rec: ActionRecord }> = []
  const failNext = { count: 0 }
  const put: PutFn = async (path, value) => {
    putCalls.push({ path, value })
    events.push(`put ${path}=${String(value)}`)
    if (failNext.count > 0) {
      failNext.count--
      return failReply
    }
    return okReply
  }
  const putDirect: PutFn = async (path, value) => {
    directCalls.push({ path, value })
    return okReply
  }
  const putExec = new PutExecutor(put, { monoMs: () => mono, minIntervalMs: 0 })
  const pulses = new PulseManager({
    putExec,
    putDirect,
    persist: () => events.push('persist'),
    monoMs: () => mono,
    wallMs: () => wall,
    log: () => undefined,
    onRecord: (ruleId, rec) => records.push({ ruleId, rec })
  })
  return { pulses, putCalls, directCalls, events, records, failNext }
}

describe('PulseManager', () => {
  it('persists the record BEFORE the ON-PUT, then reverts on schedule', async () => {
    const h = pulseHarness()
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    expect(h.events[0]).toBe('persist')
    expect(h.events[1]).toBe('put sw=1')
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
    expect(h.pulses.activeForRule('r1')?.target).toBe('sw')

    await advance(30_000)
    expect(h.putCalls).toEqual([
      { path: 'sw', value: 1 },
      { path: 'sw', value: 0 }
    ])
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
    expect(h.records.map((r) => r.rec.kind)).toEqual(['pulseStart', 'pulseEnd'])
  })

  it('reverts early when cancelled (falling edge)', async () => {
    const h = pulseHarness()
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    await advance(5000)
    h.pulses.cancelForRule('r1', 'condition cleared')
    await flush()
    expect(h.putCalls).toEqual([
      { path: 'sw', value: 1 },
      { path: 'sw', value: 0 }
    ])
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
    // The 30s timer must not fire a second revert
    await advance(60_000)
    expect(h.putCalls).toHaveLength(2)
  })

  it('cleans up without revert when the ON-PUT fails', async () => {
    const h = pulseHarness()
    h.failNext.count = 2 // attempt + executor retry
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    await advance(5000) // executor retry delay
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
    expect(h.records.map((r) => r.rec.result)).toEqual(['failed'])
    await advance(60_000)
    // never energized -> no revert PUT
    expect(h.putCalls.filter((c) => c.value === 0)).toHaveLength(0)
  })

  it('retries a failed revert until it succeeds', async () => {
    const h = pulseHarness()
    h.pulses.start('r1', 'sw', 1, 0, 10)
    await flush()
    h.failNext.count = 3 // revert attempt + executor retry + next attempt
    await advance(10_000) // pulse elapses; revert attempt 1 fails
    await advance(5000) // executor internal retry also fails -> manager waits
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
    await advance(5000) // manager retry: attempt fails again
    await advance(5000) // executor retry succeeds
    await flush()
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
    expect(h.putCalls.at(-1)).toEqual({ path: 'sw', value: 0 })
  })

  it('cooldown gates by wall clock and survives via lastPulses()', async () => {
    const h = pulseHarness()
    expect(h.pulses.cooldownRemainingMs('r1', 60)).toBe(0)
    h.pulses.markFired('r1')
    expect(h.pulses.cooldownRemainingMs('r1', 60)).toBe(60_000)
    await advance(45_000)
    expect(h.pulses.cooldownRemainingMs('r1', 60)).toBe(15_000)

    const snapshot = h.pulses.lastPulses()
    const h2 = pulseHarness()
    h2.pulses.loadLastPulses(snapshot)
    expect(h2.pulses.cooldownRemainingMs('r1', 60)).toBe(15_000)
  })

  it('restoreAndRevert reverts records found on disk', async () => {
    const h = pulseHarness()
    h.pulses.restoreAndRevert([
      { ruleId: 'r1', target: 'sw', revertValue: 0, deadlineWall: wall - 1000 }
    ])
    await flush()
    expect(h.putCalls).toEqual([{ path: 'sw', value: 0 }])
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
  })

  it('stopAll cancels timers and fires direct fail-safe reverts', async () => {
    const h = pulseHarness()
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    h.pulses.stopAll()
    await flush()
    expect(h.directCalls).toEqual([{ path: 'sw', value: 0 }])
    await advance(60_000)
    // pulse timer was cancelled: no throttled revert on top
    expect(h.putCalls).toEqual([{ path: 'sw', value: 1 }])
  })
})

describe('notificationDelta', () => {
  it('builds the zones-style delta payload', () => {
    expect(
      notificationDelta('generator.autostart', {
        state: 'alert',
        method: ['visual'],
        message: 'Generator autostart triggered'
      })
    ).toEqual({
      updates: [
        {
          values: [
            {
              path: 'notifications.generator.autostart',
              value: {
                state: 'alert',
                method: ['visual'],
                message: 'Generator autostart triggered'
              }
            }
          ]
        }
      ]
    })
  })
})
