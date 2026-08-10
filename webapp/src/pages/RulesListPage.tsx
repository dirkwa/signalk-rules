import { useRulesStore } from '../stores/rulesStore'
import { useRuleEngineState } from '../stores/liveStore'
import { useMetaStore } from '../stores/metaStore'
import { DecisionBadge } from '../components/DecisionBadge'
import { Switch } from '../components/Switch'
import { TEMPLATES, BLANK_RULE } from '../templates'
import type { RuleT } from '../../../src/shared/schemas'

interface RulesListPageProps {
  onEdit(ruleId: string): void
}

export function RulesListPage({ onEdit }: RulesListPageProps) {
  const draft = useRulesStore((s) => s.draft)
  const dirty = useRulesStore((s) => s.dirty)
  const addRule = useRulesStore((s) => s.addRule)

  if (draft === null) return <div className="page">Loading…</div>

  if (draft.rules.length === 0) {
    return (
      <div className="page empty-state">
        <div className="empty-state-icon">⚡</div>
        <h2>Create your first rule</h2>
        <p>
          Rules watch live Signal K values and drive your switches — no Node-RED
          required. Start from a template (created paused, in dry run) or from
          scratch:
        </p>
        <div className="template-grid">
          {TEMPLATES.map((t) => (
            <button
              key={t.title}
              type="button"
              className="template-card"
              onClick={() => {
                let firstId = ''
                for (const rule of t.rules) {
                  const id = addRule(rule)
                  if (firstId === '') firstId = id
                }
                if (firstId !== '') onEdit(firstId)
              }}
            >
              <strong>{t.title}</strong>
              <span>{t.blurb}</span>
            </button>
          ))}
          <button
            type="button"
            className="template-card"
            onClick={() => onEdit(addRule(structuredClone(BLANK_RULE)))}
          >
            <strong>Blank rule</strong>
            <span>Start from scratch</span>
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="list-head">
        <h2>Rules</h2>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onEdit(addRule(structuredClone(BLANK_RULE)))}
        >
          + New rule
        </button>
      </div>
      {draft.rules.map((rule) => (
        <RuleCard key={rule.id} rule={rule} dirty={dirty} onEdit={onEdit} />
      ))}
    </div>
  )
}

function RuleCard({
  rule,
  dirty,
  onEdit
}: {
  rule: RuleT
  dirty: boolean
  onEdit(id: string): void
}) {
  const engineRule = useRuleEngineState(rule.id)
  const toggleEnabled = useRulesStore((s) => s.toggleEnabled)
  const errors = useRulesStore((s) => s.errors)
  const label = useMetaStore((s) => s.label)
  const hasErrors = errors.some((e) => e.ruleId === rule.id)

  const last = engineRule?.lastActions[0]
  const lastText =
    last !== undefined
      ? `${describeAction(last.kind)} ${label(last.target)} → ${String(last.value ?? '')} · ${new Date(last.ts).toLocaleTimeString()}`
      : 'no actions yet'

  return (
    <div className={`rule-card ${hasErrors ? 'rule-card-error' : ''}`}>
      <Switch
        checked={rule.enabled}
        disabled={dirty}
        title={dirty ? 'Save or discard edits first' : 'Pause / resume'}
        onChange={() => void toggleEnabled(rule.id)}
      />
      <button
        type="button"
        className="rule-card-main"
        onClick={() => onEdit(rule.id)}
      >
        <span className="rule-card-name">
          {rule.name}
          {hasErrors && (
            <span className="error-dot" title="Has validation errors" />
          )}
        </span>
        <span className="rule-card-last">{lastText}</span>
      </button>
      {engineRule?.error !== undefined && (
        <span className="badge badge-error" title={engineRule.error}>
          PUT failing
        </span>
      )}
      <DecisionBadge
        rule={engineRule}
        enabled={rule.enabled}
        dryRun={rule.dryRun}
      />
    </div>
  )
}

function describeAction(kind: string): string {
  switch (kind) {
    case 'put':
      return 'set'
    case 'pulseStart':
      return 'pulse'
    case 'pulseEnd':
      return 'pulse end'
    case 'notify':
      return 'notified'
    case 'dryRun':
      return 'would set'
    case 'skippedAlreadySet':
      return 'already at'
    case 'suppressedCooldown':
      return 'suppressed'
    default:
      return kind
  }
}
