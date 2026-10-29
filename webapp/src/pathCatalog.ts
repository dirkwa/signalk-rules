import { SK_PATH_PATTERN } from '../../src/shared/schemas'
import type { PathMeta } from './api'

/** `switch`: an on/off input; `output`: something a PUT can switch. */
export type PickerKind =
  'switch' | 'output' | 'numeric' | 'string' | 'notification' | 'any'

export type ValueKind = 'number' | 'string' | 'boolean' | 'object' | 'unknown'

export interface SnapshotLeaf {
  kind: ValueKind
  value: unknown
  /** The node's own meta, for when the bulk meta request fails. */
  meta?: PathMeta
}

export interface KnownPath {
  path: string
  lastValueKind: ValueKind
  /** Set in the path's meta by the plugin that handles PUTs on it. */
  supportsPut?: boolean
}

const SWITCH_RE = /^electrical\.switches\..*\.state$/
const NOTIFICATION_PREFIX = 'notifications.'

/** Keys that are never a child path, on any node. */
const META_KEYS = new Set(['meta', 'timestamp', '$source'])

/**
 * Keys a node carries only because it has a value. `values` holds the
 * per-source copies of that value, so walking it would invent paths
 * like `x.values.n2k-on-ve.can0.value`. On a node without a value
 * they are ordinary path segments.
 */
const VALUE_KEYS = new Set(['value', 'values', 'pgn', 'sentence'])

/** Self-level keys that are vessel identity, not data paths. */
const IDENTITY_KEYS = new Set(['uuid', 'mmsi', 'name'])

function kindOf(value: unknown): ValueKind {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'boolean'
  if (value !== null && typeof value === 'object') return 'object'
  return 'unknown'
}

function walk(
  node: unknown,
  prefix: string,
  out: Map<string, SnapshotLeaf>
): void {
  if (node === null || typeof node !== 'object') return
  const obj = node as Record<string, unknown>
  const valued = 'value' in obj && 'timestamp' in obj
  if (valued && prefix !== '') {
    const meta = obj['meta']
    out.set(prefix, {
      kind: kindOf(obj['value']),
      value: obj['value'],
      meta:
        meta !== null && typeof meta === 'object'
          ? (meta as PathMeta)
          : undefined
    })
  }
  // A valued node can still have children of its own, e.g.
  // environment.outside.pressure.threeHoursDelta beside the
  // pressure reading (#20).
  for (const [key, child] of Object.entries(obj)) {
    if (META_KEYS.has(key)) continue
    if (valued && VALUE_KEYS.has(key)) continue
    if (prefix === '' && IDENTITY_KEYS.has(key)) continue
    walk(child, prefix === '' ? key : `${prefix}.${key}`, out)
  }
}

/** Every valued path in a full self snapshot, with its value's kind. */
export function snapshotPaths(snapshot: unknown): Map<string, SnapshotLeaf> {
  const out = new Map<string, SnapshotLeaf>()
  walk(snapshot, '', out)
  return out
}

export function matchesKind(info: KnownPath, kind: PickerKind): boolean {
  const isNotification = info.path.startsWith(NOTIFICATION_PREFIX)
  if (kind === 'notification') return isNotification
  if (isNotification) return false
  switch (kind) {
    case 'switch':
      return SWITCH_RE.test(info.path) || info.lastValueKind === 'boolean'
    case 'output':
      return SWITCH_RE.test(info.path) || info.supportsPut === true
    case 'numeric':
      return info.lastValueKind === 'number' && !SWITCH_RE.test(info.path)
    case 'string':
      return info.lastValueKind === 'string'
    case 'any':
      return true
  }
}

const PATH_RE = new RegExp(SK_PATH_PATTERN)

/**
 * A typed path the list does not offer: one not seen since the server
 * started (published only during an event), or one known only from
 * metadata, whose value kind is therefore unknown. The engine accepts
 * any schema-valid path, so the picker must too (#20).
 *
 * Each refusal below is a path a condition could only ever evaluate
 * `unknown` on, which the rule would hold silently.
 */
export function freeEntryPath(
  query: string,
  kind: PickerKind,
  known: Readonly<Record<string, KnownPath>>
): string | null {
  const path = query.trim()
  if (!PATH_RE.test(path)) return null
  if (path.startsWith(NOTIFICATION_PREFIX) !== (kind === 'notification')) {
    return null
  }
  const info = known[path]
  if (info !== undefined) {
    // Listed already, or its value is of another kind.
    if (matchesKind(info, kind) || info.lastValueKind !== 'unknown') return null
  }
  if (kind === 'switch' && !SWITCH_RE.test(path)) return null
  if (kind === 'numeric' && SWITCH_RE.test(path)) return null
  const lower = path.toLowerCase()
  for (const other of Object.keys(known)) {
    // Signal K paths are case-sensitive: a differently cased copy of a
    // known path would subscribe to nothing.
    if (other !== path && other.toLowerCase() === lower) return null
  }
  return path
}

/**
 * Whether known paths sit beneath `path`. Such a path is offered all
 * the same, since a node can carry a value beside its children (#20),
 * but the picker says so: it may just as well be a branch of the tree.
 */
export function hasChildren(
  path: string,
  known: Readonly<Record<string, KnownPath>>
): boolean {
  const branch = `${path}.`
  return Object.keys(known).some((other) => other.startsWith(branch))
}
