import { useEffect, useState } from 'react'
import { pathsOf, useRulesStore } from './stores/rulesStore'
import { useLiveStore } from './stores/liveStore'
import { useMetaStore } from './stores/metaStore'
import { RulesListPage } from './pages/RulesListPage'
import { RuleEditorPage } from './pages/RuleEditorPage'
import { DashboardPage } from './pages/DashboardPage'
import { SettingsPage } from './pages/SettingsPage'

type Tab = 'rules' | 'dashboard' | 'settings'

export function App() {
  const [tab, setTab] = useState<Tab>('rules')
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)

  const load = useRulesStore((s) => s.load)
  const loadMeta = useMetaStore((s) => s.load)
  const startPolling = useLiveStore((s) => s.startPolling)
  const stopPolling = useLiveStore((s) => s.stopPolling)

  const dirty = useRulesStore((s) => s.dirty)
  const saving = useRulesStore((s) => s.saving)
  const errors = useRulesStore((s) => s.errors)
  const saveError = useRulesStore((s) => s.saveError)
  const loadError = useRulesStore((s) => s.loadError)
  const save = useRulesStore((s) => s.save)
  const discard = useRulesStore((s) => s.discard)

  const wsConnected = useLiveStore((s) => s.wsConnected)
  const engineError = useLiveStore((s) => s.engineError)
  // Time/sun-only rules reference no paths, so no WS opens for them —
  // the banner must key on subscribed paths, not on rules existing.
  const anySubscribed = useRulesStore((s) => pathsOf(s.draft).length > 0)

  useEffect(() => {
    void load()
    void loadMeta()
    startPolling()
    return () => stopPolling()
  }, [])

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          Rules <span className="app-version">v{__PLUGIN_VERSION__}</span>
        </h1>
        <nav>
          <button
            type="button"
            className={tab === 'rules' ? 'tab tab-active' : 'tab'}
            onClick={() => {
              setTab('rules')
              setEditingRuleId(null)
            }}
          >
            Rules
          </button>
          <button
            type="button"
            className={tab === 'dashboard' ? 'tab tab-active' : 'tab'}
            onClick={() => setTab('dashboard')}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={tab === 'settings' ? 'tab tab-active' : 'tab'}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </nav>
      </header>

      {(engineError || (!wsConnected && anySubscribed)) && (
        <div className="banner banner-warn">
          Connection lost — reconnecting…
        </div>
      )}
      {loadError !== null && (
        <div className="banner banner-error">
          Cannot load rules: {loadError}
        </div>
      )}
      {saveError !== null && (
        <div className="banner banner-error">Save failed: {saveError}</div>
      )}

      {dirty && (
        <div className="save-bar">
          <span>
            Unsaved changes
            {errors.length > 0 &&
              ` — fix ${errors.length} problem${errors.length === 1 ? '' : 's'} first`}
          </span>
          <button
            type="button"
            className="btn"
            disabled={saving}
            onClick={discard}
          >
            Discard
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || errors.length > 0}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save & apply'}
          </button>
        </div>
      )}

      <main>
        {tab === 'rules' &&
          (editingRuleId !== null ? (
            <RuleEditorPage
              ruleId={editingRuleId}
              onBack={() => setEditingRuleId(null)}
            />
          ) : (
            <RulesListPage onEdit={setEditingRuleId} />
          ))}
        {tab === 'dashboard' && <DashboardPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}
