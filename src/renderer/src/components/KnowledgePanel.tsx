// Knowledge tab: earlier merged PRs that touched the same files or functions, with their intent,
// business rules and review decisions.

import { useCallback, useEffect, useState } from 'react'
import type { KbMatch, KbStatus } from '../../../shared/types'
import { errorText, timeAgo } from '../util'

const api = window.prway

const STATE: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented' }

export function KnowledgePanel({
  repo,
  number,
  headSha,
  onOpen,
  onOpenUrl
}: {
  repo: string
  number: number
  headSha: string
  onOpen: (path: string, line: number | null) => void
  onOpenUrl: (url: string) => void
}) {
  const [matches, setMatches] = useState<KbMatch[] | null>(null)
  const [status, setStatus] = useState<KbStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    api.kb.related(repo, number).then(setMatches, (err) => setError(errorText(err)))
    api.kb.status(repo).then(setStatus, () => undefined)
  }, [repo, number])

  useEffect(load, [load, headSha])

  async function sync() {
    setBusy(true)
    setError(null)
    try {
      setStatus(await api.kb.sync(repo))
      load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel-body kb-panel">
      <div className="row small muted">
        <span className="spacer">
          {status ? `${status.entries} merged PR${status.entries === 1 ? '' : 's'} in the knowledge base` : '…'}
          {status?.lastSync && ` · synced ${timeAgo(status.lastSync)}${status.added ? `, ${status.added} added` : ''}`}
        </span>
        <button className="link" disabled={busy} onClick={sync}>
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <button className="link" onClick={() => api.kb.reveal(repo).catch((e) => setError(errorText(e)))}>
          Open folder
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
      {!matches && !error && <p className="small muted">Looking for earlier PRs on this code…</p>}
      {matches?.length === 0 && (
        <p className="small muted">
          No earlier PR in the knowledge base touched these files. It fills up on its own: when a PR you opened in PRway is merged, its
          intent, business rules and review decisions are saved here.
        </p>
      )}
      <ul className="kb-list">
        {matches?.map(({ entry: e, files, symbols }) => (
          <li key={e.number} className="kb-entry">
            <div className="row">
              <button className="link kb-title" onClick={() => onOpenUrl(e.url)}>
                #{e.number} {e.title}
              </button>
              <span className="small muted">merged {timeAgo(e.mergedAt)}</span>
            </div>
            <div className="small muted">
              Same {symbols.length ? 'functions' : 'files'}:{' '}
              {(symbols.length ? symbols.map((s) => s.split('#')[1]) : files.map((f) => f.split('/').pop())).join(', ')}
            </div>
            <p className="small">{e.intent}</p>
            {e.rules.length > 0 && (
              <ul className="rules">
                {e.rules.map((r, i) => (
                  <li key={i} className="small">
                    <button className="link" onClick={() => onOpen(r.path, r.line)}>
                      {r.path.split('/').pop()}
                      {r.line ? `:${r.line}` : ''}
                    </button>{' '}
                    {r.rule} <span className="muted">— {r.change}</span>
                  </li>
                ))}
              </ul>
            )}
            {(e.decisions.length > 0 || e.discussions.length > 0) && (
              <details className="small">
                <summary>Review decisions ({e.decisions.length + e.discussions.length})</summary>
                <ul className="bullets">
                  {e.decisions.map((d, i) => (
                    <li key={`d${i}`}>
                      <strong>{d.reviewer}</strong> {STATE[d.state] ?? d.state.toLowerCase()}
                      {d.body && `: ${d.body}`}
                    </li>
                  ))}
                  {e.discussions.map((d, i) => (
                    <li key={`t${i}`}>
                      <code>
                        {d.path.split('/').pop()}
                        {d.line ? `:${d.line}` : ''}
                      </code>{' '}
                      ({d.resolved ? 'resolved' : 'open'}) <strong>{d.author}</strong>: {d.body}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
