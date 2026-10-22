import type { ActionT, NotificationActionT } from '../../../src/shared/schemas'
import { PathButton } from './PathPicker'
import { useMetaStore } from '../stores/metaStore'

const STATES: NotificationActionT['state'][] = [
  'normal',
  'alert',
  'warn',
  'alarm',
  'emergency'
]

interface ActionRowProps {
  action: ActionT
  showAdvanced: boolean
  onChange(next: ActionT): void
  onRemove(): void
  canRemove: boolean
  errorFields: Set<string>
  /** Paths the rule's conditions read: the values a message may quote. */
  valuePaths: readonly string[]
}

export function ActionRow({
  action,
  showAdvanced,
  onChange,
  onRemove,
  canRemove,
  errorFields,
  valuePaths
}: ActionRowProps) {
  return (
    <div className="action-row">
      <div className="action-main">
        <select
          value={action.type}
          onChange={(e) => onChange(defaultAction(e.target.value))}
        >
          <option value="setSwitch">switch</option>
          <option value="pulse">pulse</option>
          <option value="notification">notification</option>
        </select>
        <ActionInputs
          action={action}
          showAdvanced={showAdvanced}
          onChange={onChange}
          errorFields={errorFields}
        />
        {action.type === 'notification' && valuePaths.length > 0 && (
          <MessageValues
            paths={valuePaths}
            onInsert={(path) =>
              onChange({ ...action, message: `${action.message} {${path}}` })
            }
          />
        )}
      </div>
      {canRemove && (
        <button
          type="button"
          className="btn-icon"
          title="Remove action"
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </div>
  )
}

/** Inserts `{path}`, which the engine fills with the value when the
 *  notification is raised. */
function MessageValues({
  paths,
  onInsert
}: {
  paths: readonly string[]
  onInsert(path: string): void
}) {
  const known = useMetaStore((s) => s.paths)
  return (
    <span className="message-values">
      <span className="hint">insert value:</span>
      {paths.map((path) => (
        <button
          key={path}
          type="button"
          className="btn"
          title={`Adds {${path}} — replaced with its value when raised`}
          onClick={() => onInsert(path)}
        >
          {known[path]?.displayName ?? path}
        </button>
      ))}
    </span>
  )
}

function defaultAction(type: string): ActionT {
  switch (type) {
    case 'pulse':
      return {
        type: 'pulse',
        path: 'electrical.switches.bank.0.1.state',
        seconds: 30
      }
    case 'notification':
      return {
        type: 'notification',
        pathSuffix: 'rules.alert',
        state: 'alert',
        method: ['visual'],
        message: 'Rule triggered'
      }
    default:
      return { type: 'setSwitch', path: 'electrical.switches.bank.0.1.state' }
  }
}

function ActionInputs({
  action,
  showAdvanced,
  onChange,
  errorFields
}: {
  action: ActionT
  showAdvanced: boolean
  onChange(next: ActionT): void
  errorFields: Set<string>
}) {
  switch (action.type) {
    case 'setSwitch':
      return (
        <>
          <PathButton
            kind="switch"
            path={action.path}
            invalid={errorFields.has('path')}
            onChange={(path) => onChange({ ...action, path })}
          />
          <span className="hint">
            follows the conditions (on when true, off when false)
          </span>
          {showAdvanced && (
            <span className="mini-field">
              on=
              <input
                type="number"
                className="input-small"
                value={action.onValue ?? 1}
                onChange={(e) =>
                  onChange({ ...action, onValue: Number(e.target.value) })
                }
              />
              off=
              <input
                type="number"
                className="input-small"
                value={action.offValue ?? 0}
                onChange={(e) =>
                  onChange({ ...action, offValue: Number(e.target.value) })
                }
              />
            </span>
          )}
        </>
      )
    case 'pulse':
      return (
        <>
          <PathButton
            kind="switch"
            path={action.path}
            invalid={errorFields.has('path')}
            onChange={(path) => onChange({ ...action, path })}
          />
          <span>on for</span>
          <input
            type="number"
            min={1}
            max={60}
            className={`input-small ${errorFields.has('seconds') ? 'input-invalid' : ''}`}
            value={action.seconds}
            onChange={(e) =>
              onChange({ ...action, seconds: Number(e.target.value) })
            }
          />
          <span>s, once per rising edge</span>
        </>
      )
    case 'notification':
      return (
        <>
          <span>notifications.</span>
          <input
            type="text"
            className={errorFields.has('pathSuffix') ? 'input-invalid' : ''}
            value={action.pathSuffix}
            onChange={(e) =>
              onChange({ ...action, pathSuffix: e.target.value })
            }
          />
          <select
            value={action.state}
            onChange={(e) =>
              onChange({
                ...action,
                state: e.target.value as NotificationActionT['state']
              })
            }
          >
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="text"
            className={`input-wide ${errorFields.has('message') ? 'input-invalid' : ''}`}
            placeholder="Message"
            value={action.message}
            onChange={(e) => onChange({ ...action, message: e.target.value })}
          />
          {showAdvanced && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={action.method.includes('sound')}
                  onChange={(e) =>
                    onChange({
                      ...action,
                      method: e.target.checked
                        ? ['visual', 'sound']
                        : ['visual']
                    })
                  }
                />
                sound
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={action.clearOnFalse ?? true}
                  onChange={(e) =>
                    onChange({
                      ...action,
                      clearOnFalse: e.target.checked ? undefined : false
                    })
                  }
                />
                clear when conditions end
              </label>
            </>
          )}
        </>
      )
  }
}
