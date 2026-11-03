import { useCallback, useEffect, useState } from 'react'
import type { PullSummary } from '../../../shared/types'
import { errorText, timeAgo } from '../util'

const api = window.prway

type Filter = 'all' | 'requested'

export function PrList({ repo, selected, onSelect }: { repo: string; selected: number | null; onSelect: (n: number) => void }) {
  const [pulls, setPulls] = useState<PullSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')

  const load = useCallback(() => {
    setError(null)
    api.pulls.list(repo).then(setPulls, (err) => setError(errorText(err)))
  }, [repo])

  useEffect(() => {
    setPulls(null)
    load()
  }, [load])

  const requested = pulls?.filter((p) => p.reviewRequested).length ?? 0
  const shown = (pulls ?? []).filter((p) => filter === 'all' || p.reviewRequested)

  return (
    <div className="pr-list">
      <div className="list-header">
        <div className="tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            Open {pulls ? `(${pulls.length})` : ''}
          </button>
          <button className={filter === 'requested' ? 'active' : ''} onClick={() => setFilter('requested')}>
            For me ({requested})
          </button>
        </div>
        <button className="icon" title="Refresh" onClick={load}>
          ⟳
        </button>
      </div>

      {error && <p className="error pad">{error}</p>}
      {!pulls && !error && <p className="muted pad">Loading pull requests…</p>}
      {pulls && shown.length === 0 && <p className="muted pad">Nothing here.</p>}

      <ul>
        {shown.map((p) => (
          <li key={p.number}>
            <button className={`pr-item ${p.number === selected ? 'active' : ''}`} onClick={() => onSelect(p.number)}>
              <span className="pr-title">
                {p.reviewRequested && <span className="dot" title="Your review is requested" />}
                {p.title}
              </span>
              <span className="small muted">
                #{p.number} · {p.author} · {timeAgo(p.updatedAt)}
                {p.draft && <span className="tag">draft</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
