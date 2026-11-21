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
  putExec: PutExecutor
}

function pulseHarness(
  opts: { direct?: PutFn; minIntervalMs?: number; put?: PutFn } = {}
): PulseHarness {
  const putCalls: Array<{ path: string; value: unknown }> = []
  const directCalls: Array<{ path: string; value: unknown }> = []
  const events: string[] = []
  const records: Array<{ ruleId: string; rec: ActionRecord }> = []
  const failNext = { count: 0 }
  const put: PutFn = async (path, value, cb) => {
    putCalls.push({ path, value })
    if (opts.put) return opts.put(path, value, cb)
    events.push(`put ${path}=${String(value)}`)
    if (failNext.count > 0) {
      failNext.count--
      return failReply
    }
    return okReply
  }
  const putDirect: PutFn = async (path, value, cb) => {
    directCalls.push({ path, value })
    return opts.direct ? opts.direct(path, value, cb) : okReply
  }
  const putExec = new PutExecutor(put, {
    monoMs: () => mono,
    minIntervalMs: opts.minIntervalMs ?? 0
  })
  const pulses = new PulseManager({
    putExec,
    putDirect,
    persist: () => events.push('persist'),
    monoMs: () => mono,
    wallMs: () => wall,
    log: () => undefined,
    onRecord: (ruleId, rec) => records.push({ ruleId, rec })
  })
  return { pulses, putCalls, directCalls, events, records, failNext, putExec }
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

  it('keeps a record saved with its ON-PUT unanswered until it switched off once more', async () => {
    const h = pulseHarness()
    h.pulses.restoreAndRevert([
      {
        ruleId: 'r1',
        target: 'sw',
        revertValue: 0,
        deadlineWall: wall,
        onPending: true
      }
    ])
    await flush()
    expect(h.putCalls).toHaveLength(1)
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
    expect(h.pulses.snapshot()[0]?.onPending).toBe(true)

    await advance(25_000)
    expect(h.putCalls).toHaveLength(2)
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
  })

  it('saves that a pulse has its ON-PUT unanswered until the answer comes', async () => {
    let answer: ((reply: unknown) => void) | undefined
    const h = pulseHarness({
      put: async (_p, _v, cb) => {
        answer = cb
        return { state: 'PENDING' }
      }
    })
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    expect(h.pulses.snapshot()[0]?.onPending).toBe(true)
    const saved = h.events.filter((e) => e === 'persist').length
    answer?.(okReply)
    await flush()
    expect(h.pulses.snapshot()[0]?.onPending).toBeUndefined()
    expect(h.events.filter((e) => e === 'persist').length).toBe(saved + 1)
  })

  it('after a stand-down, waits for the final reply of a pending revert and retries a failed one', async () => {
    let attempt = 0
    const h = pulseHarness({
      direct: (_path, _value, cb) => {
        attempt++
        if (attempt === 1) setTimeout(() => cb(failReply), 1000)
        return Promise.resolve(
          attempt === 1 ? { state: 'PENDING', statusCode: 202 } : okReply
        )
      }
    })
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    h.pulses.revertAllUntilDone()
    await flush()
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
    await advance(1000)
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
    await advance(5000)
    expect(h.directCalls).toHaveLength(2)
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
  })

  it('after a stand-down, tries again when a pending revert never gets its final reply', async () => {
    let attempt = 0
    const h = pulseHarness({
      direct: () =>
        Promise.resolve(
          ++attempt === 1 ? { state: 'PENDING', statusCode: 202 } : okReply
        )
    })
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    h.pulses.revertAllUntilDone()
    await advance(25_000)
    await advance(5000)
    expect(h.directCalls).toHaveLength(2)
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
  })

  it('keeps the record of a stood-down pulse whose ON-PUT was still queued', async () => {
    let attempt = 0
    const h = pulseHarness({
      minIntervalMs: 2000,
      direct: () =>
        ++attempt === 1
          ? Promise.reject(new Error('bus busy'))
          : Promise.resolve(okReply)
    })
    h.putExec.request('sw', 0, () => undefined)
    await flush()
    h.pulses.start('r1', 'sw', 1, 0, 30)
    h.pulses.revertAllUntilDone()
    h.putExec.dispose()
    await flush()
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
    await advance(5000)
    expect(h.directCalls).toHaveLength(2)
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
  })

  const pendingOn = (): {
    answers: Array<(reply: unknown) => void>
    put: PutFn
  } => {
    const answers: Array<(reply: unknown) => void> = []
    return {
      answers,
      put: async (_p, value, cb) => {
        if (value === 0) return okReply
        if (cb) answers.push(cb)
        return { state: 'PENDING' }
      }
    }
  }

  it('keeps the record of a pulse stood down with its ON unanswered until the ON goes through, then switches off again', async () => {
    const on = pendingOn()
    const h = pulseHarness({ put: on.put })
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    h.pulses.revertAllUntilDone()
    h.putExec.dispose()
    await advance(60_000)
    expect(h.directCalls).toHaveLength(1)
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)

    on.answers[0]?.(okReply)
    await flush()
    expect(h.directCalls).toHaveLength(2)
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
  })

  it('keeps the record while any ON attempt may still land after a stand-down', async () => {
    const on = pendingOn()
    const h = pulseHarness({ put: on.put })
    h.pulses.start('r1', 'sw', 1, 0, 120)
    await flush()
    await advance(25_000 + 5000)
    expect(on.answers).toHaveLength(2)
    h.pulses.revertAllUntilDone()
    h.putExec.dispose()
    await flush()

    on.answers[0]?.(failReply)
    await flush()
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
    on.answers[1]?.(okReply)
    await flush()
    expect(h.directCalls).toHaveLength(2)
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
  })

  it('takes a terminal answer sent both ways as one', async () => {
    const h = pulseHarness({
      put: async (_p, _v, cb) => {
        cb?.(okReply)
        return okReply
      }
    })
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await advance(10_000)
    expect(h.putCalls).toEqual([{ path: 'sw', value: 1 }])
    expect(h.pulses.isActive('r1', 'sw')).toBe(true)
  })

  it('retries the OFF for a late ON once its engine was replaced, until it goes through', async () => {
    const on = pendingOn()
    let direct = 0
    const h = pulseHarness({
      put: on.put,
      direct: () =>
        ++direct === 2
          ? Promise.reject(new Error('bus busy'))
          : Promise.resolve(okReply)
    })
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    h.pulses.revertAllUntilDone()
    h.putExec.dispose()
    await flush()
    h.pulses.abandonReverts()
    on.answers[0]?.(okReply)
    await flush()
    expect(h.directCalls).toHaveLength(2)
    await advance(5000)
    expect(h.directCalls).toHaveLength(3)
    await advance(60_000)
    expect(h.directCalls).toHaveLength(3)
  })

  it('switches off an ON that went through after it had timed out', async () => {
    const on = pendingOn()
    const h = pulseHarness({ put: on.put })
    h.pulses.start('r1', 'sw', 1, 0, 120)
    await flush()
    await advance(25_000 + 5000 + 25_000)
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)

    on.answers[0]?.(okReply)
    await advance(2000)
    expect(h.putCalls.at(-1)).toEqual({ path: 'sw', value: 0 })
    expect(h.pulses.isActive('r1', 'sw')).toBe(false)
    expect(h.records.at(-1)?.rec.kind).toBe('pulseEnd')
  })

  it('still switches off an ON that goes through once its engine was replaced', async () => {
    const on = pendingOn()
    const h = pulseHarness({ put: on.put })
    h.pulses.start('r1', 'sw', 1, 0, 30)
    await flush()
    h.pulses.revertAllUntilDone()
    h.putExec.dispose()
    await flush()
    h.pulses.abandonReverts()
    on.answers[0]?.(okReply)
    await flush()
    expect(h.directCalls).toHaveLength(2)
  })

  it('leaves no retry running once a stood-down revert is abandoned', async () => {
    const h = pulseHarness({
      minIntervalMs: 60_000,
      direct: () => Promise.reject(new Error('bus busy'))
    })
    h.pulses.start('r1', 'sw', 1, 0, 1)
    await advance(1000)
    h.pulses.revertAllUntilDone()
    h.putExec.dispose()
    await advance(5000)
    expect(h.directCalls).toHaveLength(2)
    h.pulses.abandonReverts()
    await advance(60_000)
    expect(h.directCalls).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
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
