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
    const kept = {
      decision: 'on',
      sinceWall: 1000,
      actionsKey: '{}',
      latched: [true],
      conditionsKey: '{}'
    }
    writeFileSync(
      path.join(dir, 'runtime-state.json'),
      JSON.stringify({
        pulses: [],
        lastPulseAt: {},
        lastPosition: null,
        decisions: {
          'aaaaaaaa-0000': kept,
          'bbbbbbbb-0000': { ...kept, decision: 'maybe' },
          'cccccccc-0000': { ...kept, sinceWall: undefined },
          'dddddddd-0000': 5,
          // Past the range a Date can hold.
          'eeeeeeee-0000': { ...kept, sinceWall: 8.64e15 + 1 },
          'ffffffff-0000': { ...kept, latched: [1] },
          'gggggggg-0000': { ...kept, conditionsKey: undefined },
          // JSON.parse reads 1e999 as Infinity.
          'hhhhhhhh-0000': { ...kept, sinceWall: 7777 }
        }
      }).replace('"sinceWall":7777', '"sinceWall":1e999')
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
