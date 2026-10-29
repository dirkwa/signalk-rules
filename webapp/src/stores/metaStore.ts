import { create } from 'zustand'
import {
  fetchAllMeta,
  fetchAvailablePaths,
  fetchSelfSnapshot,
  putDisplayName
} from '../api'
import { snapshotPaths, type ValueKind } from '../pathCatalog'

export type { ValueKind }

export interface PathInfo {
  path: string
  displayName?: string
  units?: string
  description?: string
  lastValueKind: ValueKind
  /** Value captured from the one-shot snapshot at load time. */
  snapshotValue?: unknown
}

interface MetaState {
  paths: Record<string, PathInfo>
  loaded: boolean
  loadError: string | null
  load(): Promise<void>
  rename(path: string, displayName: string): Promise<void>
  label(path: string): string
}

export const useMetaStore = create<MetaState>()((set, get) => ({
  paths: {},
  loaded: false,
  loadError: null,

  load: async () => {
    try {
      const [meta, avail, snapshot] = await Promise.all([
        fetchAllMeta().catch(
          () => ({}) as Awaited<ReturnType<typeof fetchAllMeta>>
        ),
        fetchAvailablePaths().catch(() => [] as string[]),
        fetchSelfSnapshot().catch(() => null)
      ])
      const kinds = snapshotPaths(snapshot)
      const paths: Record<string, PathInfo> = {}
      const add = (path: string): void => {
        if (path === '') return
        const m = meta[path]
        const k = kinds.get(path)
        paths[path] = {
          path,
          displayName:
            typeof m?.displayName === 'string' && m.displayName.length > 0
              ? m.displayName
              : undefined,
          units: typeof m?.units === 'string' ? m.units : undefined,
          description:
            typeof m?.description === 'string' ? m.description : undefined,
          lastValueKind: k?.kind ?? 'unknown',
          snapshotValue: k?.value
        }
      }
      for (const path of kinds.keys()) add(path)
      for (const path of avail) add(path)
      for (const path of Object.keys(meta)) add(path)
      set({ paths, loaded: true, loadError: null })
    } catch (err) {
      set({
        loadError: err instanceof Error ? err.message : String(err),
        loaded: true
      })
    }
  },

  rename: async (path, displayName) => {
    await putDisplayName(path, displayName)
    set((s) => {
      const existing = s.paths[path]
      return {
        paths: {
          ...s.paths,
          [path]: existing
            ? { ...existing, displayName }
            : { path, displayName, lastValueKind: 'unknown' as const }
        }
      }
    })
  },

  label: (path) => get().paths[path]?.displayName ?? path
}))
