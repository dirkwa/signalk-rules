import type { RuleT, RulesDocT, SetSwitchActionT } from './shared/schemas.js'
import { DEFAULTS } from './shared/schemas.js'
import type {
  ConditionState,
  EngineState,
  RuleState,
  RuleTestResult,
  Tri
} from './shared/state-types.js'
import {
  combine,
  evalCondition,
  initialCondState,
  type EvalContext,
  type InputReading
} from './conditions.js'
import { RuleRuntime, type RuleEffect } from './rule-runtime.js'
import {
  notificationDelta,
  PulseManager,
  PutExecutor,
  type PutFn
} from './actions.js'
import { SunTracker } from './sun.js'
import type { RulesStore } from './store.js'

const POSITION_PATH = 'navigation.position'
const POSITION_SAVE_INTERVAL_MS = 10 * 60_000

export interface EngineClock {
  monoMs(): number
  wallMs(): number
  wallDate(): Date
}

const realClock: EngineClock = {
  monoMs: () => performance.now(),
  wallMs: () => Date.now(),
  wallDate: () => new Date()
}

export interface EngineConfig {
  tickSeconds: number
  defaultStaleSeconds: number
  verbose: boolean
}

export interface EngineDeps {
  /** Subscribe to a self path; returns an unsubscriber. */
  subscribe(path: string, cb: (value: unknown) => void): () => void
  /** Current full-model node for a self path (for seeding + actual-state). */
  getCurrent(path: string): unknown
  put: PutFn
  sendDelta(delta: object): void
  setStatus(msg: string): void
  setError(msg: string): void
  debug(msg: string): void
  store: RulesStore
  clock?: EngineClock
  /** Tests set false and call tick() manually. */
  scheduleTick?: boolean
}

interface TrackedRule {
  rule: RuleT
  runtime: RuleRuntime
  lastTruths: Tri[]
}

export class Engine {
  private doc: RulesDocT = { version: 1, rules: [] }
  private readonly tracked = new Map<string, TrackedRule>()
  private readonly inputs = new Map<string, InputReading>()
  private readonly subscriptions = new Map<string, () => void>()
  private readonly pathToRuleIds = new Map<string, Set<string>>()
  private readonly sun = new SunTracker()
  private readonly clock: EngineClock
  private readonly putExec: PutExecutor
  private readonly pulses: PulseManager
  private ticker: NodeJS.Timeout | null = null
  private startedAtWall = 0
  private lastPositionSaveMono = 0
  private lastStatus = ''

  constructor(
    private readonly config: EngineConfig,
    private readonly deps: EngineDeps
  ) {
    this.clock = deps.clock ?? realClock
    this.putExec = new PutExecutor(deps.put, {
      monoMs: () => this.clock.monoMs(),
      log: (msg) => deps.debug(msg)
    })
    this.pulses = new PulseManager({
      putExec: this.putExec,
      putDirect: deps.put,
      persist: () => this.persistRuntimeState(),
      monoMs: () => this.clock.monoMs(),
      wallMs: () => this.clock.wallMs(),
      log: (msg) => deps.debug(msg),
      onRecord: (ruleId, rec) =>
        this.tracked.get(ruleId)?.runtime.recordAction(rec)
    })
  }

  start(doc: RulesDocT): void {
    this.startedAtWall = this.clock.wallMs()
    const saved = this.deps.store.loadRuntimeState()
    this.pulses.loadLastPulses(saved.lastPulseAt)
    if (saved.lastPosition) this.sun.setPosition(saved.lastPosition)
    // Fail-safe first: a pulse record on disk means a previous run died
    // mid-pulse. Revert before evaluating anything.
    this.pulses.restoreAndRevert(saved.pulses)

    this.reload(doc)

    if (this.deps.scheduleTick !== false) {
      this.ticker = setInterval(
        () => this.tick(),
        Math.max(500, this.config.tickSeconds * 1000)
      )
      this.ticker.unref?.()
    }
  }

  /** Hot-swap the rule set. Runtimes restart at 'unknown' (safe: follow
   *  edges baseline against actual state; pulses are cooldown-gated). */
  reload(doc: RulesDocT): void {
    const nextById = new Map(doc.rules.map((r) => [r.id, r]))

    for (const [id, t] of this.tracked) {
      const next = nextById.get(id)
      const goneOrDisabled = next === undefined || !next.enabled
      if (goneOrDisabled) {
        // A raised notification must not stick around after its rule.
        this.emitNotificationClear(t)
      }
      if (next === undefined) {
        this.pulses.cancelForRule(id, 'rule removed')
      } else if (!next.enabled) {
        this.pulses.cancelForRule(id, 'rule paused')
      }
      // Rules still present keep in-flight pulses (revert timer intact).
    }

    this.tracked.clear()
    for (const rule of doc.rules) {
      if (!rule.enabled) continue
      this.tracked.set(rule.id, {
        rule,
        runtime: new RuleRuntime(rule, this.clock),
        lastTruths: rule.conditions.map(() => 'unknown' as Tri)
      })
    }
    this.doc = doc

    this.rebuildSubscriptions()
    for (const t of this.tracked.values()) this.evaluateRule(t)
    this.updateStatus()
  }

  stop(): void {
    if (this.ticker !== null) clearInterval(this.ticker)
    this.ticker = null
    // Reverts before executor teardown — a starter must never stay
    // engaged because the plugin was disabled mid-pulse.
    this.pulses.stopAll()
    this.putExec.dispose()
    for (const unsub of this.subscriptions.values()) unsub()
    this.subscriptions.clear()
    this.persistRuntimeState()
  }

  tick(): void {
    for (const t of this.tracked.values()) this.evaluateRule(t)
    const mono = this.clock.monoMs()
    if (
      this.sun.position !== null &&
      mono - this.lastPositionSaveMono > POSITION_SAVE_INTERVAL_MS
    ) {
      this.lastPositionSaveMono = mono
      this.persistRuntimeState()
    }
    this.updateStatus()
  }

  // ------------------------------------------------------------------ inputs

  private referencedPaths(): Set<string> {
    const paths = new Set<string>([POSITION_PATH])
    for (const rule of this.doc.rules) {
      // Disabled rules' inputs keep flowing so the dashboard stays live.
      for (const cond of rule.conditions) {
        if ('path' in cond) paths.add(cond.path)
      }
      for (const action of rule.actions) {
        if (action.type === 'setSwitch' || action.type === 'pulse') {
          paths.add(action.path)
        }
      }
    }
    return paths
  }

  private rebuildSubscriptions(): void {
    const wanted = this.referencedPaths()

    for (const [path, unsub] of this.subscriptions) {
      if (!wanted.has(path)) {
        unsub()
        this.subscriptions.delete(path)
      }
    }
    for (const path of wanted) {
      if (!this.subscriptions.has(path)) {
        this.seedInput(path)
        this.subscriptions.set(
          path,
          this.deps.subscribe(path, (value) => this.onInput(path, value))
        )
      }
    }

    this.pathToRuleIds.clear()
    for (const t of this.tracked.values()) {
      for (const cond of t.rule.conditions) {
        if ('path' in cond) {
          let set = this.pathToRuleIds.get(cond.path)
          if (set === undefined) {
            set = new Set()
            this.pathToRuleIds.set(cond.path, set)
          }
          set.add(t.rule.id)
        }
      }
    }
  }

  private seedInput(path: string): void {
    if (this.inputs.has(path)) return
    const node = this.deps.getCurrent(path)
    const value =
      node !== null && typeof node === 'object' && 'value' in node
        ? (node as { value: unknown }).value
        : node
    if (value !== undefined && value !== null) {
      this.inputs.set(path, { value, receivedAt: this.clock.wallMs() })
      if (path === POSITION_PATH) this.sun.setPosition(value)
    }
  }

  private onInput(path: string, value: unknown): void {
    this.inputs.set(path, { value, receivedAt: this.clock.wallMs() })
    if (path === POSITION_PATH) this.sun.setPosition(value)
    const ruleIds = this.pathToRuleIds.get(path)
    if (ruleIds === undefined) return
    for (const id of ruleIds) {
      const t = this.tracked.get(id)
      if (t !== undefined) this.evaluateRule(t)
    }
  }

  private evalContext(): EvalContext {
    return {
      wallMs: this.clock.wallMs(),
      wallDate: this.clock.wallDate(),
      defaultStaleSeconds: this.config.defaultStaleSeconds,
      getInput: (path) => this.inputs.get(path),
      sun: this.sun
    }
  }

  // -------------------------------------------------------------- evaluation

  private evaluateRule(t: TrackedRule): void {
    const ctx = this.evalContext()
    const truths = t.rule.conditions.map((cond, i) => {
      const state = t.runtime.condStates[i]
      return state !== undefined ? evalCondition(cond, state, ctx) : 'unknown'
    })
    t.lastTruths = truths
    const raw = combine(t.rule.combinator, truths)
    const effects = t.runtime.advance(raw)
    for (const effect of effects) this.executeEffect(t, effect)
  }

  private executeEffect(t: TrackedRule, effect: RuleEffect): void {
    if (effect.kind === 'edge') {
      if (this.config.verbose) {
        this.deps.debug(`rule "${t.rule.name}": ${effect.edge} edge`)
      }
      for (const action of t.rule.actions) {
        this.applyAction(t, action, effect.edge)
      }
      return
    }
    // Reassert: re-enforce the committed decision on setSwitch targets.
    // Opt-in per rule, and the one case that intentionally overrides a
    // manual change.
    if (t.runtime.decision === 'unknown') return
    const edge = t.runtime.decision === 'on' ? 'rising' : 'falling'
    for (const action of t.rule.actions) {
      if (action.type === 'setSwitch') this.applySetSwitch(t, action, edge)
    }
  }

  private applyAction(
    t: TrackedRule,
    action: RuleT['actions'][number],
    edge: 'rising' | 'falling'
  ): void {
    switch (action.type) {
      case 'setSwitch':
        this.applySetSwitch(t, action, edge)
        break
      case 'pulse': {
        if (edge === 'falling') {
          // End an active pulse early when the condition clears.
          this.pulses.cancelForRule(t.rule.id, 'condition cleared')
          break
        }
        const cooldownSeconds =
          t.rule.options.cooldownSeconds ?? DEFAULTS.cooldownSeconds
        const remaining = this.pulses.cooldownRemainingMs(
          t.rule.id,
          cooldownSeconds
        )
        if (remaining > 0) {
          t.runtime.recordAction({
            ts: this.clock.wallMs(),
            kind: 'suppressedCooldown',
            target: action.path,
            result: 'ok',
            detail: `cooldown, ${Math.ceil(remaining / 1000)}s left`
          })
          break
        }
        if (this.pulses.isActive(t.rule.id, action.path)) {
          t.runtime.recordAction({
            ts: this.clock.wallMs(),
            kind: 'suppressedCooldown',
            target: action.path,
            result: 'ok',
            detail: 'pulse already active'
          })
          break
        }
        if (t.rule.dryRun) {
          t.runtime.recordAction({
            ts: this.clock.wallMs(),
            kind: 'dryRun',
            target: action.path,
            value: action.value ?? DEFAULTS.pulseValue,
            result: 'ok',
            detail: `would pulse for ${action.seconds}s`
          })
          break
        }
        this.pulses.markFired(t.rule.id)
        this.pulses.start(
          t.rule.id,
          action.path,
          action.value ?? DEFAULTS.pulseValue,
          action.revertValue ?? DEFAULTS.pulseRevert,
          action.seconds
        )
        break
      }
      case 'notification': {
        const clearOnFalse = action.clearOnFalse ?? true
        if (edge === 'falling' && !clearOnFalse) break
        const value = {
          state: edge === 'rising' ? action.state : 'normal',
          method: edge === 'rising' ? [...action.method] : [],
          message: action.message
        }
        if (t.rule.dryRun) {
          t.runtime.recordAction({
            ts: this.clock.wallMs(),
            kind: 'dryRun',
            target: `notifications.${action.pathSuffix}`,
            value: value.state,
            result: 'ok',
            detail: 'would notify'
          })
          break
        }
        this.deps.sendDelta(notificationDelta(action.pathSuffix, value))
        t.runtime.recordAction({
          ts: this.clock.wallMs(),
          kind: 'notify',
          target: `notifications.${action.pathSuffix}`,
          value: value.state,
          result: 'ok'
        })
        break
      }
    }
  }

  private applySetSwitch(
    t: TrackedRule,
    action: SetSwitchActionT,
    edge: 'rising' | 'falling'
  ): void {
    const desired =
      edge === 'rising'
        ? (action.onValue ?? DEFAULTS.setSwitchOn)
        : (action.offValue ?? DEFAULTS.setSwitchOff)
    const actual = this.inputs.get(action.path)?.value
    if (typeof actual === 'number' && actual === desired) {
      // Edge-triggered semantics: never re-PUT what's already true, so
      // manual overrides stick between transitions.
      t.runtime.recordAction({
        ts: this.clock.wallMs(),
        kind: 'skippedAlreadySet',
        target: action.path,
        value: desired,
        result: 'ok'
      })
      return
    }
    if (t.rule.dryRun) {
      t.runtime.recordAction({
        ts: this.clock.wallMs(),
        kind: 'dryRun',
        target: action.path,
        value: desired,
        result: 'ok',
        detail: 'would set switch'
      })
      return
    }
    this.putExec.request(action.path, desired, (ok, detail) => {
      t.runtime.recordAction({
        ts: this.clock.wallMs(),
        kind: 'put',
        target: action.path,
        value: desired,
        result: ok ? 'ok' : 'failed',
        detail
      })
      if (ok) {
        t.runtime.error = null
      } else if (detail !== 'superseded' && detail !== 'stopped') {
        t.runtime.error = `PUT ${action.path} failed: ${detail ?? 'unknown error'}`
        this.updateStatus()
      }
    })
  }

  private emitNotificationClear(t: TrackedRule): void {
    if (t.runtime.decision !== 'on' || t.rule.dryRun) return
    for (const action of t.rule.actions) {
      if (action.type === 'notification' && (action.clearOnFalse ?? true)) {
        this.deps.sendDelta(
          notificationDelta(action.pathSuffix, {
            state: 'normal',
            method: [],
            message: action.message
          })
        )
      }
    }
  }

  // ------------------------------------------------------------------ status

  private updateStatus(): void {
    const total = this.doc.rules.length
    const enabled = this.tracked.size
    let blocked = 0
    let failing = 0
    for (const t of this.tracked.values()) {
      if (t.runtime.lastRaw === 'unknown') blocked++
      if (t.runtime.error !== null) failing++
    }
    let status = `${total} rule${total === 1 ? '' : 's'} (${enabled} enabled)`
    if (blocked > 0) status += `, ${blocked} waiting on missing data`
    if (failing > 0) status += `, ${failing} failing PUTs`
    if (status !== this.lastStatus) {
      this.lastStatus = status
      if (failing > 0) this.deps.setError(status)
      else this.deps.setStatus(status)
    }
  }

  private persistRuntimeState(): void {
    this.deps.store.saveRuntimeStateSync({
      pulses: this.pulses.snapshot(),
      lastPulseAt: this.pulses.lastPulses(),
      lastPosition: this.sun.position
    })
  }

  // ------------------------------------------------------------------- state

  getDoc(): RulesDocT {
    return this.doc
  }

  getState(): EngineState {
    const wallNow = this.clock.wallMs()
    let staleInputs = 0
    const ttlMs = this.config.defaultStaleSeconds * 1000
    for (const reading of this.inputs.values()) {
      if (ttlMs > 0 && wallNow - reading.receivedAt > ttlMs) staleInputs++
    }
    return {
      rules: this.doc.rules.map((rule) => this.ruleState(rule, wallNow)),
      tickSeconds: this.config.tickSeconds,
      defaultStaleSeconds: this.config.defaultStaleSeconds,
      inputCount: this.inputs.size,
      staleInputCount: staleInputs,
      now: wallNow,
      startedAt: this.startedAtWall
    }
  }

  private ruleState(rule: RuleT, wallNow: number): RuleState {
    const t = this.tracked.get(rule.id)
    const ctx = this.evalContext()

    const conditions: ConditionState[] = rule.conditions.map((cond, i) => {
      const path = 'path' in cond ? cond.path : undefined
      const reading = path !== undefined ? this.inputs.get(path) : undefined
      const ttl =
        ('staleSeconds' in cond ? cond.staleSeconds : undefined) ??
        this.config.defaultStaleSeconds
      const stale =
        path !== undefined &&
        (reading === undefined ||
          (ttl > 0 && wallNow - reading.receivedAt > ttl * 1000))
      let truth: Tri
      if (t !== undefined) {
        truth = t.lastTruths[i] ?? 'unknown'
      } else {
        // Paused rule: evaluate on throwaway state for display only.
        truth = evalCondition(cond, initialCondState(), ctx)
      }
      return {
        path,
        value: reading?.value,
        ageSeconds:
          reading !== undefined
            ? Math.round((wallNow - reading.receivedAt) / 1000)
            : undefined,
        stale,
        truth
      }
    })

    if (t === undefined) {
      return {
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        dryRun: rule.dryRun,
        decision: 'unknown',
        decisionSince: 0,
        raw: combine(
          rule.combinator,
          conditions.map((c) => c.truth)
        ),
        conditions,
        lastActions: []
      }
    }

    const holdRemaining = t.runtime.pendingHoldRemainingMs()
    const reassertRemaining = t.runtime.nextReassertRemainingMs()
    const pulse = this.pulses.activeForRule(rule.id)
    const hasPulseAction = rule.actions.some((a) => a.type === 'pulse')
    const cooldownRemaining = hasPulseAction
      ? this.pulses.cooldownRemainingMs(
          rule.id,
          rule.options.cooldownSeconds ?? DEFAULTS.cooldownSeconds
        )
      : undefined

    return {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      dryRun: rule.dryRun,
      decision: t.runtime.decision,
      decisionSince: t.runtime.decisionSinceWall,
      raw: t.runtime.lastRaw,
      pending:
        t.runtime.pending !== null && holdRemaining !== null
          ? { to: t.runtime.pending.to, firesAt: wallNow + holdRemaining }
          : undefined,
      conditions,
      pulse:
        pulse !== undefined
          ? { target: pulse.target, activeUntil: pulse.activeUntilWall }
          : undefined,
      cooldownRemainingMs:
        cooldownRemaining !== undefined && cooldownRemaining > 0
          ? cooldownRemaining
          : undefined,
      nextReassertAt:
        reassertRemaining !== null ? wallNow + reassertRemaining : undefined,
      lastActions: t.runtime.lastActions,
      error: t.runtime.error ?? undefined
    }
  }

  /** One-shot dry evaluation for POST /rules/:id/test — no latch
   *  mutation, no actions. */
  testRule(id: string): RuleTestResult | null {
    const rule = this.doc.rules.find((r) => r.id === id)
    if (rule === undefined) return null
    const t = this.tracked.get(id)
    const ctx = this.evalContext()
    const truths = rule.conditions.map((cond, i) => {
      const state = t?.runtime.condStates[i]
      // Clone so the latch is untouched by a test.
      return evalCondition(cond, { latched: state?.latched ?? false }, ctx)
    })
    const raw = combine(rule.combinator, truths)
    const wallNow = this.clock.wallMs()
    const conditions: ConditionState[] = rule.conditions.map((cond, i) => {
      const path = 'path' in cond ? cond.path : undefined
      const reading = path !== undefined ? this.inputs.get(path) : undefined
      return {
        path,
        value: reading?.value,
        ageSeconds:
          reading !== undefined
            ? Math.round((wallNow - reading.receivedAt) / 1000)
            : undefined,
        stale: truths[i] === 'unknown' && path !== undefined,
        truth: truths[i] ?? 'unknown'
      }
    })
    const wouldDo: string[] = []
    for (const action of rule.actions) {
      if (action.type === 'setSwitch') {
        const desired =
          raw === 'true'
            ? (action.onValue ?? DEFAULTS.setSwitchOn)
            : (action.offValue ?? DEFAULTS.setSwitchOff)
        wouldDo.push(
          raw === 'unknown'
            ? `hold ${action.path} (missing data)`
            : `set ${action.path} to ${desired}`
        )
      } else if (action.type === 'pulse') {
        wouldDo.push(
          raw === 'true'
            ? `pulse ${action.path} to ${action.value ?? DEFAULTS.pulseValue} for ${action.seconds}s`
            : `no pulse (conditions not met)`
        )
      } else {
        wouldDo.push(
          raw === 'true'
            ? `raise notifications.${action.pathSuffix} (${action.state})`
            : `clear notifications.${action.pathSuffix}`
        )
      }
    }
    return { ruleId: id, raw, conditions, wouldDo }
  }
}
