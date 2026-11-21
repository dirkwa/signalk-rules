import type { Request, Response, IRouter } from 'express'
import type { Engine } from './engine.js'
import type { RulesStore } from './store.js'
import type { RulesDocT } from './shared/schemas.js'
import type { EngineState } from './shared/state-types.js'
import { validateRulesDoc } from './shared/validate.js'

type Handler = (req: Request, res: Response) => void

/** The subset of routing we need, satisfied both by a plain express
 *  router and by the access-scoped registrar newer servers return. */
interface RouteRegistrar {
  get(path: string, handler: Handler): unknown
  put(path: string, handler: Handler): unknown
  post(path: string, handler: Handler): unknown
}

type AccessRouter = IRouter & {
  access?: (level: 'readonly' | 'readwrite') => RouteRegistrar
}

export interface ApiDeps {
  pluginId: string
  version: string
  /** Null while another server runs the rules. */
  getEngine(): Engine | null
  getStore(): RulesStore | null
  getDoc(): RulesDocT
  /** What `/state` answers while this server runs no rules. */
  standbyState(): EngineState
  rulesSaved(doc: RulesDocT): void
  onError(msg: string): void
}

/**
 * REST under /plugins/signalk-rules. On servers with access-scoped
 * plugin routers, viewing needs "readonly" and editing "readwrite";
 * on older servers everything falls back to the plugin default
 * (admin-only when security is enabled).
 */
export function registerApiRoutes(router: IRouter, deps: ApiDeps): void {
  const r = router as AccessRouter
  const readonly: RouteRegistrar = r.access ? r.access('readonly') : r
  const readwrite: RouteRegistrar = r.access ? r.access('readwrite') : r

  const withStore = (res: Response, fn: (store: RulesStore) => void): void => {
    const store = deps.getStore()
    if (store === null) {
      res.status(503).json({ error: 'plugin not started' })
      return
    }
    fn(store)
  }

  const withEngine = (res: Response, fn: (engine: Engine) => void): void => {
    withStore(res, () => {
      const engine = deps.getEngine()
      if (engine === null) {
        res
          .status(503)
          .json({ error: "another of the boat's servers runs the rules" })
        return
      }
      fn(engine)
    })
  }

  readonly.get('/status', (_req, res) => {
    res.json({
      ok: deps.getEngine() !== null,
      plugin: deps.pluginId,
      version: deps.version
    })
  })

  readonly.get('/rules', (_req, res) => {
    withStore(res, () => {
      res.json(deps.getDoc())
    })
  })

  readwrite.put('/rules', (req, res) => {
    withStore(res, (store) => {
      const result = validateRulesDoc(req.body)
      if (!result.ok) {
        res.status(400).json({
          ok: false,
          errors: result.errors,
          warnings: result.warnings
        })
        return
      }
      store
        .saveRules(result.doc)
        .then(() => {
          deps.rulesSaved(result.doc)
          res.json({ ok: true, warnings: result.warnings })
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          deps.onError(`cannot save rules: ${msg}`)
          res.status(500).json({ ok: false, error: msg })
        })
    })
  })

  readonly.get('/state', (_req, res) => {
    withStore(res, () => {
      res.json(deps.getEngine()?.getState() ?? deps.standbyState())
    })
  })

  readwrite.post('/rules/:id/test', (req, res) => {
    withEngine(res, (engine) => {
      const id = req.params['id']
      const result = typeof id === 'string' ? engine.testRule(id) : null
      if (result === null) {
        res.status(404).json({ error: 'no such rule' })
        return
      }
      res.json(result)
    })
  })
}
