import type { Delta, Path, Plugin, ServerAPI } from '@signalk/server-api'
import type { IRouter } from 'express'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Engine } from './engine.js'
import { RulesStore } from './store.js'
import { registerApiRoutes } from './api.js'

const PLUGIN_ID = 'signalk-rules'

const version = ((): string => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(
      readFileSync(join(here, '..', 'package.json'), 'utf-8')
    ) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

interface PluginConfig {
  tickSeconds?: number
  defaultStaleSeconds?: number
  verboseLog?: boolean
}

/**
 * signalk-rules — a simple rules engine for switching automation.
 *
 * The engine lives entirely server-side: it subscribes to the self
 * vessel's deltas, evaluates user-authored rules (conditions ->
 * switch/pulse/notification actions), and issues PUTs that whatever
 * switching plugin registered the path's action handler executes.
 * The webapp (served from public/) edits rules via the REST routes in
 * api.ts and never talks to the bus directly.
 */
const plugin = (app: ServerAPI): Plugin => {
  let engine: Engine | null = null
  let store: RulesStore | null = null

  return {
    id: PLUGIN_ID,
    name: 'Rules',
    description:
      'Simple switching-automation rules: WHEN conditions on Signal K paths THEN switch, pulse or notify',

    schema: () => ({
      type: 'object',
      properties: {
        tickSeconds: {
          type: 'number',
          title: 'Evaluation interval (seconds)',
          description:
            'How often rules re-evaluate between deltas (timers, staleness, time windows)',
          default: 1,
          minimum: 0.5
        },
        defaultStaleSeconds: {
          type: 'number',
          title: 'Input staleness TTL (seconds)',
          description:
            'A condition input older than this counts as missing; 0 disables. Rules can override per condition.',
          default: 300,
          minimum: 0
        },
        verboseLog: {
          type: 'boolean',
          title: 'Verbose decision logging',
          description: 'Log every rule edge to the plugin debug log',
          default: false
        }
      }
    }),

    start: (config: object) => {
      const cfg = config as PluginConfig
      store = new RulesStore(app.getDataDirPath())
      engine = new Engine(
        {
          tickSeconds: cfg.tickSeconds ?? 1,
          defaultStaleSeconds: cfg.defaultStaleSeconds ?? 300,
          verbose: cfg.verboseLog ?? false
        },
        {
          subscribe: (path, cb) =>
            app.streambundle
              .getSelfBus(path as Path)
              .onValue((normalized) => cb(normalized.value)),
          getCurrent: (path) => app.getSelfPath(path),
          put: (path, value, cb) => app.putSelfPath(path, value, cb),
          sendDelta: (delta) => app.handleMessage(PLUGIN_ID, delta as Delta),
          setStatus: (msg) => app.setPluginStatus(msg),
          setError: (msg) => app.setPluginError(msg),
          debug: (msg) => app.debug(msg),
          store
        }
      )
      const { doc, error } = store.loadRules()
      if (error !== undefined) app.setPluginError(error)
      engine.start(doc)
    },

    stop: () => {
      engine?.stop()
      engine = null
      store = null
    },

    registerWithRouter: (router: IRouter) => {
      registerApiRoutes(router, {
        pluginId: PLUGIN_ID,
        version,
        getEngine: () => engine,
        getStore: () => store,
        onError: (msg) => app.setPluginError(msg)
      })
    }
  }
}

export default plugin
