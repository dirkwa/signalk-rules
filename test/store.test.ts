import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RulesStore } from '../src/store.js'

let dir: string
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('RulesStore runtime state', () => {
  it('reads back only whole decisions', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sk-rules-store-'))
    const kept = { decision: 'on', sinceWall: 1000, actionsKey: '{}' }
    writeFileSync(
      path.join(dir, 'runtime-state.json'),
      JSON.stringify({
        pulses: [],
        lastPulseAt: {},
        lastPosition: null,
        decisions: {
          'aaaaaaaa-0000': kept,
          'bbbbbbbb-0000': { decision: 'maybe', sinceWall: 1, actionsKey: '' },
          'cccccccc-0000': { decision: 'off', actionsKey: '' },
          'dddddddd-0000': 5
        }
      })
    )
    expect(new RulesStore(dir).loadRuntimeState().decisions).toEqual({
      'aaaaaaaa-0000': kept
    })
  })

  it('reads a file from before decisions were kept', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sk-rules-store-'))
    writeFileSync(
      path.join(dir, 'runtime-state.json'),
      JSON.stringify({ pulses: [], lastPulseAt: {}, lastPosition: null })
    )
    expect(new RulesStore(dir).loadRuntimeState().decisions).toEqual({})
  })
})
