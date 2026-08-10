import type { ConditionT, NumericConditionT } from '../../../src/shared/schemas'
import type { ConditionState } from '../../../src/shared/state-types'
import { LiveValue } from './LiveValue'
import { NumberWithUnit } from './NumberWithUnit'
import { PathButton } from './PathPicker'
import { useMetaStore } from '../stores/metaStore'
import { unitFor } from '../unitConvert'

const OPERATOR_LABELS: Record<NumericConditionT['operator'], string> = {
  gt: 'is above',
  gte: 'is at least',
  lt: 'is below',
  lte: 'is at most',
  eq: 'equals',
  ne: 'is not'
}

interface ConditionRowProps {
  cond: ConditionT
  engineState?: ConditionState
  showAdvanced: boolean
  onChange(next: ConditionT): void
  onRemove(): void
  errorFields: Set<string>
}

export function ConditionRow({
  cond,
  engineState,
  showAdvanced,
  onChange,
  onRemove,
  errorFields
}: ConditionRowProps) {
  return (
    <div className="cond-row">
      <div className="cond-main">
        {cond.negate === true && <span className="negate-chip">NOT</span>}
        <ConditionInputs
          cond={cond}
          onChange={onChange}
          errorFields={errorFields}
        />
        {'path' in cond && (
          <LiveValue
            path={cond.path}
            truth={engineState?.truth}
            stale={engineState?.stale}
          />
        )}
      </div>
      {showAdvanced && (
        <div className="cond-advanced">
          <label className="check">
            <input
              type="checkbox"
              checked={cond.negate === true}
              onChange={(e) =>
                onChange({
                  ...cond,
                  negate: e.target.checked ? true : undefined
                })
              }
            />
            invert (NOT)
          </label>
          {cond.type === 'numeric' && (
            <HysteresisInput
              cond={cond}
              onChange={onChange}
              errorFields={errorFields}
            />
          )}
          {'path' in cond && (
            <label className="mini-field">
              stale after
              <input
                type="number"
                min={0}
                className="input-small"
                value={cond.staleSeconds ?? ''}
                placeholder="default"
                onChange={(e) =>
                  onChange({
                    ...cond,
                    staleSeconds:
                      e.target.value === '' ? undefined : Number(e.target.value)
                  })
                }
              />
              s
            </label>
          )}
        </div>
      )}
      <button
        type="button"
        className="btn-icon cond-remove"
        title="Remove condition"
        onClick={onRemove}
      >
        ✕
      </button>
    </div>
  )
}

function ConditionInputs({
  cond,
  onChange,
  errorFields
}: {
  cond: ConditionT
  onChange(next: ConditionT): void
  errorFields: Set<string>
}) {
  switch (cond.type) {
    case 'numeric':
      return (
        <>
          <PathButton
            kind="numeric"
            path={cond.path}
            invalid={errorFields.has('path')}
            onChange={(path) => onChange({ ...cond, path })}
          />
          <select
            value={cond.operator}
            onChange={(e) =>
              onChange({
                ...cond,
                operator: e.target.value as NumericConditionT['operator']
              })
            }
          >
            {Object.entries(OPERATOR_LABELS).map(([op, label]) => (
              <option key={op} value={op}>
                {label}
              </option>
            ))}
          </select>
          <NumberWithUnit
            path={cond.path}
            value={cond.threshold}
            invalid={errorFields.has('threshold')}
            onChange={(threshold) => onChange({ ...cond, threshold })}
          />
        </>
      )
    case 'switch':
      return (
        <>
          <PathButton
            kind="switch"
            path={cond.path}
            invalid={errorFields.has('path')}
            onChange={(path) => onChange({ ...cond, path })}
          />
          <span>is</span>
          <select
            value={cond.equals}
            onChange={(e) =>
              onChange({
                ...cond,
                equals: Number(e.target.value) === 1 ? 1 : 0
              })
            }
          >
            <option value={1}>on</option>
            <option value={0}>off</option>
          </select>
        </>
      )
    case 'string':
      return (
        <>
          <PathButton
            kind="string"
            path={cond.path}
            invalid={errorFields.has('path')}
            onChange={(path) => onChange({ ...cond, path })}
          />
          <span>is</span>
          <input
            type="text"
            className={errorFields.has('equals') ? 'input-invalid' : ''}
            value={cond.equals}
            list="string-suggestions"
            onChange={(e) => onChange({ ...cond, equals: e.target.value })}
          />
          <datalist id="string-suggestions">
            <option value="anchored" />
            <option value="moored" />
            <option value="sailing" />
            <option value="motoring" />
          </datalist>
        </>
      )
    case 'timeOfDay':
      return (
        <>
          <span>time is between</span>
          <input
            type="time"
            value={cond.from}
            onChange={(e) => onChange({ ...cond, from: e.target.value })}
          />
          <span>and</span>
          <input
            type="time"
            value={cond.to}
            onChange={(e) => onChange({ ...cond, to: e.target.value })}
          />
        </>
      )
    case 'sun':
      return (
        <>
          <span>it is</span>
          <select
            value={cond.during}
            onChange={(e) =>
              onChange({
                ...cond,
                during: e.target.value === 'night' ? 'night' : 'day'
              })
            }
          >
            <option value="day">daytime</option>
            <option value="night">night</option>
          </select>
          <span className="hint">(sunrise/sunset at vessel position)</span>
        </>
      )
  }
}

function HysteresisInput({
  cond,
  onChange,
  errorFields
}: {
  cond: NumericConditionT
  onChange(next: ConditionT): void
  errorFields: Set<string>
}) {
  const units = useMetaStore((s) => s.paths[cond.path]?.units)
  const u = unitFor(units)
  const enabled = cond.clearThreshold !== undefined
  const canHyst = cond.operator !== 'eq' && cond.operator !== 'ne'
  if (!canHyst) return null
  const releaseDefault =
    cond.operator === 'gt' || cond.operator === 'gte'
      ? cond.threshold / 2
      : cond.threshold * 1.2
  return (
    <label className="mini-field" title="Separate release value stops flapping">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) =>
          onChange({
            ...cond,
            clearThreshold: e.target.checked ? releaseDefault : undefined
          })
        }
      />
      releases at
      {enabled ? (
        <NumberWithUnit
          path={cond.path}
          value={cond.clearThreshold ?? releaseDefault}
          invalid={errorFields.has('clearThreshold')}
          onChange={(clearThreshold) => onChange({ ...cond, clearThreshold })}
        />
      ) : (
        <span className="hint"> {u.display}</span>
      )}
    </label>
  )
}
