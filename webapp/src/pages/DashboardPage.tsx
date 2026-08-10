import { useLiveStore } from '../stores/liveStore'
import { useMetaStore } from '../stores/metaStore'
import { formatValue } from '../unitConvert'
import { Countdown } from '../components/Countdown'
import { DecisionBadge } from '../components/DecisionBadge'
import type { ConditionState, RuleState } from '../../../src/shared/state-types'

/**
 * The "why isn't my generator starting" page: every rule's live
 * condition values, truth ticks, staleness and timers.
 */
export function DashboardPage() {
  const engine = useLiveStore((s) => s.engine)
  const engineError = useLiveStore((s) => s.engineError)

  if (engine === null) {
    return (
      <div className="page">
        {engineError ? 'Cannot reach the rules engine.' : 'Loading…'}
      </div>
    )
  }
  if (engine.rules.length === 0) {
    return <div className="page">No rules yet — create one under Rules.</div>
  }
  return (
    <div className="page">
      {engine.rules.map((rule) => (
        <RuleStatus key={rule.id} rule={rule} />
      ))}
      <div className="engine-info">
        {engine.inputCount} inputs · {engine.staleInputCount} stale · tick{' '}
        {engine.tickSeconds}s
      </div>
    </div>
  )
}

function RuleStatus({ rule }: { rule: RuleState }) {
  return (
    <div className="status-card">
      <div className="status-head">
        <strong>{rule.name}</strong>
        <span className="status-timers">
          {rule.pending !== undefined && (
            <Countdown
              until={rule.pending.firesAt}
              label={`→ ${rule.pending.to} in`}
            />
          )}
          {rule.pulse !== undefined && (
            <Countdown until={rule.pulse.activeUntil} label="pulse ends in" />
          )}
          {rule.cooldownRemainingMs !== undefined && (
            <Countdown
              until={Date.now() + rule.cooldownRemainingMs}
              label="cooldown"
            />
          )}
          {rule.nextReassertAt !== undefined && (
            <Countdown until={rule.nextReassertAt} label="re-assert in" />
          )}
        </span>
        <DecisionBadge
          rule={rule}
          enabled={rule.enabled}
          dryRun={rule.dryRun}
        />
      </div>
      {rule.error !== undefined && (
        <div className="banner banner-error">{rule.error}</div>
      )}
      <div className="status-conditions">
        {rule.conditions.map((cond, i) => (
          <ConditionStatus key={i} cond={cond} />
        ))}
      </div>
      {rule.lastActions.length > 0 && (
        <div className="status-actions">
          {rule.lastActions.map((a, i) => (
            <div key={i} className="status-action">
              <span className="status-action-time">
                {new Date(a.ts).toLocaleTimeString()}
              </span>
              <span>
                {a.kind} {a.target}
                {a.value !== undefined ? ` = ${String(a.value)}` : ''}
              </span>
              <span
                className={a.result === 'failed' ? 'truth-no' : 'status-detail'}
              >
                {a.result === 'failed' ? 'FAILED' : (a.detail ?? '')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConditionStatus({ cond }: { cond: ConditionState }) {
  const label = useMetaStore((s) =>
    cond.path !== undefined ? s.label(cond.path) : ''
  )
  const units = useMetaStore((s) =>
    cond.path !== undefined ? s.paths[cond.path]?.units : undefined
  )
  const tick =
    cond.truth === 'true' ? (
      <span className="truth truth-yes">✓</span>
    ) : cond.truth === 'false' ? (
      <span className="truth truth-no">—</span>
    ) : (
      <span className="truth truth-unknown">?</span>
    )
  return (
    <div className={`status-cond ${cond.stale ? 'live-stale' : ''}`}>
      {tick}
      <span className="status-cond-name">
        {cond.path !== undefined ? label : 'time/sun window'}
      </span>
      <span className="status-cond-value">
        {cond.path !== undefined ? formatValue(cond.value, units) : ''}
        {cond.stale &&
          cond.ageSeconds !== undefined &&
          ` · no data for ${formatAge(cond.ageSeconds)}`}
        {cond.stale && cond.ageSeconds === undefined && ' · never seen'}
      </span>
    </div>
  )
}

function formatAge(seconds: number): string {
  if (seconds < 90) return `${seconds}s`
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h`
}
