// Results of go to definition (when there are several) and find references: a panel floating over the code,
// like an IDE's references popup. Stays open while you click through the results; Esc or × closes it.

import { useEffect } from 'react'
import type { CodeLocation } from '../../../shared/types'
import { Loading } from './Loading'

export interface NavResults {
  kind: 'def' | 'refs'
  word: string
  locations: CodeLocation[] | null
  truncated?: boolean
  error?: string
}

export function NavResultsPopup({ nav, onClose, onOpen }: { nav: NavResults; onClose: () => void; onOpen: (path: string, line: number) => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  const byFile = new Map<string, CodeLocation[]>()
  for (const l of nav.locations ?? []) byFile.set(l.path, [...(byFile.get(l.path) ?? []), l])
  return (
    <div className="nav-popup" role="dialog">
      <div className="row nav-popup-head">
        <strong className="spacer small">
          {nav.kind === 'def' ? 'Definitions of' : 'References to'} <code>{nav.word}</code>
          {nav.locations && <span className="muted"> ({nav.locations.length}{nav.truncated ? '+' : ''})</span>}
        </strong>
        <button className="icon" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      <div className="nav-popup-body">
        {nav.error && <p className="small error">{nav.error}</p>}
        {!nav.locations && !nav.error && <p className="small">
            <Loading>Searching the PR head…</Loading>
          </p>}
        {nav.locations?.length === 0 && <p className="small muted">Nothing found.</p>}
        <ul className="locations">
          {[...byFile].map(([path, locs]) => (
            <li key={path}>
              <div className="loc-file small">{path}</div>
              {locs.map((l) => (
                <button key={l.line} className="loc" onClick={() => onOpen(l.path, l.line)} title={`${l.path}:${l.line}`}>
                  <span className="loc-line">{l.line}</span>
                  <code className="loc-text">{l.text}</code>
                </button>
              ))}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
