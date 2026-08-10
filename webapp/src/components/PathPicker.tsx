import { useMemo, useState } from 'react'
import { useMetaStore, type PathInfo } from '../stores/metaStore'
import { formatValue } from '../unitConvert'

export type PickerKind = 'switch' | 'numeric' | 'string' | 'any'

interface PathPickerProps {
  kind: PickerKind
  current: string
  onSelect(path: string): void
  onClose(): void
}

const SWITCH_RE = /^electrical\.switches\..*\.state$/

function matchesKind(info: PathInfo, kind: PickerKind): boolean {
  switch (kind) {
    case 'switch':
      return SWITCH_RE.test(info.path)
    case 'numeric':
      return info.lastValueKind === 'number' && !SWITCH_RE.test(info.path)
    case 'string':
      return info.lastValueKind === 'string'
    case 'any':
      return true
  }
}

/** Pinned to the top of the string picker — the classic condition input. */
const STRING_SUGGESTIONS = ['navigation.state']

/**
 * Full-screen searchable path picker. Rows show the displayName in
 * bold with the raw path beneath; the pencil renames by writing
 * meta.displayName back to Signal K, so names improve the whole
 * ecosystem, not just this app.
 */
export function PathPicker({
  kind,
  current,
  onSelect,
  onClose
}: PathPickerProps) {
  const paths = useMetaStore((s) => s.paths)
  const rename = useMetaStore((s) => s.rename)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = Object.values(paths)
      .filter((info) => matchesKind(info, kind))
      .filter(
        (info) =>
          q === '' ||
          info.path.toLowerCase().includes(q) ||
          (info.displayName?.toLowerCase().includes(q) ?? false)
      )
    all.sort((a, b) => {
      const aPin = STRING_SUGGESTIONS.includes(a.path) ? 0 : 1
      const bPin = STRING_SUGGESTIONS.includes(b.path) ? 0 : 1
      if (aPin !== bPin) return aPin - bPin
      const aNamed = a.displayName !== undefined ? 0 : 1
      const bNamed = b.displayName !== undefined ? 0 : 1
      if (aNamed !== bNamed) return aNamed - bNamed
      return a.path.localeCompare(b.path)
    })
    return all.slice(0, 400)
  }, [paths, kind, query])

  const startRename = (info: PathInfo): void => {
    setEditing(info.path)
    setEditText(info.displayName ?? '')
    setRenameError(null)
  }

  const commitRename = (path: string): void => {
    const name = editText.trim()
    setEditing(null)
    if (name === '') return
    rename(path, name).catch((err: unknown) => {
      setRenameError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <input
            autoFocus
            type="search"
            placeholder={`Search ${kind === 'switch' ? 'switches' : 'paths'}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
        {renameError !== null && (
          <div className="banner banner-error">{renameError}</div>
        )}
        <div className="picker-list">
          {rows.length === 0 && (
            <div className="picker-empty">
              No matching paths seen on this vessel yet.
            </div>
          )}
          {rows.map((info) => (
            <div
              key={info.path}
              className={`picker-row ${info.path === current ? 'picker-row-current' : ''}`}
            >
              <button
                type="button"
                className="picker-row-main"
                onClick={() => {
                  onSelect(info.path)
                  onClose()
                }}
              >
                {editing === info.path ? null : info.displayName !==
                  undefined ? (
                  <>
                    <span className="picker-name">{info.displayName}</span>
                    <span className="picker-path">{info.path}</span>
                  </>
                ) : (
                  <>
                    <span className="picker-name picker-name-raw">
                      {info.path}
                    </span>
                    {kind === 'switch' && (
                      <span className="picker-hint">
                        no name yet — use ✎ to name this switch
                      </span>
                    )}
                  </>
                )}
              </button>
              {editing === info.path ? (
                <input
                  autoFocus
                  className="picker-rename"
                  value={editText}
                  placeholder="Display name"
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={() => commitRename(info.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename(info.path)
                    if (e.key === 'Escape') setEditing(null)
                  }}
                />
              ) : (
                <>
                  <span className="picker-value">
                    {formatValue(info.snapshotValue, info.units)}
                  </span>
                  <button
                    type="button"
                    className="btn-icon"
                    title="Rename (sets meta.displayName for every app)"
                    onClick={() => startRename(info)}
                  >
                    ✎
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Button that shows the friendly name and opens the picker. */
export function PathButton({
  kind,
  path,
  onChange,
  invalid
}: {
  kind: PickerKind
  path: string
  onChange(path: string): void
  invalid?: boolean
}) {
  const label = useMetaStore((s) => s.paths[path]?.displayName ?? path)
  const known = useMetaStore((s) => s.paths[path] !== undefined)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={`btn path-btn ${invalid ? 'input-invalid' : ''} ${known ? '' : 'path-btn-unknown'}`}
        title={known ? path : `${path} — never seen on this vessel`}
        onClick={() => setOpen(true)}
      >
        {label}
        {!known && <span className="path-warn"> ⚠</span>}
      </button>
      {open && (
        <PathPicker
          kind={kind}
          current={path}
          onSelect={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}
