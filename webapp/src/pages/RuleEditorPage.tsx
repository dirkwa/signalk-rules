import { useState } from 'react'
import type { ConditionT, RuleT } from '../../../src/shared/schemas'
import type { ValidationIssue } from '../../../src/shared/validate'
import { useRulesStore } from '../stores/rulesStore'
import { useRuleEngineState } from '../stores/liveStore'
import { ConditionRow } from '../components/ConditionRow'
import { ActionRow } from '../components/ActionRow'
import { Switch } from '../components/Switch'

interface RuleEditorPageProps {
  ruleId: string
  onBack(): void
}

const NEW_CONDITIONS: Record<string, ConditionT> = {
  numeric: {
    type: 'numeric',
    path: 'navigation.speedOverGround',
    operator: 'lt',
    threshold: 0.514
  },
  switch: {
    type: 'switch',
    path: 'electrical.switches.bank.0.1.state',
    equals: 1
  },
  string: { type: 'string', path: 'navigation.state', equals: 'anchored' },
  timeOfDay: { type: 'timeOfDay', from: '08:00', to: '20:00' },
  sun: { type: 'sun', during: 'day' }
}

/** Errors/warnings scoped to one rule, keyed for row highlighting. */
function fieldsInError(
  issues: ValidationIssue[],
  ruleId: string,
  prefix: string
): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>()
  for (const issue of issues) {
    if (issue.ruleId !== ruleId) continue
    const m = new RegExp(`/${prefix}/(\\d+)/([A-Za-z]+)`).exec(issue.path)
    if (m && m[1] !== undefined && m[2] !== undefined) {
      const idx = Number(m[1])
      const set = map.get(idx) ?? new Set()
      set.add(m[2])
      map.set(idx, set)
    }
  }
  return map
}

export function RuleEditorPage({ ruleId, onBack }: RuleEditorPageProps) {
  const rule = useRulesStore((s) => s.draft?.rules.find((r) => r.id === ruleId))
  const errors = useRulesStore((s) => s.errors)
  const warnings = useRulesStore((s) => s.warnings)
  const updateRule = useRulesStore((s) => s.updateRule)
  const removeRule = useRulesStore((s) => s.removeRule)
  const engineRule = useRuleEngineState(ruleId)
  const [showAdvanced, setShowAdvanced] = useState(false)

  if (rule === undefined) {
    return (
      <div className="page">
        <button type="button" className="btn" onClick={onBack}>
          ← Back
        </button>
        <p>Rule not found.</p>
      </div>
    )
  }

  const up = (patch: Partial<RuleT>): void => updateRule(ruleId, patch)
  const condErrors = fieldsInError(errors, ruleId, 'conditions')
  const actionErrors = fieldsInError(errors, ruleId, 'actions')
  const ruleIssues = [...errors, ...warnings].filter((i) => i.ruleId === ruleId)
  const hasSetSwitch = rule.actions.some((a) => a.type === 'setSwitch')
  const hasPulse = rule.actions.some((a) => a.type === 'pulse')

  return (
    <div className="page editor">
      <div className="editor-head">
        <button type="button" className="btn" onClick={onBack}>
          ← Back
        </button>
        <input
          className="rule-name"
          value={rule.name}
          onChange={(e) => up({ name: e.target.value })}
        />
        <label className="check">
          <Switch
            checked={rule.dryRun}
            onChange={(dryRun) => up({ dryRun })}
            title="Dry run: evaluate and log, but never act"
          />
          dry run
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showAdvanced}
            onChange={(e) => setShowAdvanced(e.target.checked)}
          />
          advanced
        </label>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            removeRule(ruleId)
            onBack()
          }}
        >
          Delete
        </button>
      </div>

      {ruleIssues.length > 0 && (
        <div className="issue-list">
          {ruleIssues.map((issue, i) => (
            <div
              key={i}
              className={
                errors.includes(issue)
                  ? 'banner banner-error'
                  : 'banner banner-warn'
              }
            >
              {issue.message}
            </div>
          ))}
        </div>
      )}

      <section className="sentence">
        <div className="sentence-lead">
          <strong>WHEN</strong>
          <select
            value={rule.combinator}
            onChange={(e) =>
              up({ combinator: e.target.value === 'any' ? 'any' : 'all' })
            }
          >
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          <span>of these are true:</span>
        </div>

        {rule.conditions.map((cond, i) => (
          <ConditionRow
            key={i}
            cond={cond}
            engineState={engineRule?.conditions[i]}
            showAdvanced={showAdvanced}
            errorFields={condErrors.get(i) ?? new Set()}
            onChange={(next) =>
              up({
                conditions: rule.conditions.map((c, j) => (j === i ? next : c))
              })
            }
            onRemove={() =>
              up({ conditions: rule.conditions.filter((_, j) => j !== i) })
            }
          />
        ))}

        <div className="add-row">
          <span>+ Add condition:</span>
          <button
            type="button"
            className="btn"
            onClick={() => addCond('numeric')}
          >
            value compares…
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => addCond('switch')}
          >
            switch is…
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => addCond('string')}
          >
            vessel state is…
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => addCond('timeOfDay')}
          >
            time of day…
          </button>
          <button type="button" className="btn" onClick={() => addCond('sun')}>
            day / night…
          </button>
        </div>

        <div className="sentence-lead">
          <strong>THEN</strong>
        </div>

        {rule.actions.map((action, i) => (
          <ActionRow
            key={i}
            action={action}
            showAdvanced={showAdvanced}
            canRemove={rule.actions.length > 1}
            errorFields={actionErrors.get(i) ?? new Set()}
            onChange={(next) =>
              up({ actions: rule.actions.map((a, j) => (j === i ? next : a)) })
            }
            onRemove={() =>
              up({ actions: rule.actions.filter((_, j) => j !== i) })
            }
          />
        ))}
        {rule.actions.length < 3 && (
          <div className="add-row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                up({
                  actions: [
                    ...rule.actions,
                    {
                      type: 'notification',
                      pathSuffix: 'rules.alert',
                      state: 'alert',
                      method: ['visual'],
                      message: `${rule.name} triggered`
                    }
                  ]
                })
              }
            >
              + Add action
            </button>
          </div>
        )}
      </section>

      <section className="options">
        <h3>Flap protection & timing</h3>
        <label className="mini-field">
          conditions must hold
          <input
            type="number"
            min={0}
            className="input-small"
            value={rule.options.holdTrueSeconds ?? 0}
            onChange={(e) =>
              up({
                options: {
                  ...rule.options,
                  holdTrueSeconds: numberOrUndef(e.target.value)
                }
              })
            }
          />
          s before switching ON
        </label>
        <label className="mini-field">
          and
          <input
            type="number"
            min={0}
            className="input-small"
            value={rule.options.holdFalseSeconds ?? 0}
            onChange={(e) =>
              up({
                options: {
                  ...rule.options,
                  holdFalseSeconds: numberOrUndef(e.target.value)
                }
              })
            }
          />
          s before switching OFF
        </label>
        {hasSetSwitch && (
          <label
            className="mini-field"
            title="Re-sends the decided state, overriding manual changes"
          >
            re-assert every
            <input
              type="number"
              min={1}
              className="input-small"
              value={rule.options.reassertMinutes ?? ''}
              placeholder="off"
              onChange={(e) =>
                up({
                  options: {
                    ...rule.options,
                    reassertMinutes:
                      e.target.value === '' ? undefined : Number(e.target.value)
                  }
                })
              }
            />
            min
          </label>
        )}
        {hasPulse && (
          <label className="mini-field" title="Minimum time between pulses">
            pulse cooldown
            <input
              type="number"
              min={0}
              className="input-small"
              value={rule.options.cooldownSeconds ?? 300}
              onChange={(e) =>
                up({
                  options: {
                    ...rule.options,
                    cooldownSeconds: numberOrUndef(e.target.value)
                  }
                })
              }
            />
            s
          </label>
        )}
      </section>
    </div>
  )

  function addCond(type: keyof typeof NEW_CONDITIONS): void {
    const template = NEW_CONDITIONS[type]
    if (template === undefined || rule === undefined) return
    up({ conditions: [...rule.conditions, structuredClone(template)] })
  }
}

function numberOrUndef(text: string): number | undefined {
  if (text === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? n : undefined
}
