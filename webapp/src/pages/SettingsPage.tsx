import { useLiveStore } from '../stores/liveStore'

export function SettingsPage() {
  const engine = useLiveStore((s) => s.engine)
  return (
    <div className="page">
      <h2>Settings</h2>
      <p>
        Engine knobs (evaluation interval, staleness TTL, verbose logging) live
        in the{' '}
        <a href="/admin/#/serverConfiguration/plugins/signalk-rules">
          plugin configuration
        </a>{' '}
        in the admin UI.
      </p>
      {engine !== null && (
        <ul className="settings-list">
          <li>Evaluation tick: {engine.tickSeconds}s</li>
          <li>
            Default staleness TTL:{' '}
            {engine.defaultStaleSeconds === 0
              ? 'disabled'
              : `${engine.defaultStaleSeconds}s`}
          </li>
          <li>Live inputs: {engine.inputCount}</li>
          <li>Engine started: {new Date(engine.startedAt).toLocaleString()}</li>
        </ul>
      )}
      <h3>How rules behave</h3>
      <ul className="settings-list">
        <li>
          Rules are edge-triggered: they command a switch only when their
          decision changes, so manual overrides stick until the next transition
          (unless a rule opts into re-assert).
        </li>
        <li>
          While a condition&apos;s input is missing or stale, the rule holds its
          last decision and shows why on the Dashboard.
        </li>
        <li>
          Pulses are capped at 60 s and revert on plugin restart. For
          safety-critical momentary loads (engine starters), prefer the
          switching hardware&apos;s own momentary/timer channel and let the rule
          merely trigger it — no software can revert an output across a hard
          power loss.
        </li>
      </ul>
      <div className="version">signalk-rules v{__PLUGIN_VERSION__}</div>
    </div>
  )
}
