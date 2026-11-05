import { useCallback, useEffect, useRef, useState } from 'react'
import type { PullSummary } from '../../../shared/types'
import { errorText, storage, timeAgo } from '../util'
import { Loading } from './Loading'

const api = window.prway

type Filter = 'all' | 'requested'

export function PrList({
  repo,
  selected,
  open,
  me,
  onSelect,
  onCollapse
}: {
  repo: string
  selected: number | null
  /** PRs open in a tab. */
  open: Set<number>
  /** Your GitHub login: your own PRs get their own collapsed group. */
  me: string
  onSelect: (p: PullSummary) => void
  onCollapse: () => void
}) {
  const [pulls, setPulls] = useState<PullSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [showApproved, setShowApprovedState] = useState(() => storage.get('ui.showApproved', false))
  const setShowApproved = (v: boolean) => {
    setShowApprovedState(v)
    storage.set('ui.showApproved', v)
  }
  const [showMine, setShowMineState] = useState(() => storage.get('ui.showMine', false))
  const setShowMine = (v: boolean) => {
    setShowMineState(v)
    storage.set('ui.showMine', v)
  }
  const [showDrafts, setShowDraftsState] = useState(() => storage.get('ui.showDrafts', false))
  const setShowDrafts = (v: boolean) => {
    setShowDraftsState(v)
    storage.set('ui.showDrafts', v)
  }

  const [cleanupNote, setCleanupNote] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  const load = useCallback(() => {
    setError(null)
    api.pulls.list(repo).then(setPulls, (err) => setError(errorText(err)))
  }, [repo])

  /** Removes worktrees of closed/merged PRs (never ones open in a tab). `auto`: throttled, quiet unless it did something. */
  const clean = useCallback(
    (auto: boolean) => {
      if (!auto) setCleanupNote('Cleaning up…')
      api.worktree.cleanup(repo, [...openRef.current], auto).then(
        (r) => {
          if (r.skipped) return
          const parts = [
            r.removed.length ? `Removed ${r.removed.length} worktree${r.removed.length > 1 ? 's' : ''} of closed PRs (${r.removed.map((n) => `#${n}`).join(', ')})` : '',
            r.dirty.length ? `kept ${r.dirty.map((n) => `#${n}`).join(', ')}: local changes` : ''
          ].filter(Boolean)
          setCleanupNote(parts.length ? parts.join('; ') + '.' : auto ? null : 'Nothing to clean up.')
        },
        (err) => setCleanupNote(auto ? null : errorText(err))
      )
    },
    [repo]
  )

  useEffect(() => {
    clean(true)
  }, [clean])

  useEffect(() => {
    setPulls(null)
    load()
  }, [load])

  // Reload after you submit a review, so an approved PR moves to "Approved by you".
  useEffect(() => {
    const onReviewed = () => load()
    window.addEventListener('prway-reviewed', onReviewed)
    return () => window.removeEventListener('prway-reviewed', onReviewed)
  }, [load])

  const requested = pulls?.filter((p) => p.reviewRequested).length ?? 0
  const shown = (pulls ?? []).filter((p) => filter === 'all' || p.reviewRequested)
  // Approved by you and nothing new since: out of the way, in a collapsed group at the bottom.
  const done = (p: PullSummary) => p.myReview?.state === 'APPROVED' && !p.myReview.stale
  // Your own PRs (drafts included) and other people's drafts get collapsed groups; the main list is what needs you.
  const mine = shown.filter((p) => p.author.toLowerCase() === me.toLowerCase())
  const others = shown.filter((p) => p.author.toLowerCase() !== me.toLowerCase())
  const active = others.filter((p) => !done(p) && !p.draft)
  const approved = others.filter((p) => done(p) && !p.draft)
  const drafts = others.filter((p) => p.draft)

  const item = (p: PullSummary) => (
    <li key={p.number}>
      <button
        className={`pr-item ${p.number === selected ? 'active' : ''} ${open.has(p.number) ? 'in-tab' : ''}`}
        onClick={() => onSelect(p)}
      >
        <span className="pr-title">
          {p.reviewRequested && <span className="dot" title="Your review is requested" />}
          {p.title}
        </span>
        <span className="small muted">
          #{p.number} · {p.author} · {timeAgo(p.updatedAt)}
          {p.draft && <span className="tag">draft</span>}
          {p.myReview && <ReviewBadge review={p.myReview} />}
        </span>
      </button>
    </li>
  )

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
        <div className="row tight">
          <button className="icon" title="Refresh" onClick={load}>
            ↻
          </button>
          <button className="icon" title="Remove worktrees of closed or merged PRs (merged ones are saved to the knowledge base first)" onClick={() => clean(false)}>
            🧹
          </button>
          <button className="icon" title="Hide the list (more room for the diff)" onClick={onCollapse}>
            «
          </button>
        </div>
      </div>

      {error && <p className="error pad">{error}</p>}
      {cleanupNote && (
        <p className="small muted pad cleanup-note">
          {cleanupNote}{' '}
          <button className="link" onClick={() => setCleanupNote(null)}>
            ok
          </button>
        </p>
      )}
      {!pulls && !error && <p className="pad">
          <Loading>Loading pull requests…</Loading>
        </p>}
      {pulls && shown.length === 0 && <p className="muted pad">Nothing here.</p>}
      {pulls && shown.length > 0 && active.length === 0 && <p className="muted pad small">Nothing waiting for you: everything is approved or still a draft.</p>}

      <ul>{active.map(item)}</ul>

      {mine.length > 0 && (
        <>
          <button className="group-toggle small muted" onClick={() => setShowMine(!showMine)}>
            {showMine ? '▾' : '▸'} My PRs ({mine.length})
          </button>
          {showMine && <ul className="my-prs">{mine.map(item)}</ul>}
        </>
      )}

      {approved.length > 0 && (
        <>
          <button className="group-toggle small muted" onClick={() => setShowApproved(!showApproved)}>
            {showApproved ? '▾' : '▸'} Approved by you ({approved.length})
          </button>
          {showApproved && <ul className="approved-prs">{approved.map(item)}</ul>}
        </>
      )}

      {drafts.length > 0 && (
        <>
          <button className="group-toggle small muted" onClick={() => setShowDrafts(!showDrafts)}>
            {showDrafts ? '▾' : '▸'} Drafts ({drafts.length})
          </button>
          {showDrafts && <ul className="draft-prs">{drafts.map(item)}</ul>}
        </>
      )}
    </div>
  )
}

function ReviewBadge({ review }: { review: NonNullable<PullSummary['myReview']> }) {
  if (review.state === 'APPROVED') {
    return review.stale ? (
      <span className="tag review-tag stale" title="You approved an earlier version; new commits were pushed since">
        new commits since your ✓
      </span>
    ) : (
      <span className="tag review-tag approved">✓ approved</span>
    )
  }
  if (review.state === 'CHANGES_REQUESTED') {
    return (
      <span className={`tag review-tag changes ${review.stale ? 'stale' : ''}`} title={review.stale ? 'New commits since you asked for changes' : undefined}>
        changes requested{review.stale ? ' · updated' : ''}
      </span>
    )
  }
  if (review.state === 'COMMENTED') return <span className="tag review-tag">reviewed</span>
  return null
}
