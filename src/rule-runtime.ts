import type { RuleT } from './shared/schemas.js'
import { DEFAULTS } from './shared/schemas.js'
import type { ActionRecord, Decision, Tri } from './shared/state-types.js'
import { type CondState, initialCondState } from './conditions.js'

export interface RuleClock {
  /** Monotonic millis — immune to NTP steps; used for all durations. */
  monoMs(): number
  /** Wall-clock millis — used only for display timestamps. */
  wallMs(): number
}

export type RuleEffect =
  { kind: 'edge'; edge: 'rising' | 'falling' } | { kind: 'reassert' }

const LAST_ACTIONS_KEPT = 5

/**
 * Per-rule decision state machine. Pure with respect to I/O: callers
 * feed in the combined raw truth, and get back the effects (edges,
 * reasserts) to execute. All flap protection lives here.
 */
export class RuleRuntime {
  readonly rule: RuleT
  readonly condStates: CondState[]
  decision: Decision = 'unknown'
  decisionSinceWall: number
  lastRaw: Tri = 'unknown'
  pending: { to: 'on' | 'off'; sinceMono: number } | null = null
  private nextReassertAtMono: number | null = null
  lastActions: ActionRecord[] = []
  error: string | null = null

  private readonly clock: RuleClock

  constructor(rule: RuleT, clock: RuleClock) {
    this.rule = rule
    this.clock = clock
    this.condStates = rule.conditions.map(() => initialCondState())
    this.decisionSinceWall = clock.wallMs()
  }

  /**
   * Advance the state machine with the current combined truth.
   * Returns the effects the engine must execute, in order.
   */
  advance(raw: Tri): RuleEffect[] {
    const effects: RuleEffect[] = []
    const mono = this.clock.monoMs()
    this.lastRaw = raw

    if (raw === 'unknown') {
      // Hold the committed decision; a stale input must never flap an
      // output. The dashboard shows which condition blocks.
      this.pending = null
    } else {
      const target: 'on' | 'off' = raw === 'true' ? 'on' : 'off'
      if (target === this.decision) {
        this.pending = null
      } else {
        if (this.pending === null || this.pending.to !== target) {
          this.pending = { to: target, sinceMono: mono }
        }
        const holdSeconds =
          target === 'on'
            ? (this.rule.options.holdTrueSeconds ?? DEFAULTS.holdTrueSeconds)
            : (this.rule.options.holdFalseSeconds ?? DEFAULTS.holdFalseSeconds)
        if (mono - this.pending.sinceMono >= holdSeconds * 1000) {
          this.decision = target
          this.decisionSinceWall = this.clock.wallMs()
          this.pending = null
          effects.push({
            kind: 'edge',
            edge: target === 'on' ? 'rising' : 'falling'
          })
          this.armReassert(mono)
        }
      }
    }

    if (
      this.decision !== 'unknown' &&
      this.nextReassertAtMono !== null &&
      mono >= this.nextReassertAtMono
    ) {
      effects.push({ kind: 'reassert' })
      this.armReassert(mono)
    }

    return effects
  }

  private armReassert(mono: number): void {
    const minutes = this.rule.options.reassertMinutes
    this.nextReassertAtMono =
      minutes !== undefined ? mono + minutes * 60_000 : null
  }

  /** Millis until the pending hold commits, for the dashboard. */
  pendingHoldRemainingMs(): number | null {
    if (this.pending === null) return null
    const holdSeconds =
      this.pending.to === 'on'
        ? (this.rule.options.holdTrueSeconds ?? DEFAULTS.holdTrueSeconds)
        : (this.rule.options.holdFalseSeconds ?? DEFAULTS.holdFalseSeconds)
    const elapsed = this.clock.monoMs() - this.pending.sinceMono
    return Math.max(0, holdSeconds * 1000 - elapsed)
  }

  nextReassertRemainingMs(): number | null {
    if (this.nextReassertAtMono === null || this.decision === 'unknown')
      return null
    return Math.max(0, this.nextReassertAtMono - this.clock.monoMs())
  }

  recordAction(rec: ActionRecord): void {
    this.lastActions.unshift(rec)
    if (this.lastActions.length > LAST_ACTIONS_KEPT) {
      this.lastActions.length = LAST_ACTIONS_KEPT
    }
  }
}
