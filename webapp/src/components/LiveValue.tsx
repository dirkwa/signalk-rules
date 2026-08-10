import { useLiveStore } from '../stores/liveStore'
import { useMetaStore } from '../stores/metaStore'
import { formatValue } from '../unitConvert'
import type { Tri } from '../../../src/shared/state-types'

interface LiveValueProps {
  path: string
  /** Engine truth for this condition, when the rule is saved+enabled. */
  truth?: Tri
  stale?: boolean
}

/** Inline "live: 3.4 A ✓" chip next to a condition row. */
export function LiveValue({ path, truth, stale }: LiveValueProps) {
  const value = useLiveStore((s) => s.values[path])
  const units = useMetaStore((s) => s.paths[path]?.units)
  const shown = value !== undefined ? formatValue(value, units) : '—'
  return (
    <span className={`live-value ${stale ? 'live-stale' : ''}`}>
      {shown}
      {stale ? ' (stale)' : ''}
      {truth === 'true' && <span className="truth truth-yes">✓</span>}
      {truth === 'false' && <span className="truth truth-no">—</span>}
      {truth === 'unknown' && <span className="truth truth-unknown">?</span>}
    </span>
  )
}
