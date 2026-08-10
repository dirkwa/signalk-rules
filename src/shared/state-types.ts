/**
 * Wire shape of GET /plugins/signalk-rules/state — the live engine
 * truth the dashboard renders. Plain interfaces (no validation needed;
 * both ends are this package). All timestamps are epoch millis so the
 * webapp can interpolate countdowns client-side between polls.
 */

export type Tri = 'true' | 'false' | 'unknown'
export type Decision = 'on' | 'off' | 'unknown'

export interface ConditionState {
  /** Human summary, e.g. "electrical... is above 4" — webapp may rebuild its own. */
  path?: string
  value: unknown
  /** Millis since the input last arrived; undefined = never seen. */
  ageSeconds?: number
  stale: boolean
  truth: Tri
}

export type ActionRecordKind =
  | 'put'
  | 'pulseStart'
  | 'pulseEnd'
  | 'notify'
  | 'dryRun'
  | 'skippedAlreadySet'
  | 'suppressedCooldown'

export interface ActionRecord {
  ts: number
  kind: ActionRecordKind
  target: string
  value?: unknown
  result: 'ok' | 'pending' | 'failed'
  detail?: string
}

export interface RuleState {
  id: string
  name: string
  enabled: boolean
  dryRun: boolean
  /** Committed decision (after hold). */
  decision: Decision
  decisionSince: number
  /** Instantaneous combined truth, before hold. */
  raw: Tri
  /** Set while a hold timer runs. */
  pending?: { to: 'on' | 'off'; firesAt: number }
  conditions: ConditionState[]
  /** Set while a pulse is active on some target. */
  pulse?: { target: string; activeUntil: number }
  /** Millis until a pulse may fire again. */
  cooldownRemainingMs?: number
  nextReassertAt?: number
  lastActions: ActionRecord[]
  error?: string
}

export interface EngineState {
  rules: RuleState[]
  tickSeconds: number
  defaultStaleSeconds: number
  inputCount: number
  staleInputCount: number
  /** Epoch millis on the server when this snapshot was taken. */
  now: number
  startedAt: number
}

export interface RuleTestResult {
  ruleId: string
  raw: Tri
  conditions: ConditionState[]
  wouldDo: string[]
}
