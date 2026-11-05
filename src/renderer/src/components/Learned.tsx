// What PRway has learned from the hints you marked 👎 and your reasons, per repository: review it and forget what no
// longer holds.

import { useEffect, useState } from 'react'
import type { HintFeedback } from '../../../shared/types'
import { errorText, timeAgo } from '../util'

const api = window.prway

const KIND: Record<HintFeedback['kind'], string> = { check: 'file check', note: 'chunk note', focus: 'focus line' }

export function LearnedSettings({ repo: initialRepo }: { repo: string | null }) {
  const [repo, setRepo] = useState(initialRepo ?? '')
  const [list, setList] = useState<HintFeedback[] | null>(null)
  const [filter, setFilter] = useState<'all' | 'reasons'>('all')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!repo.includes('/')) return setList(null)
    let live = true
    api.feedback.list(repo).then((l) => live && setList(l), (e) => setError(errorText(e)))
    return () => {
      live = false
    }
  }, [repo])

  const shown = (list ?? [])
    .filter((f) => filter === 'all' || !!f.comment)
    .slice()
    .reverse()
  const reasons = (list ?? []).filter((f) => f.comment).length

  return (
    <div className="settings-section learned">
      <p className="small muted">
        Hints you marked 👎 (not useful) and the reasons you gave. New file notes and guides for this repository leave out points like
        these and follow your reasons as rules. Delete what no longer applies.
      </p>
      <div className="row">
        <input placeholder="owner/repository" value={repo} onChange={(e) => setRepo(e.target.value.trim())} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All ({list?.length ?? 0})</option>
          <option value="reasons">With a reason ({reasons})</option>
        </select>
      </div>
      {error && <p className="small error">{error}</p>}
      {list && !list.length && <p className="small muted">Nothing yet: in a review, hover a hint that isn’t useful and press 👎.</p>}
      <ul className="learned-list">
        {shown.map((f) => (
          <li key={f.id}>
            <span className="learned-verdict" title="Not useful">
              👎
            </span>
            <div className="learned-body">
              <div className="learned-text">{f.text}</div>
              {f.comment && <div className="hint-reason">💬 {f.comment}</div>}
              <div className="small muted">
                {KIND[f.kind]} · {f.path} · #{f.pr} · {timeAgo(f.at)}
              </div>
            </div>
            <button
              className="small"
              title="Forget this: the AI may raise points like it again"
              onClick={() =>
                api.feedback.remove(repo, f.id).then(setList, (e) => setError(errorText(e)))
              }
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
