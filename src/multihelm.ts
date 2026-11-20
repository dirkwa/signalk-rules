import { copyFile, readFile, rename, rm, stat } from 'node:fs/promises'
import type { RulesDocT } from './shared/schemas.js'
import { validateRulesDoc } from './shared/validate.js'

/**
 * The part of signalk-multihelm's API this plugin uses. Multihelm is a
 * peer plugin: it publishes the API as the PropertyValue `multihelm`,
 * `{ apiVersion: 1 }` without methods once it has stopped.
 */
export const MULTIHELM_PROPERTY = 'multihelm'
export const MULTIHELM_PLUGIN_ID = 'signalk-multihelm'
const MULTIHELM_API_VERSION = 1
const PLUGIN_LIST_RETRY_MS = 30_000

export type Role = 'master' | 'member'

export interface DatasetEntry {
  key: string
  meta: unknown
  files: { name: string; path: string; size: number; mtimeMs: number }[]
}

export interface IncomingEntry {
  key: string
  meta: unknown
  files: { name: string; path: string; unchanged: boolean }[]
}

export interface DatasetDefinition {
  id: string
  list: () => Promise<DatasetEntry[]>
  apply: (entry: IncomingEntry) => Promise<void>
  remove: (key: string) => Promise<boolean>
  isValidKey?: (key: string) => boolean
}

export interface DatasetHandle {
  changed: () => void
  unregister: () => void
}

interface MultihelmApi {
  registerDataset: (definition: DatasetDefinition) => DatasetHandle
  role: () => Role
  onRoleChanged: (cb: (role: Role) => void) => () => void
}

function multihelmApi(value: unknown): MultihelmApi | null {
  if (value === null || typeof value !== 'object') return null
  const v = value as Partial<MultihelmApi> & { apiVersion?: unknown }
  if (v.apiVersion !== MULTIHELM_API_VERSION) return null
  return typeof v.registerDataset === 'function' &&
    typeof v.role === 'function' &&
    typeof v.onRoleChanged === 'function'
    ? (v as MultihelmApi)
    : null
}

export const RULES_DATASET = 'signalk-rules/rules'
const RULES_KEY = 'rules'
const RULES_FILE_NAME = 'rules.json'

export interface RulesDatasetHost {
  rulesFile(): string
  /** A peer's rules, checked, are in place: run them. */
  rulesReplaced(doc: RulesDocT): void
}

/** The rules document as one entry, so every server runs the same rules. */
export function rulesDataset(host: RulesDatasetHost): DatasetDefinition {
  return {
    id: RULES_DATASET,
    isValidKey: (key) => key === RULES_KEY,

    list: async () => {
      const file = host.rulesFile()
      let info
      try {
        info = await stat(file)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      return [
        {
          key: RULES_KEY,
          meta: null,
          files: [
            {
              name: RULES_FILE_NAME,
              path: file,
              size: info.size,
              mtimeMs: info.mtimeMs
            }
          ]
        }
      ]
    },

    apply: async (entry) => {
      const incoming = entry.files.find((f) => f.name === RULES_FILE_NAME)
      if (incoming === undefined || entry.files.length !== 1) {
        throw new Error('the rules entry has exactly one file, rules.json')
      }
      const parsed: unknown = JSON.parse(await readFile(incoming.path, 'utf-8'))
      const result = validateRulesDoc(parsed)
      if (!result.ok) {
        const first = result.errors[0]
        throw new Error(
          `the peer's rules are invalid here: ${first?.path ?? ''} ${first?.message ?? ''}`
        )
      }
      if (!incoming.unchanged) {
        // Byte for byte, so the peers see the same file and do not send it back.
        const file = host.rulesFile()
        const tmp = `${file}.multihelm`
        try {
          await copyFile(incoming.path, tmp)
          await rename(tmp, file)
        } finally {
          await rm(tmp, { force: true })
        }
      }
      host.rulesReplaced(result.doc)
    },

    // The rules document is never deleted, only emptied.
    remove: () => Promise.resolve(false)
  }
}

/**
 * Who runs the rules here. `standalone`: no Multihelm, this server alone.
 * `master` / `member`: Multihelm's role. `waiting`: Multihelm is enabled
 * but has not said yet, or is restarting; nothing runs meanwhile, so two
 * servers never switch the same outputs.
 */
export type Mode = 'standalone' | 'master' | 'member' | 'waiting'

export interface MultihelmHost {
  onPropertyValues(
    name: string,
    cb: (values: ({ value: unknown } | undefined)[]) => void
  ): () => void
  getPluginsList?: () => Promise<{ id: string; enabled: boolean }[]>
}

export interface MultihelmFollower {
  /** The rules changed here: Multihelm looks sooner than its next round. */
  changed(): void
  stop(): void
}

export function followMultihelm(
  app: MultihelmHost,
  dataset: DatasetDefinition,
  onMode: (mode: Mode) => void,
  log: { debug(msg: string): void; error(msg: string): void }
): MultihelmFollower {
  let api: MultihelmApi | null = null
  let handle: DatasetHandle | null = null
  let stopRoles: (() => void) | null = null
  let stopped = false
  // A plugin list answer that comes after Multihelm has spoken is stale.
  let generation = 0

  const release = (): void => {
    stopRoles?.()
    stopRoles = null
    handle?.unregister()
    handle = null
    api = null
  }

  let retry: NodeJS.Timeout | null = null

  const askWhetherEnabled = (): void => {
    const asked = ++generation
    onMode('waiting')
    const list = app.getPluginsList
    if (list === undefined) {
      onMode('standalone')
      return
    }
    const current = (): boolean => !stopped && asked === generation
    list.call(app).then(
      (plugins) => {
        const enabled = plugins.some(
          (p) => p.id === MULTIHELM_PLUGIN_ID && p.enabled
        )
        if (current() && !enabled) onMode('standalone')
      },
      (err: unknown) => {
        if (!current()) return
        // Not knowing whether Multihelm runs, running alone could switch beside a master.
        log.error(
          `cannot tell whether Multihelm is enabled, asking again: ${err instanceof Error ? err.message : String(err)}`
        )
        retry = setTimeout(() => {
          retry = null
          if (current()) askWhetherEnabled()
        }, PLUGIN_LIST_RETRY_MS)
      }
    )
  }

  const unsubscribe = app.onPropertyValues(MULTIHELM_PROPERTY, (values) => {
    const next = multihelmApi(values.at(-1)?.value)
    if (next !== null && next === api) return
    if (next === null && api === null && generation > 0) return
    release()
    if (next === null) {
      askWhetherEnabled()
      return
    }
    generation++
    try {
      handle = next.registerDataset(dataset)
      api = next
      stopRoles = next.onRoleChanged((role) => {
        onMode(role)
      })
      log.debug('Multihelm: rules dataset registered')
      onMode(next.role())
    } catch (err) {
      release()
      log.error(
        `Multihelm: cannot register the rules: ${err instanceof Error ? err.message : String(err)}`
      )
      onMode('waiting')
    }
  })

  return {
    changed: () => handle?.changed(),
    stop: () => {
      stopped = true
      if (retry !== null) clearTimeout(retry)
      unsubscribe()
      release()
    }
  }
}
