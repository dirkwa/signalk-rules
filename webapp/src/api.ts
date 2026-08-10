import type { RulesDocT } from '../../src/shared/schemas'
import type { ValidationIssue } from '../../src/shared/validate'
import type { EngineState, RuleTestResult } from '../../src/shared/state-types'

const PLUGIN_BASE = '/plugins/signalk-rules'

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return (await res.json()) as T
}

export function getRules(): Promise<RulesDocT> {
  return getJson(`${PLUGIN_BASE}/rules`)
}

export interface SaveResult {
  ok: boolean
  warnings: ValidationIssue[]
  errors?: ValidationIssue[]
  error?: string
}

export async function putRules(doc: RulesDocT): Promise<SaveResult> {
  const res = await fetch(`${PLUGIN_BASE}/rules`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc)
  })
  const body = (await res.json().catch(() => null)) as SaveResult | null
  if (body === null) {
    throw new Error(`save failed: HTTP ${res.status}`)
  }
  if (!res.ok && res.status !== 400) {
    throw new Error(body.error ?? `save failed: HTTP ${res.status}`)
  }
  return body
}

export function getEngineState(): Promise<EngineState> {
  return getJson(`${PLUGIN_BASE}/state`)
}

export async function testRule(id: string): Promise<RuleTestResult> {
  const res = await fetch(
    `${PLUGIN_BASE}/rules/${encodeURIComponent(id)}/test`,
    {
      method: 'POST',
      credentials: 'include'
    }
  )
  if (!res.ok) throw new Error(`test failed: HTTP ${res.status}`)
  return (await res.json()) as RuleTestResult
}

// ---------------------------------------------------------------- SK server

export interface PathMeta {
  displayName?: string
  units?: string
  description?: string
}

/** All self meta keyed by dotted path — the displayName source. */
export function fetchAllMeta(): Promise<Record<string, PathMeta>> {
  return getJson('/signalk/v1/api/vessels/self/meta')
}

export function fetchAvailablePaths(): Promise<string[]> {
  return getJson('/skServer/availablePaths')
}

/** Full self snapshot, walked client-side to classify path value kinds. */
export function fetchSelfSnapshot(): Promise<unknown> {
  return getJson('/signalk/v1/api/vessels/self')
}

/** Persisted server-side in baseDeltas.json — names survive restarts
 *  and appear ecosystem-wide (Data Browser, other webapps). */
export async function putDisplayName(
  path: string,
  displayName: string
): Promise<void> {
  const slashed = path.replace(/\./g, '/')
  const res = await fetch(
    `/signalk/v1/api/vessels/self/${slashed}/meta/displayName`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: displayName })
    }
  )
  if (!res.ok) throw new Error(`rename failed: HTTP ${res.status}`)
}
