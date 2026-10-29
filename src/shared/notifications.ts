/**
 * Reading Signal K notification values: `{ state, method, message }`
 * while raised, `null` once cleared.
 */
import { RAISED_STATES, type NotificationConditionT } from './schemas.js'

const NOT_RAISED = new Set(['normal', 'nominal'])

/** The state of a notification value; null when cleared or never set,
 *  undefined when the value is not a notification at all. */
export function notificationState(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') return undefined
  const state = (value as { state?: unknown }).state
  return typeof state === 'string' ? state : undefined
}

/** Whether a notification value is raised at `atLeast` or worse;
 *  undefined for a state this package does not know. */
export function isRaisedAtLeast(
  value: unknown,
  atLeast: NotificationConditionT['atLeast']
): boolean | undefined {
  const state = notificationState(value)
  if (state === undefined) return undefined
  if (state === null || NOT_RAISED.has(state)) return false
  const rank = (RAISED_STATES as readonly string[]).indexOf(state)
  if (rank < 0) return undefined
  return rank >= RAISED_STATES.indexOf(atLeast)
}
