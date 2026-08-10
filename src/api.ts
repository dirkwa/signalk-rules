import type { Request, Response, IRouter } from 'express'
import type { Engine } from './engine.js'
import type { RulesStore } from './store.js'
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
  getEngine(): Engine | null
  getStore(): RulesStore | null
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

  const withEngine = (
    res: Response,
    fn: (engine: Engine, store: RulesStore) => void
  ): void => {
    const engine = deps.getEngine()
    const store = deps.getStore()
    if (engine === null || store === null) {
      res.status(503).json({ error: 'plugin not started' })
      return
    }
    fn(engine, store)
  }

  readonly.get('/status', (_req, res) => {
    res.json({
      ok: deps.getEngine() !== null,
      plugin: deps.pluginId,
      version: deps.version
    })
  })

  readonly.get('/rules', (_req, res) => {
    withEngine(res, (engine) => {
      res.json(engine.getDoc())
    })
  })

  readwrite.put('/rules', (req, res) => {
    withEngine(res, (engine, store) => {
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
          engine.reload(result.doc)
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
    withEngine(res, (engine) => {
      res.json(engine.getState())
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
