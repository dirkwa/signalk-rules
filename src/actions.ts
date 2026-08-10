import type { ActionRecord } from './shared/state-types.js'

/** Shape of app.putSelfPath: promise resolves with the first Reply
 *  (possibly PENDING); the terminal Reply arrives via updateCb. */
export type PutFn = (
  path: string,
  value: unknown,
  updateCb: (reply?: unknown) => void
) => Promise<unknown>

export type DoneFn = (ok: boolean, detail?: string) => void

interface PathState {
  lastSentMono: number
  sending: boolean
  /** The latest desired value not yet transmitted — always replaceable. */
  next: { value: unknown; done: DoneFn } | null
  flushScheduled: boolean
}

export interface PutExecutorOptions {
  /** Minimum spacing between PUTs to the same path (bus protection). */
  minIntervalMs?: number
  /** How long to wait for a terminal reply (n2k-switching confirms
   *  within ~20 s). */
  timeoutMs?: number
  /** One automatic retry after this delay on failure. */
  retryDelayMs?: number
  monoMs?: () => number
  log?: (msg: string) => void
}

function isTerminalReply(
  reply: unknown
): { ok: boolean; detail?: string } | null {
  if (reply === null || typeof reply !== 'object') return null
  const r = reply as {
    state?: unknown
    statusCode?: unknown
    message?: unknown
  }
  if (r.state !== 'COMPLETED') return null
  const code = typeof r.statusCode === 'number' ? r.statusCode : 500
  const ok = code >= 200 && code < 300
  const message = typeof r.message === 'string' ? r.message : undefined
  return { ok, detail: ok ? undefined : (message ?? `status ${code}`) }
}

/**
 * Serializes and throttles PUTs per path: at most one in flight, at
 * least `minIntervalMs` apart, latest-wins queueing, one retry.
 * A misconfigured rule pair can never storm the N2K bus.
 */
export class PutExecutor {
  private readonly states = new Map<string, PathState>()
  private readonly timers = new Set<NodeJS.Timeout>()
  private disposed = false

  private readonly minIntervalMs: number
  private readonly timeoutMs: number
  private readonly retryDelayMs: number
  private readonly monoMs: () => number
  private readonly log: (msg: string) => void

  constructor(
    private readonly put: PutFn,
    opts: PutExecutorOptions = {}
  ) {
    this.minIntervalMs = opts.minIntervalMs ?? 2000
    this.timeoutMs = opts.timeoutMs ?? 25_000
    this.retryDelayMs = opts.retryDelayMs ?? 5000
    this.monoMs = opts.monoMs ?? (() => performance.now())
    this.log = opts.log ?? (() => undefined)
  }

  request(path: string, value: unknown, done: DoneFn): void {
    if (this.disposed) {
      done(false, 'stopped')
      return
    }
    let st = this.states.get(path)
    if (st === undefined) {
      st = {
        lastSentMono: Number.NEGATIVE_INFINITY,
        sending: false,
        next: null,
        flushScheduled: false
      }
      this.states.set(path, st)
    }
    // Latest wins — an older untransmitted value is obsolete by definition.
    st.next?.done(false, 'superseded')
    st.next = { value, done }
    this.pump(path, st)
  }

  dispose(): void {
    this.disposed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const st of this.states.values()) {
      st.next?.done(false, 'stopped')
      st.next = null
    }
  }

  private schedule(delayMs: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (!this.disposed) fn()
    }, delayMs)
    this.timers.add(t)
  }

  /** Transmit `next` as soon as the in-flight send and the per-path
   *  spacing allow. */
  private pump(path: string, st: PathState): void {
    if (st.sending || st.next === null) return
    const wait = this.minIntervalMs - (this.monoMs() - st.lastSentMono)
    if (wait > 0) {
      if (!st.flushScheduled) {
        st.flushScheduled = true
        this.schedule(wait, () => {
          st.flushScheduled = false
          this.pump(path, st)
        })
      }
      return
    }
    const job = st.next
    st.next = null
    st.sending = true
    const send = (attempt: number): void => {
      st.lastSentMono = this.monoMs()
      void this.doPut(path, job.value).then((result) => {
        if (this.disposed) return
        if (!result.ok && attempt === 0) {
          this.log(
            `PUT ${path}=${String(job.value)} failed (${result.detail ?? ''}), retrying`
          )
          this.schedule(this.retryDelayMs, () => send(1))
          return
        }
        st.sending = false
        job.done(result.ok, result.detail)
        this.pump(path, st)
      })
    }
    send(0)
  }

  /** One PUT attempt, resolved on the terminal reply or timeout. */
  private doPut(
    path: string,
    value: unknown
  ): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (ok: boolean, detail?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.timers.delete(timer)
        resolve({ ok, detail })
      }
      const timer = setTimeout(() => settle(false, 'timeout'), this.timeoutMs)
      this.timers.add(timer)

      const onReply = (reply?: unknown): void => {
        const terminal = isTerminalReply(reply)
        if (terminal !== null) settle(terminal.ok, terminal.detail)
      }
      try {
        this.put(path, value, onReply).then(onReply, (err: unknown) => {
          settle(false, err instanceof Error ? err.message : String(err))
        })
      } catch (err) {
        settle(false, err instanceof Error ? err.message : String(err))
      }
    })
  }
}

// ---------------------------------------------------------------------------

export interface PersistedPulse {
  ruleId: string
  target: string
  revertValue: number
  deadlineWall: number
}

interface ActivePulse extends PersistedPulse {
  pulseTimer: NodeJS.Timeout | null
  revertRetryTimer: NodeJS.Timeout | null
  reverting: boolean
}

export interface PulseManagerDeps {
  putExec: PutExecutor
  /** Raw un-throttled PUT — used only for stop-time fail-safe reverts. */
  putDirect: PutFn
  /** Synchronously persist runtime state (called BEFORE the ON-PUT so a
   *  crash mid-pulse is recoverable on next start). */
  persist: () => void
  monoMs: () => number
  wallMs: () => number
  log: (msg: string) => void
  onRecord: (ruleId: string, rec: ActionRecord) => void
}

const REVERT_RETRY_MS = 5000

/**
 * Owns active pulses and the per-rule cooldown clock. The revert is the
 * one PUT that is never given up on: it retries every 5 s until it
 * succeeds, its record survives restarts, and start-up reverts any
 * record found on disk before doing anything else.
 */
export class PulseManager {
  private readonly active = new Map<string, ActivePulse>()
  private readonly lastPulseAtWall = new Map<string, number>()

  constructor(private readonly deps: PulseManagerDeps) {}

  private key(ruleId: string, target: string): string {
    return `${ruleId}|${target}`
  }

  snapshot(): PersistedPulse[] {
    return [...this.active.values()].map(
      ({ ruleId, target, revertValue, deadlineWall }) => ({
        ruleId,
        target,
        revertValue,
        deadlineWall
      })
    )
  }

  lastPulses(): Record<string, number> {
    return Object.fromEntries(this.lastPulseAtWall)
  }

  loadLastPulses(records: Record<string, number>): void {
    for (const [ruleId, ts] of Object.entries(records)) {
      if (typeof ts === 'number') this.lastPulseAtWall.set(ruleId, ts)
    }
  }

  /** Start-up fail-safe: any pulse record on disk means a previous run
   *  died mid-pulse — revert it before the engine does anything else. */
  restoreAndRevert(records: PersistedPulse[]): void {
    for (const rec of records) {
      this.deps.log(
        `reverting pulse left over from previous run: ${rec.target} -> ${rec.revertValue}`
      )
      const pulse: ActivePulse = {
        ...rec,
        pulseTimer: null,
        revertRetryTimer: null,
        reverting: true
      }
      this.active.set(this.key(rec.ruleId, rec.target), pulse)
      this.revert(pulse, 'recovered after restart')
    }
  }

  cooldownRemainingMs(ruleId: string, cooldownSeconds: number): number {
    const last = this.lastPulseAtWall.get(ruleId)
    if (last === undefined) return 0
    return Math.max(0, last + cooldownSeconds * 1000 - this.deps.wallMs())
  }

  markFired(ruleId: string): void {
    this.lastPulseAtWall.set(ruleId, this.deps.wallMs())
    this.deps.persist()
  }

  isActive(ruleId: string, target: string): boolean {
    return this.active.has(this.key(ruleId, target))
  }

  activeForRule(
    ruleId: string
  ): { target: string; activeUntilWall: number } | undefined {
    for (const p of this.active.values()) {
      if (p.ruleId === ruleId && !p.reverting) {
        return { target: p.target, activeUntilWall: p.deadlineWall }
      }
    }
    return undefined
  }

  start(
    ruleId: string,
    target: string,
    value: number,
    revertValue: number,
    seconds: number
  ): void {
    const key = this.key(ruleId, target)
    if (this.active.has(key)) return

    const pulse: ActivePulse = {
      ruleId,
      target,
      revertValue,
      deadlineWall: this.deps.wallMs() + seconds * 1000,
      pulseTimer: null,
      revertRetryTimer: null,
      reverting: false
    }
    // Record on disk BEFORE energizing the output: if we die between
    // these two lines the next start reverts a switch that never went
    // on — harmless. The other order leaves a starter engaged.
    this.active.set(key, pulse)
    this.deps.persist()

    this.deps.putExec.request(target, value, (ok, detail) => {
      const current = this.active.get(key)
      if (current !== pulse) return
      if (!ok) {
        // Never energized: no revert needed. Cooldown stays consumed —
        // under-firing a starter is safer than double-firing it.
        if (pulse.pulseTimer !== null) clearTimeout(pulse.pulseTimer)
        this.active.delete(key)
        this.deps.persist()
        this.deps.onRecord(ruleId, {
          ts: this.deps.wallMs(),
          kind: 'put',
          target,
          value,
          result: 'failed',
          detail
        })
        return
      }
      this.deps.onRecord(ruleId, {
        ts: this.deps.wallMs(),
        kind: 'pulseStart',
        target,
        value,
        result: 'ok'
      })
    })

    pulse.pulseTimer = setTimeout(() => {
      pulse.pulseTimer = null
      this.revert(pulse, 'pulse complete')
    }, seconds * 1000)
  }

  /** Falling edge, rule deleted/disabled: end any active pulse early. */
  cancelForRule(ruleId: string, reason: string): void {
    for (const pulse of [...this.active.values()]) {
      if (pulse.ruleId === ruleId && !pulse.reverting) {
        if (pulse.pulseTimer !== null) {
          clearTimeout(pulse.pulseTimer)
          pulse.pulseTimer = null
        }
        this.revert(pulse, reason)
      }
    }
  }

  ruleIdsWithActivePulses(): Set<string> {
    return new Set([...this.active.values()].map((p) => p.ruleId))
  }

  private revert(pulse: ActivePulse, reason: string): void {
    pulse.reverting = true
    this.deps.putExec.request(pulse.target, pulse.revertValue, (ok, detail) => {
      const key = this.key(pulse.ruleId, pulse.target)
      if (this.active.get(key) !== pulse) return
      if (ok) {
        this.active.delete(key)
        this.deps.persist()
        this.deps.onRecord(pulse.ruleId, {
          ts: this.deps.wallMs(),
          kind: 'pulseEnd',
          target: pulse.target,
          value: pulse.revertValue,
          result: 'ok',
          detail: reason
        })
        return
      }
      // Reverting is the one thing we must not give up on.
      this.deps.log(
        `pulse revert ${pulse.target} -> ${pulse.revertValue} failed (${detail ?? ''}), retrying`
      )
      pulse.revertRetryTimer = setTimeout(() => {
        pulse.revertRetryTimer = null
        this.revert(pulse, reason)
      }, REVERT_RETRY_MS)
    })
  }

  /**
   * Plugin stop: cancel all timers and issue one direct fail-safe
   * revert per still-active pulse. Failed reverts stay on disk and are
   * retried by the next start's restoreAndRevert.
   */
  stopAll(): void {
    for (const pulse of this.active.values()) {
      if (pulse.pulseTimer !== null) clearTimeout(pulse.pulseTimer)
      if (pulse.revertRetryTimer !== null) clearTimeout(pulse.revertRetryTimer)
      pulse.pulseTimer = null
      pulse.revertRetryTimer = null
      const key = this.key(pulse.ruleId, pulse.target)
      this.deps
        .putDirect(pulse.target, pulse.revertValue, () => undefined)
        .then(() => {
          this.active.delete(key)
          this.deps.persist()
        })
        .catch((err: unknown) => {
          this.deps.log(
            `stop-time pulse revert failed, will retry on next start: ${String(err)}`
          )
        })
    }
  }
}

// ---------------------------------------------------------------------------

export interface NotificationValue {
  state: string
  method: string[]
  message: string
}

/** Delta payload for a notifications.* emission (zones.ts pattern —
 *  works even when the server's Notification manager is disabled). */
export function notificationDelta(
  pathSuffix: string,
  value: NotificationValue
): object {
  return {
    updates: [
      {
        values: [{ path: `notifications.${pathSuffix}`, value }]
      }
    ]
  }
}
