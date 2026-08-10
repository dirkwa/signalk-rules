# signalk-rules

A Signal K plugin + webapp: a simple rules engine for switching
automation ("WHEN conditions THEN switch/pulse/notify"), configured in
a sentence-style web UI. Two halves in one npm package:

- **Plugin** (`src/`): the engine. Subscribes to self deltas via
  `app.streambundle.getSelfBus`, evaluates rules, issues switch
  commands via `app.putSelfPath` (whatever plugin registered the
  path's action handler executes them — `signalk-n2k-switching` on the
  reference boat), emits `notifications.*` via `app.handleMessage`.
  Compiled by `tsc` to `plugin/` (ESM, node16).
- **Webapp** (`webapp/`): Vite + React 19 + zustand 5. Builds to
  `public/`, served by SignalK at `/signalk-rules/`. Talks to the
  plugin's REST under `/plugins/signalk-rules/` with implicit cookie
  auth.

## Where to start reading

| File                              | Why                                            |
| --------------------------------- | ---------------------------------------------- |
| `src/shared/schemas.ts`           | **Single source of truth**: TypeBox 1.x rule model, shared by plugin AND webapp |
| `src/shared/validate.ts`          | Structural + semantic validation, same errors on both sides |
| `src/rule-runtime.ts`             | Per-rule decision state machine (holds, edges, reassert) |
| `src/conditions.ts`               | Tri-state condition evaluation incl. hysteresis latch |
| `src/actions.ts`                  | PutExecutor (throttle/retry/timeout) + PulseManager (crash-safe pulses) |
| `src/engine.ts`                   | Orchestration: subscriptions, ticker, effects  |
| `webapp/src/stores/`              | zustand stores: rulesStore (draft/save), liveStore (WS + /state poll), metaStore (displayName) |
| `webapp/src/pages/RuleEditorPage.tsx` | The sentence editor                        |

## Architecture invariants

1. **The schema is shared source.** `src/shared/` is compiled by the
   plugin tsconfig (node16, imports use `./x.js`) AND bundled by Vite
   for the webapp. Files there import **only** `typebox` — no
   server-api, no node builtins, or the webapp build breaks.
2. **TypeBox 1.x** (`typebox` package), not `@sinclair/typebox` 0.x.
   Validation: `Check`/`Errors`/`Default`/`Clone` from
   `typebox/value`; errors are ajv-style with `instancePath`.
3. **Edge-triggered semantics.** Rules command only on decision
   *transitions*; manual overrides stick. `applySetSwitch` compares
   against the last observed actual value and skips the PUT when it
   already agrees (this is also the startup baseline). Only the
   opt-in reassert timer intentionally overrides manual changes.
4. **Unknown holds.** Missing/stale input ⇒ condition `unknown` ⇒
   Kleene combine ⇒ rule holds its committed decision and acts on
   nothing. Never let stale data flap an output.
5. **Durations on monotonic time, timestamps on wall clock.**
   `RuleClock.monoMs` drives holds/cooldowns/pulses so NTP steps can't
   stretch a pulse; wall time is only for display and the time/sun
   conditions.
6. **Pulse safety ordering.** The pulse record is persisted
   synchronously BEFORE the ON-PUT (`PulseManager.start`), start-up
   reverts any record found on disk, `stop()` reverts before
   teardown, and the revert PUT retries forever. Do not reorder.
7. **All PUTs go through PutExecutor** — per-path serialization,
   ≥2 s spacing, latest-wins queueing, one retry, 25 s terminal-reply
   timeout. `putSelfPath`'s promise may resolve PENDING; the terminal
   reply arrives via the update callback.
8. **Raw SI units everywhere in the engine and stored rules.** The
   webapp converts (kn/%/°C) only at input widgets and display
   (`unitConvert.ts`).
9. **One WebSocket** in the webapp (liveStore), subscribed to the
   union of draft-referenced paths; engine truth comes from polling
   `GET /state` (2 s). Reconnect with backoff is deliberate (nav
   station monitoring surface) — don't remove it.
10. **displayName is ecosystem meta.** Renames PUT
    `<path>.meta.displayName` to the SK server (persisted in
    baseDeltas.json server-side) — never keep names in local state
    only.

## REST API (`src/api.ts`)

`GET /status` · `GET /rules` · `PUT /rules` (whole-doc replace,
validate → save → hot `engine.reload`) · `GET /state` (live truth,
absolute timestamps for countdowns) · `POST /rules/:id/test`
(side-effect-free dry evaluation). Registered via `router.access()`
when the server supports it (readonly for GETs, readwrite for
mutations), plain admin-only router otherwise.

## Build / dev workflow

```bash
npm install
npm run dev          # vite at :5174, proxies to $SIGNALK_DEV_URL
npm run build:all    # lint + tsc + webapp typecheck + vite build + vitest
```

Gate: `npm run format && npm run build:all && npm run test`.

Testing: vitest from repo root (`vitest.config.ts` overrides the vite
webapp root). The engine is tested with an injected `EngineClock` +
vitest fake timers; `test/engine.test.ts`'s harness echoes PUTs back
as bus deltas because real switching confirms state on the bus.

## Repo conventions

- Strict TS both tsconfigs (`strict`, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`). `tsconfig.json` needs `"types": ["node"]` —
  TypeScript 6 no longer auto-includes `node_modules/@types`.
- **Every change goes through a PR** — never commit directly to
  `master`. Branch names use hyphens, never slashes.
- **Version bumps live in their own `chore(release): X.Y.Z` PR** with
  no code changes mixed in (CodeRabbit skips review on that title;
  the tag push after merge triggers the npm publish workflow).
- Never auto-commit, never auto-push. No release work unless asked.
- Comments explain WHY, not what. No AI attribution anywhere.
- PRs: succinct, only tests actually performed. No checkboxes.
