import { describe, it, expect } from 'vitest'
import {
  freeEntryPath,
  hasChildren,
  matchesKind,
  snapshotPaths,
  type KnownPath,
  type PickerKind
} from './pathCatalog'

const ts = '2026-10-04T15:00:00.000Z'

// Shaped like GET /signalk/v1/api/vessels/self with signalk-barometer
// running: the pressure node has its own value AND children.
const snapshot = {
  uuid: 'urn:mrn:signalk:uuid:0000',
  name: 'Test',
  environment: {
    outside: {
      pressure: {
        value: 101300,
        timestamp: ts,
        $source: 'bme280.0',
        meta: { units: 'Pa' },
        values: {
          'bme280.0': { value: 101300, timestamp: ts },
          'n2k.can0.1': { value: 101290, timestamp: ts, pgn: 130314 }
        },
        threeHoursDelta: { value: -120, timestamp: ts, $source: 'baro' },
        trend: {
          tendency: { value: 'falling', timestamp: ts, $source: 'trend' },
          severity: { value: 2, timestamp: ts, $source: 'trend' }
        }
      }
    }
  },
  navigation: {
    state: { value: 'anchored', timestamp: ts, $source: 'x' }
  }
}

describe('snapshotPaths', () => {
  const paths = snapshotPaths(snapshot)

  it('keeps a valued node', () => {
    expect(paths.get('environment.outside.pressure')).toEqual({
      kind: 'number',
      value: 101300
    })
  })

  it('records children of a valued node (#20)', () => {
    expect(paths.get('environment.outside.pressure.threeHoursDelta')).toEqual({
      kind: 'number',
      value: -120
    })
    expect(paths.get('environment.outside.pressure.trend.severity')?.kind).toBe(
      'number'
    )
    expect(paths.get('environment.outside.pressure.trend.tendency')?.kind).toBe(
      'string'
    )
  })

  it('does not turn per-source copies or node keys into paths', () => {
    expect([...paths.keys()].sort()).toEqual([
      'environment.outside.pressure',
      'environment.outside.pressure.threeHoursDelta',
      'environment.outside.pressure.trend.severity',
      'environment.outside.pressure.trend.tendency',
      'navigation.state'
    ])
  })

  it('walks value-named segments of a branch without a value', () => {
    const tank = snapshotPaths({
      tanks: { value: { currentLevel: { value: 0.5, timestamp: ts } } }
    })
    expect([...tank.keys()]).toEqual(['tanks.value.currentLevel'])
  })

  it('tolerates a missing snapshot', () => {
    expect(snapshotPaths(null).size).toBe(0)
  })
})

describe('freeEntryPath', () => {
  const known: Record<string, KnownPath> = Object.fromEntries(
    (
      [
        ['environment.outside.pressure', 'number'],
        ['environment.outside.pressure.threeHoursDelta', 'number'],
        ['navigation.state', 'string'],
        ['environment.outside.pressure.trend.outage', 'unknown'],
        ['electrical.switches.bank.0.1.state', 'boolean']
      ] as const
    ).map(([path, lastValueKind]) => [path, { path, lastValueKind }])
  )
  const free = (q: string, kind: PickerKind = 'numeric'): string | null =>
    freeEntryPath(q, kind, known)

  it('offers a valid path not seen yet', () => {
    expect(free('  network.providers.starlink.outage.duration ')).toBe(
      'network.providers.starlink.outage.duration'
    )
  })

  it('offers a path known only from metadata', () => {
    expect(free('environment.outside.pressure.trend.outage')).toBe(
      'environment.outside.pressure.trend.outage'
    )
  })

  it('offers nothing for a partial search or a listed path', () => {
    expect(free('pressure')).toBeNull()
    expect(free('environment.')).toBeNull()
    expect(free('environment.outside.pressure')).toBeNull()
  })

  it('refuses a path whose value is of another kind', () => {
    expect(free('navigation.state')).toBeNull()
  })

  it('refuses a differently cased copy of a known path', () => {
    expect(free('Navigation.State', 'string')).toBeNull()
    expect(free('environment.outside.Pressure')).toBeNull()
  })

  it('offers a parent of known paths, which may get a value later', () => {
    expect(free('environment.outside')).toBe('environment.outside')
    expect(hasChildren('environment.outside', known)).toBe(true)
    expect(hasChildren('environment.outside.pressure.trend', known)).toBe(true)
    expect(hasChildren('network.providers', known)).toBe(false)
  })

  it('offers notifications only to the notification picker', () => {
    const anchor = 'notifications.navigation.anchor'
    expect(free(anchor, 'any')).toBeNull()
    expect(free(anchor, 'string')).toBeNull()
    expect(free(anchor, 'notification')).toBe(anchor)
    expect(free('navigation.anchor.state', 'notification')).toBeNull()
  })

  it('keeps switch and numeric pickers apart', () => {
    const sw = 'electrical.switches.bank.0.2.state'
    expect(free(sw, 'switch')).toBe(sw)
    expect(free(sw)).toBeNull()
    expect(free('electrical.batteries.house.voltage', 'switch')).toBeNull()
  })
})

describe('matchesKind', () => {
  it('lists a switch only in the switch picker', () => {
    const sw: KnownPath = {
      path: 'electrical.switches.bank.0.1.state',
      lastValueKind: 'number'
    }
    expect(matchesKind(sw, 'switch')).toBe(true)
    expect(matchesKind(sw, 'numeric')).toBe(false)
  })

  it('lists a notification only in the notification picker', () => {
    const anchor: KnownPath = {
      path: 'notifications.navigation.anchor',
      lastValueKind: 'object'
    }
    expect(matchesKind(anchor, 'notification')).toBe(true)
    expect(matchesKind(anchor, 'any')).toBe(false)
    const state: KnownPath = {
      path: 'navigation.state',
      lastValueKind: 'string'
    }
    expect(matchesKind(state, 'notification')).toBe(false)
  })
})
