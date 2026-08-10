/**
 * The rule model — single source of truth for plugin AND webapp.
 *
 * This file must import ONLY 'typebox' (no server-api, no node
 * builtins): the plugin compiles it with module=node16 while the
 * webapp bundles the same source through Vite.
 *
 * All numeric thresholds are RAW Signal K units as they appear on the
 * bus (m/s, ratio 0-1, volts). The webapp converts for display; the
 * engine never converts.
 */
import { Type, type Static } from 'typebox'

export const SkPath = Type.String({
  pattern: '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)+$',
  description: 'Dotted Signal K self path'
})

// ---------- Conditions ----------

const condBase = {
  /** Invert the outcome (unknown stays unknown). */
  negate: Type.Optional(Type.Boolean()),
  /** Per-condition input TTL override; 0 = never stale. */
  staleSeconds: Type.Optional(Type.Number({ minimum: 0 }))
}

export const NumericCondition = Type.Object({
  type: Type.Literal('numeric'),
  path: SkPath,
  operator: Type.Union([
    Type.Literal('lt'),
    Type.Literal('lte'),
    Type.Literal('gt'),
    Type.Literal('gte'),
    Type.Literal('eq'),
    Type.Literal('ne')
  ]),
  threshold: Type.Number(),
  /**
   * Hysteresis latch (lt/lte/gt/gte only): `gt 4.0` with
   * `clearThreshold 1.0` becomes true above 4.0 and stays true until
   * the value drops below 1.0.
   */
  clearThreshold: Type.Optional(Type.Number()),
  ...condBase
})

export const SwitchCondition = Type.Object({
  type: Type.Literal('switch'),
  path: SkPath,
  equals: Type.Union([Type.Literal(0), Type.Literal(1)]),
  ...condBase
})

export const StringCondition = Type.Object({
  type: Type.Literal('string'),
  path: SkPath,
  equals: Type.String({ minLength: 1 }),
  ...condBase
})

export const TimeOfDayCondition = Type.Object({
  type: Type.Literal('timeOfDay'),
  /** Local wall clock "HH:MM"; wraps midnight when from > to. */
  from: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
  to: Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
  ...condBase
})

export const SunCondition = Type.Object({
  type: Type.Literal('sun'),
  during: Type.Union([Type.Literal('day'), Type.Literal('night')]),
  /** Shift the window start, minutes (e.g. -30 = half hour early). */
  startOffsetMinutes: Type.Optional(
    Type.Number({ minimum: -180, maximum: 180 })
  ),
  endOffsetMinutes: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  ...condBase
})

export const Condition = Type.Union([
  NumericCondition,
  SwitchCondition,
  StringCondition,
  TimeOfDayCondition,
  SunCondition
])

// ---------- Actions ----------

/** Follow-style: PUT onValue on the rising edge, offValue on the falling. */
export const SetSwitchAction = Type.Object({
  type: Type.Literal('setSwitch'),
  path: SkPath,
  onValue: Type.Optional(Type.Number()),
  offValue: Type.Optional(Type.Number())
})

/** Rising edge only: PUT value, auto-revert after `seconds`. */
export const PulseAction = Type.Object({
  type: Type.Literal('pulse'),
  path: SkPath,
  value: Type.Optional(Type.Number()),
  // Hard cap: no SK plugin can guarantee a revert across hard power
  // loss, so long pulses belong in the switching hardware's own
  // momentary/timer channel config.
  seconds: Type.Number({ minimum: 1, maximum: 60 }),
  revertValue: Type.Optional(Type.Number())
})

/** Raise notifications.<pathSuffix> on rising, state 'normal' on falling. */
export const NotificationAction = Type.Object({
  type: Type.Literal('notification'),
  pathSuffix: Type.String({ pattern: '^[A-Za-z0-9_-]+(\\.[A-Za-z0-9_-]+)*$' }),
  state: Type.Union([
    Type.Literal('normal'),
    Type.Literal('alert'),
    Type.Literal('warn'),
    Type.Literal('alarm'),
    Type.Literal('emergency')
  ]),
  method: Type.Array(
    Type.Union([Type.Literal('visual'), Type.Literal('sound')])
  ),
  message: Type.String({ minLength: 1 }),
  clearOnFalse: Type.Optional(Type.Boolean())
})

export const Action = Type.Union([
  SetSwitchAction,
  PulseAction,
  NotificationAction
])

// ---------- Rule ----------

export const RuleOptions = Type.Object({
  /** Raw decision must hold this long before the ON edge commits. */
  holdTrueSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })),
  holdFalseSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600 })),
  /** setSwitch rules only: periodically re-PUT the decided state. */
  reassertMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 1440 })),
  /** Pulse rules only: minimum spacing between firings. */
  cooldownSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 86400 }))
})

export const Rule = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9-]{8,64}$' }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  enabled: Type.Boolean({ default: true }),
  dryRun: Type.Boolean({ default: false }),
  combinator: Type.Union([Type.Literal('all'), Type.Literal('any')]),
  conditions: Type.Array(Condition, { minItems: 1, maxItems: 10 }),
  actions: Type.Array(Action, { minItems: 1, maxItems: 3 }),
  options: Type.Object(RuleOptions.properties, { default: {} })
})

export const RulesDoc = Type.Object({
  version: Type.Literal(1),
  rules: Type.Array(Rule, { maxItems: 100 })
})

export type SkPathT = Static<typeof SkPath>
export type NumericConditionT = Static<typeof NumericCondition>
export type SwitchConditionT = Static<typeof SwitchCondition>
export type StringConditionT = Static<typeof StringCondition>
export type TimeOfDayConditionT = Static<typeof TimeOfDayCondition>
export type SunConditionT = Static<typeof SunCondition>
export type ConditionT = Static<typeof Condition>
export type SetSwitchActionT = Static<typeof SetSwitchAction>
export type PulseActionT = Static<typeof PulseAction>
export type NotificationActionT = Static<typeof NotificationAction>
export type ActionT = Static<typeof Action>
export type RuleOptionsT = Static<typeof RuleOptions>
export type RuleT = Static<typeof Rule>
export type RulesDocT = Static<typeof RulesDoc>

export const EMPTY_RULES_DOC: RulesDocT = { version: 1, rules: [] }

// ---------- Defaults the engine applies at runtime ----------

export const DEFAULTS = {
  setSwitchOn: 1,
  setSwitchOff: 0,
  pulseValue: 1,
  pulseRevert: 0,
  holdTrueSeconds: 0,
  holdFalseSeconds: 0,
  cooldownSeconds: 300
} as const
