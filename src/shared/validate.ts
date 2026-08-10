/**
 * Structural (TypeBox) + semantic validation for a RulesDoc.
 * Shared by the plugin (PUT /rules) and the webapp (edit-time), so
 * both sides reject the same documents with the same messages.
 */
import { Check, Clone, Default, Errors } from 'typebox/value'
import {
  RulesDoc,
  type ConditionT,
  type RuleT,
  type RulesDocT
} from './schemas.js'

export interface ValidationIssue {
  /** JSON pointer into the document, e.g. "/rules/0/name". */
  path: string
  message: string
  /** The offending rule's id, when the issue is rule-scoped. */
  ruleId?: string
}

export type ValidationResult =
  | { ok: true; doc: RulesDocT; warnings: ValidationIssue[] }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[] }

/**
 * Validate an untrusted document. On success returns the document with
 * schema defaults applied (input is never mutated).
 */
export function validateRulesDoc(input: unknown): ValidationResult {
  const doc = Default(RulesDoc, Clone(input))

  if (!Check(RulesDoc, doc)) {
    const errors = [...Errors(RulesDoc, doc)].map((e) => ({
      path: e.instancePath,
      message: e.message,
      ...ruleIdAt(doc, e.instancePath)
    }))
    return { ok: false, errors, warnings: [] }
  }

  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []

  const seenIds = new Map<string, number>()
  doc.rules.forEach((rule, i) => {
    const at = (suffix: string): string => `/rules/${i}${suffix}`
    const issue = (
      list: ValidationIssue[],
      suffix: string,
      message: string
    ): void => {
      list.push({ path: at(suffix), message, ruleId: rule.id })
    }

    const first = seenIds.get(rule.id)
    if (first !== undefined) {
      issue(errors, '/id', `duplicate rule id (also used by rule ${first})`)
    }
    seenIds.set(rule.id, i)

    rule.conditions.forEach((cond, ci) => {
      checkCondition(cond, (suffix, message, isError) =>
        issue(
          isError ? errors : warnings,
          `/conditions/${ci}${suffix}`,
          message
        )
      )
    })

    const hasSetSwitch = rule.actions.some((a) => a.type === 'setSwitch')
    const hasPulse = rule.actions.some((a) => a.type === 'pulse')
    if (rule.options.reassertMinutes !== undefined && !hasSetSwitch) {
      issue(
        errors,
        '/options/reassertMinutes',
        'reassert requires a "set switch" action'
      )
    }
    if (rule.options.cooldownSeconds !== undefined && !hasPulse) {
      issue(
        warnings,
        '/options/cooldownSeconds',
        'cooldown only affects pulse actions — it has no effect here'
      )
    }
  })

  // A switch driven by more than one enabled rule will fight.
  const targets = new Map<string, RuleT[]>()
  for (const rule of doc.rules) {
    if (!rule.enabled) continue
    for (const action of rule.actions) {
      if (action.type === 'setSwitch' || action.type === 'pulse') {
        const list = targets.get(action.path) ?? []
        list.push(rule)
        targets.set(action.path, list)
      }
    }
  }
  for (const [path, rules] of targets) {
    if (rules.length > 1) {
      warnings.push({
        path: '/rules',
        message: `${path} is driven by ${rules.length} enabled rules (${rules
          .map((r) => `"${r.name}"`)
          .join(', ')}) — they may fight`
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings }
  return { ok: true, doc, warnings }
}

function checkCondition(
  cond: ConditionT,
  issue: (suffix: string, message: string, isError: boolean) => void
): void {
  if (cond.type === 'numeric' && cond.clearThreshold !== undefined) {
    switch (cond.operator) {
      case 'eq':
      case 'ne':
        issue(
          '/clearThreshold',
          'hysteresis is not supported with equals / not-equals',
          true
        )
        break
      case 'gt':
      case 'gte':
        if (cond.clearThreshold >= cond.threshold) {
          issue(
            '/clearThreshold',
            'release value must be below the trigger value',
            true
          )
        }
        break
      case 'lt':
      case 'lte':
        if (cond.clearThreshold <= cond.threshold) {
          issue(
            '/clearThreshold',
            'release value must be above the trigger value',
            true
          )
        }
        break
    }
  }
  if (cond.type === 'timeOfDay' && cond.from === cond.to) {
    issue(
      '/to',
      'start and end are the same — this window is never active',
      false
    )
  }
}

function ruleIdAt(doc: unknown, instancePath: string): { ruleId?: string } {
  const m = /^\/rules\/(\d+)/.exec(instancePath)
  if (!m || m[1] === undefined) return {}
  const rules = (doc as { rules?: unknown }).rules
  if (!Array.isArray(rules)) return {}
  const rule: unknown = rules[Number(m[1])]
  if (rule && typeof rule === 'object' && 'id' in rule) {
    const id = (rule as { id: unknown }).id
    if (typeof id === 'string') return { ruleId: id }
  }
  return {}
}
