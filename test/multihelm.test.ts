import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  followMultihelm,
  rulesDataset,
  type DatasetDefinition,
  type Mode,
  type Role
} from '../src/multihelm.js'
import type { RulesDocT } from '../src/shared/schemas.js'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sk-rules-multihelm-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A server's PropertyValues with Multihelm's value, and its plugin list. */
function server(multihelmEnabled: boolean) {
  const listeners: ((values: ({ value: unknown } | undefined)[]) => void)[] = []
  const history: ({ value: unknown } | undefined)[] = [undefined]
  let roleListener: ((role: Role) => void) | null = null
  let role: Role = 'member'
  const registered: DatasetDefinition[] = []
  let changes = 0
  const api = {
    apiVersion: 1,
    registerDataset: (d: DatasetDefinition) => {
      registered.push(d)
      return {
        changed: () => {
          changes++
        },
        unregister: () => {
          registered.splice(registered.indexOf(d), 1)
        }
      }
    },
    role: () => role,
    onRoleChanged: (cb: (r: Role) => void) => {
      roleListener = cb
      return () => {
        roleListener = null
      }
    }
  }
  return {
    app: {
      onPropertyValues: (
        _name: string,
        cb: (values: ({ value: unknown } | undefined)[]) => void
      ) => {
        listeners.push(cb)
        cb(history)
        return () => listeners.splice(listeners.indexOf(cb), 1)
      },
      getPluginsList: () =>
        Promise.resolve([
          { id: 'signalk-multihelm', enabled: multihelmEnabled }
        ])
    },
    start: () => {
      history.push({ value: api })
      for (const cb of listeners) cb(history)
    },
    stop: () => {
      history.push({ value: { apiVersion: 1 } })
      for (const cb of listeners) cb(history)
    },
    setRole(next: Role) {
      role = next
      roleListener?.(next)
    },
    registered,
    changes: () => changes
  }
}

const noLog = { debug: () => undefined, error: () => undefined }
const dataset: DatasetDefinition = {
  id: 'signalk-rules/rules',
  list: () => Promise.resolve([]),
  apply: () => Promise.resolve(),
  remove: () => Promise.resolve(false)
}

describe('who runs the rules', () => {
  it('runs them alone when Multihelm is not enabled', async () => {
    const s = server(false)
    const modes: Mode[] = []
    followMultihelm(s.app, dataset, (m) => modes.push(m), noLog)
    await settle()
    expect(modes).toEqual(['waiting', 'standalone'])
  })

  it('runs nothing while an enabled Multihelm has not started yet', async () => {
    const s = server(true)
    const modes: Mode[] = []
    followMultihelm(s.app, dataset, (m) => modes.push(m), noLog)
    await settle()
    expect(modes).toEqual(['waiting'])

    s.start()
    expect(modes).toEqual(['waiting', 'member'])
    expect(s.registered).toEqual([dataset])
  })

  it("follows Multihelm's role, and waits while it restarts", async () => {
    const s = server(true)
    s.start()
    const modes: Mode[] = []
    const follower = followMultihelm(
      s.app,
      dataset,
      (m) => modes.push(m),
      noLog
    )
    s.setRole('master')
    follower.changed()
    expect(s.changes()).toBe(1)

    s.stop()
    await settle()
    expect(s.registered).toEqual([])
    expect(modes).toEqual(['member', 'master', 'waiting'])
  })

  it('runs them alone once Multihelm is disabled', async () => {
    const s = server(false)
    s.start()
    const modes: Mode[] = []
    followMultihelm(s.app, dataset, (m) => modes.push(m), noLog)
    s.stop()
    await settle()
    expect(modes).toEqual(['member', 'waiting', 'standalone'])
  })

  it('does not act on a plugin list that answers after Multihelm started', async () => {
    const s = server(false)
    const modes: Mode[] = []
    followMultihelm(s.app, dataset, (m) => modes.push(m), noLog)
    s.start()
    await settle()
    expect(modes).toEqual(['waiting', 'member'])
  })

  it('withdraws the rules when it stops', () => {
    const s = server(true)
    s.start()
    const follower = followMultihelm(s.app, dataset, () => undefined, noLog)
    follower.stop()
    expect(s.registered).toEqual([])
  })
})

const RULES: RulesDocT = { version: 1, rules: [] }

describe('the rules dataset', () => {
  const setup = () => {
    const dir = tempDir()
    const file = path.join(dir, 'rules.json')
    const replaced: RulesDocT[] = []
    const ds = rulesDataset({
      rulesFile: () => file,
      rulesReplaced: (doc) => replaced.push(doc)
    })
    return { dir, file, replaced, ds }
  }

  it('lists nothing before rules were saved, then the rules file', async () => {
    const { file, ds } = setup()
    expect(await ds.list()).toEqual([])
    writeFileSync(file, JSON.stringify(RULES))
    const [entry] = await ds.list()
    expect(entry?.key).toBe('rules')
    expect(entry?.files.map((f) => f.name)).toEqual(['rules.json'])
  })

  it("puts a peer's rules in place byte for byte and runs them", async () => {
    const { dir, file, replaced, ds } = setup()
    const incoming = path.join(dir, 'incoming')
    const text = JSON.stringify(RULES, null, 4)
    writeFileSync(incoming, text)
    await ds.apply({
      key: 'rules',
      meta: null,
      files: [{ name: 'rules.json', path: incoming, unchanged: false }]
    })
    expect(readFileSync(file, 'utf-8')).toBe(text)
    expect(replaced).toHaveLength(1)
  })

  it('refuses rules that do not validate here, and keeps its own', async () => {
    const { dir, file, replaced, ds } = setup()
    writeFileSync(file, JSON.stringify(RULES))
    const incoming = path.join(dir, 'incoming')
    writeFileSync(incoming, JSON.stringify({ version: 99, rules: 'x' }))
    await expect(
      ds.apply({
        key: 'rules',
        meta: null,
        files: [{ name: 'rules.json', path: incoming, unchanged: false }]
      })
    ).rejects.toThrow(/invalid/)
    expect(readFileSync(file, 'utf-8')).toBe(JSON.stringify(RULES))
    expect(replaced).toEqual([])
  })

  it('never deletes the rules for a peer', async () => {
    const { ds } = setup()
    expect(await ds.remove('rules')).toBe(false)
    expect(ds.isValidKey?.('../x')).toBe(false)
  })
})
