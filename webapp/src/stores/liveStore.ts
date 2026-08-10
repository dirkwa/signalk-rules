import { create } from 'zustand'
import type { EngineState } from '../../../src/shared/state-types'
import { getEngineState } from '../api'

interface LiveState {
  /** Latest raw SK values for every path referenced by the draft. */
  values: Record<string, unknown>
  wsConnected: boolean
  engine: EngineState | null
  engineError: boolean
  syncSubscriptions(paths: string[]): void
  startPolling(): void
  stopPolling(): void
}

interface DeltaMessage {
  updates?: Array<{
    values?: Array<{ path?: string; value?: unknown }>
  }>
}

const POLL_MS = 2000
const BACKOFF_MAX_MS = 15_000

/**
 * One WebSocket for live condition values (hmi-designer pattern,
 * lifted into a store so it survives tab switches) plus a 2 s poll of
 * the engine's /state. Unlike the designer this IS a monitoring
 * surface people leave open at the nav station, so both channels
 * reconnect with backoff and the UI shows a banner while down.
 */
export const useLiveStore = create<LiveState>()((set) => {
  let ws: WebSocket | null = null
  let subscribed: string[] = []
  let retryMs = 1000
  let reconnectTimer: number | null = null
  let closedByUs = false

  let pollTimer: number | null = null
  let pollUsers = 0

  function connect(): void {
    closedByUs = false
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(
      `${proto}://${location.host}/signalk/v1/stream?subscribe=none`
    )
    ws.onopen = () => {
      retryMs = 1000
      set({ wsConnected: true })
      sendSubscribe()
    }
    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: DeltaMessage
      try {
        msg = JSON.parse(ev.data) as DeltaMessage
      } catch {
        return
      }
      if (!Array.isArray(msg.updates)) return
      let changed: Record<string, unknown> | null = null
      for (const update of msg.updates) {
        if (!Array.isArray(update.values)) continue
        for (const pv of update.values) {
          if (typeof pv.path === 'string' && pv.path.length > 0) {
            changed ??= {}
            changed[pv.path] = pv.value
          }
        }
      }
      if (changed !== null) {
        set((s) => ({ values: { ...s.values, ...changed } }))
      }
    }
    ws.onclose = () => {
      ws = null
      set({ wsConnected: false })
      if (closedByUs) return
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        connect()
      }, retryMs)
      retryMs = Math.min(retryMs * 2, BACKOFF_MAX_MS)
    }
    ws.onerror = () => {
      ws?.close()
    }
  }

  function sendSubscribe(): void {
    if (ws === null || ws.readyState !== WebSocket.OPEN) return
    if (subscribed.length === 0) return
    ws.send(
      JSON.stringify({
        context: 'vessels.self',
        subscribe: subscribed.map((path) => ({ path, period: 1000 }))
      })
    )
  }

  async function poll(): Promise<void> {
    try {
      const engine = await getEngineState()
      set({ engine, engineError: false })
    } catch {
      set({ engineError: true })
    }
  }

  return {
    values: {},
    wsConnected: false,
    engine: null,
    engineError: false,

    syncSubscriptions: (paths) => {
      const next = [...new Set(paths)].sort()
      if (next.join('\n') === subscribed.join('\n')) return
      subscribed = next
      // One connection total; a changed set means reconnect (rare —
      // only when rule edits touch new paths).
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws !== null) {
        closedByUs = true
        ws.close()
        ws = null
      }
      if (subscribed.length > 0) connect()
      else set({ wsConnected: false })
    },

    startPolling: () => {
      pollUsers++
      if (pollTimer === null) {
        void poll()
        pollTimer = window.setInterval(() => void poll(), POLL_MS)
      }
    },

    stopPolling: () => {
      pollUsers = Math.max(0, pollUsers - 1)
      if (pollUsers === 0 && pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  }
})

/** The engine state for one rule, selected narrowly per component. */
export const useRuleEngineState = (
  ruleId: string
): EngineState['rules'][number] | undefined =>
  useLiveStore((s) => s.engine?.rules.find((r) => r.id === ruleId))
