import { create } from 'zustand'
import type { RuleT, RulesDocT } from '../../../src/shared/schemas'
import {
  validateRulesDoc,
  type ValidationIssue
} from '../../../src/shared/validate'
import { getRules, putRules } from '../api'
import { useLiveStore } from './liveStore'

interface RulesState {
  saved: RulesDocT | null
  draft: RulesDocT | null
  dirty: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  loading: boolean
  loadError: string | null
  saving: boolean
  saveError: string | null

  load(): Promise<void>
  setDraft(doc: RulesDocT): void
  updateRule(id: string, patch: Partial<RuleT>): void
  addRule(template: Omit<RuleT, 'id'>): string
  removeRule(id: string): void
  /** Instant pause/resume — only when there are no unsaved edits. */
  toggleEnabled(id: string): Promise<void>
  save(): Promise<void>
  discard(): void
}

/**
 * crypto.randomUUID is secure-context-only and boat servers are
 * typically plain HTTP on the LAN — fall back to a v4 UUID built from
 * getRandomValues, which works in insecure contexts too.
 */
function newRuleId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function pathsOf(doc: RulesDocT | null): string[] {
  if (doc === null) return []
  const paths = new Set<string>()
  for (const rule of doc.rules) {
    for (const cond of rule.conditions) {
      if ('path' in cond) paths.add(cond.path)
    }
    for (const action of rule.actions) {
      if (action.type === 'setSwitch' || action.type === 'pulse') {
        paths.add(action.path)
      }
    }
  }
  return [...paths]
}

function validate(doc: RulesDocT): {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
} {
  const result = validateRulesDoc(doc)
  if (result.ok) return { errors: [], warnings: result.warnings }
  return { errors: result.errors, warnings: result.warnings }
}

export const useRulesStore = create<RulesState>()((set, get) => {
  const afterDraftChange = (draft: RulesDocT): void => {
    const { errors, warnings } = validate(draft)
    set({ draft, dirty: true, errors, warnings })
    useLiveStore.getState().syncSubscriptions(pathsOf(draft))
  }

  return {
    saved: null,
    draft: null,
    dirty: false,
    errors: [],
    warnings: [],
    loading: false,
    loadError: null,
    saving: false,
    saveError: null,

    load: async () => {
      set({ loading: true, loadError: null })
      try {
        const doc = await getRules()
        const { errors, warnings } = validate(doc)
        set({
          saved: doc,
          draft: structuredClone(doc),
          dirty: false,
          errors,
          warnings,
          loading: false
        })
        useLiveStore.getState().syncSubscriptions(pathsOf(doc))
      } catch (err) {
        set({
          loading: false,
          loadError: err instanceof Error ? err.message : String(err)
        })
      }
    },

    setDraft: (doc) => afterDraftChange(doc),

    updateRule: (id, patch) => {
      const draft = get().draft
      if (draft === null) return
      afterDraftChange({
        ...draft,
        rules: draft.rules.map((r) => (r.id === id ? { ...r, ...patch } : r))
      })
    },

    addRule: (template) => {
      const draft = get().draft ?? { version: 1 as const, rules: [] }
      const id = newRuleId()
      afterDraftChange({
        ...draft,
        rules: [...draft.rules, { ...template, id }]
      })
      return id
    },

    removeRule: (id) => {
      const draft = get().draft
      if (draft === null) return
      afterDraftChange({
        ...draft,
        rules: draft.rules.filter((r) => r.id !== id)
      })
    },

    toggleEnabled: async (id) => {
      const { saved, dirty } = get()
      if (saved === null || dirty) return
      const doc: RulesDocT = {
        ...saved,
        rules: saved.rules.map((r) =>
          r.id === id ? { ...r, enabled: !r.enabled } : r
        )
      }
      set({ saving: true, saveError: null })
      try {
        const result = await putRules(doc)
        if (!result.ok) {
          throw new Error(result.errors?.[0]?.message ?? 'save rejected')
        }
        set({
          saved: doc,
          draft: structuredClone(doc),
          dirty: false,
          warnings: result.warnings,
          saving: false
        })
      } catch (err) {
        set({
          saving: false,
          saveError: err instanceof Error ? err.message : String(err)
        })
      }
    },

    save: async () => {
      const { draft, errors } = get()
      if (draft === null || errors.length > 0) return
      set({ saving: true, saveError: null })
      try {
        const result = await putRules(draft)
        if (!result.ok) {
          throw new Error(result.errors?.[0]?.message ?? 'save rejected')
        }
        set({
          saved: structuredClone(draft),
          dirty: false,
          warnings: result.warnings,
          saving: false
        })
      } catch (err) {
        set({
          saving: false,
          saveError: err instanceof Error ? err.message : String(err)
        })
      }
    },

    discard: () => {
      const saved = get().saved
      if (saved === null) return
      const { errors, warnings } = validate(saved)
      set({
        draft: structuredClone(saved),
        dirty: false,
        errors,
        warnings,
        saveError: null
      })
      useLiveStore.getState().syncSubscriptions(pathsOf(saved))
    }
  }
})
