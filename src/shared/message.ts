/**
 * Value placeholders in a notification message: `{<self path>}` is
 * replaced with that path's current value when the notification is
 * raised. Anything in braces that is not a path stays literal text.
 */
import type { ConditionT } from './schemas.js'

const PLACEHOLDER_RE = /\{([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)\}/g

/** What a missing or stale value renders as; it never blocks a raise. */
export const MISSING_VALUE = '?'

/** The self paths a rule's conditions read, each once. */
export function conditionPaths(conditions: readonly ConditionT[]): string[] {
  return [...new Set(conditions.flatMap((c) => ('path' in c ? [c.path] : [])))]
}

export function placeholderPaths(message: string): string[] {
  return [...new Set([...message.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!))]
}

export function renderMessage(
  message: string,
  valueOf: (path: string) => string
): string {
  return message.replace(PLACEHOLDER_RE, (_, path: string) => valueOf(path))
}
