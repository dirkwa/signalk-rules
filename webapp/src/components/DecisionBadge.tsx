import type { RuleState } from '../../../src/shared/state-types'

interface DecisionBadgeProps {
  rule: RuleState | undefined
  enabled: boolean
  dryRun: boolean
}

export function DecisionBadge({ rule, enabled, dryRun }: DecisionBadgeProps) {
  if (!enabled) return <span className="badge badge-muted">paused</span>
  if (rule === undefined) return <span className="badge badge-muted">…</span>
  const decision = rule.decision
  const cls =
    decision === 'on'
      ? 'badge-on'
      : decision === 'off'
        ? 'badge-off'
        : 'badge-waiting'
  const label =
    decision === 'unknown'
      ? rule.raw === 'unknown'
        ? 'waiting — no data'
        : 'starting'
      : decision.toUpperCase()
  return (
    <span className={`badge ${cls} ${dryRun ? 'badge-striped' : ''}`}>
      {label}
      {dryRun ? ' · dry run' : ''}
    </span>
  )
}
