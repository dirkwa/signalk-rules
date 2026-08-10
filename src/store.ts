import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  promises as fsp
} from 'node:fs'
import path from 'node:path'
import { EMPTY_RULES_DOC, type RulesDocT } from './shared/schemas.js'
import { validateRulesDoc } from './shared/validate.js'
import type { PersistedPulse } from './actions.js'
import type { Position } from './sun.js'

const RULES_FILE = 'rules.json'
const RUNTIME_FILE = 'runtime-state.json'

export interface RuntimeStateFile {
  pulses: PersistedPulse[]
  lastPulseAt: Record<string, number>
  lastPosition: Position | null
}

const EMPTY_RUNTIME_STATE: RuntimeStateFile = {
  pulses: [],
  lastPulseAt: {},
  lastPosition: null
}

/**
 * rules.json + runtime-state.json in the plugin's data dir. All writes
 * are atomic (tmp + rename). Runtime state writes are synchronous —
 * they gate pulse safety and must hit disk before the PUT goes out.
 */
export class RulesStore {
  constructor(private readonly dir: string) {}

  private file(name: string): string {
    return path.join(this.dir, name)
  }

  loadRules(): { doc: RulesDocT; error?: string } {
    let raw: string
    try {
      raw = readFileSync(this.file(RULES_FILE), 'utf-8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return { doc: EMPTY_RULES_DOC }
      return {
        doc: EMPTY_RULES_DOC,
        error: `cannot read rules.json: ${e.message}`
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { doc: EMPTY_RULES_DOC, error: 'rules.json is not valid JSON' }
    }
    const result = validateRulesDoc(parsed)
    if (!result.ok) {
      const first = result.errors[0]
      return {
        doc: EMPTY_RULES_DOC,
        error: `rules.json is invalid: ${first?.path ?? ''} ${first?.message ?? ''}`
      }
    }
    return { doc: result.doc }
  }

  async saveRules(doc: RulesDocT): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    const file = this.file(RULES_FILE)
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2))
    await fsp.rename(tmp, file)
  }

  loadRuntimeState(): RuntimeStateFile {
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(this.file(RUNTIME_FILE), 'utf-8')
      )
      if (parsed === null || typeof parsed !== 'object') {
        return EMPTY_RUNTIME_STATE
      }
      const p = parsed as Partial<RuntimeStateFile>
      return {
        pulses: Array.isArray(p.pulses) ? p.pulses : [],
        lastPulseAt:
          p.lastPulseAt !== null && typeof p.lastPulseAt === 'object'
            ? (p.lastPulseAt as Record<string, number>)
            : {},
        lastPosition: p.lastPosition ?? null
      }
    } catch {
      return EMPTY_RUNTIME_STATE
    }
  }

  saveRuntimeStateSync(state: RuntimeStateFile): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = this.file(RUNTIME_FILE)
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(state))
      renameSync(tmp, file)
    } catch (err) {
      // Losing runtime state degrades safety margins (cooldown resets,
      // pulse recovery) but must never take the engine down.
      console.error(
        `signalk-rules: cannot persist runtime state: ${String(err)}`
      )
    }
  }
}
