import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ServerAPI } from '@signalk/server-api'
import plugin from '../src/index.js'
import type { RulesDocT } from '../src/shared/schemas.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const GEN_RULE_ID = 'cccccccc-1111-2222-3333-444444444444'
const RULES: RulesDocT = {
  version: 1,
  rules: [
    {
      id: GEN_RULE_ID,
      name: 'Gen start',
      enabled: true,
      dryRun: false,
      combinator: 'all',
      conditions: [
        {
          type: 'numeric',
          path: 'electrical.batteries.60.capacity.stateOfCharge',
          operator: 'lt',
          threshold: 0.25
        }
      ],
      actions: [
        {
          type: 'pulse',
          path: 'electrical.switches.bank.50.1.state',
          seconds: 5
        }
      ],
      options: { cooldownSeconds: 1800 }
    }
  ]
}

function fakeServer(opts: { multihelmEnabled: boolean; dataDir?: string }) {
  const dir =
    opts.dataDir ?? mkdtempSync(path.join(tmpdir(), 'sk-rules-plugin-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'rules.json'), JSON.stringify(RULES))
  const history: ({ value: unknown } | undefined)[] = [undefined]
  const listeners: ((v: typeof history) => void)[] = []
  const errors: string[] = []
  let roleCb: ((role: string) => void) | null = null
  const app = {
    getDataDirPath: () => dir,
    streambundle: {
      getSelfBus: () => ({ onValue: () => () => undefined })
    },
    getSelfPath: () => undefined,
    putSelfPath: () => Promise.resolve({ state: 'COMPLETED', statusCode: 200 }),
    handleMessage: () => undefined,
    setPluginStatus: () => undefined,
    setPluginError: (msg: string) => errors.push(msg),
    debug: () => undefined,
    error: () => undefined,
    onPropertyValues: (_name: string, cb: (v: typeof history) => void) => {
      listeners.push(cb)
      cb(history)
      return () => undefined
    },
    getPluginsList: () =>
      Promise.resolve([
        { id: 'signalk-multihelm', enabled: opts.multihelmEnabled }
      ])
  }
  return {
    dir,
    app: app as unknown as ServerAPI,
    errors,
    multihelmStarts(role: string) {
      history.push({
        value: {
          apiVersion: 1,
          registerDataset: () => ({
            changed: () => undefined,
            unregister: () => undefined
          }),
          role: () => role,
          onRoleChanged: (cb: (r: string) => void) => {
            roleCb = cb
            return () => undefined
          }
        }
      })
      for (const cb of listeners) cb(history)
    },
    role: (r: string) => roleCb?.(r),
    lastPulseAt: (): Record<string, number> =>
      (
        JSON.parse(
          readFileSync(path.join(dir, 'runtime-state.json'), 'utf-8')
        ) as {
          lastPulseAt: Record<string, number>
        }
      ).lastPulseAt
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the plugin and Multihelm', () => {
  it('takes over with cooldowns armed when a server running alone becomes the master', async () => {
    const s = fakeServer({ multihelmEnabled: false })
    const p = plugin(s.app)
    p.start({}, () => undefined)
    await settle()
    expect(s.lastPulseAt()[GEN_RULE_ID]).toBeUndefined()

    s.multihelmStarts('master')
    expect(s.lastPulseAt()[GEN_RULE_ID]).toBeTypeOf('number')
    void p.stop()
  })

  it('reports a start that fails and runs no half-started engine', async () => {
    const s = fakeServer({ multihelmEnabled: false })
    const broken = {
      ...s.app,
      streambundle: {
        getSelfBus: () => {
          throw new Error('bus gone')
        }
      }
    } as unknown as ServerAPI
    const p = plugin(broken)
    p.start({}, () => undefined)
    await settle()
    expect(s.errors.some((e) => e.includes('bus gone'))).toBe(true)
    void p.stop()
  })

  it('stands down as a member and starts again as the master', async () => {
    vi.useFakeTimers()
    try {
      const s = fakeServer({ multihelmEnabled: true })
      s.multihelmStarts('member')
      const p = plugin(s.app)
      p.start({}, () => undefined)
      await vi.advanceTimersByTimeAsync(0)
      s.role('master')
      expect(s.lastPulseAt()[GEN_RULE_ID]).toBeTypeOf('number')
      s.role('member')
      void p.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
