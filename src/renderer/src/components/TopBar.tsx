import { useEffect, useRef, useState } from 'react'
import type { AccessIssue, GhUser, PrNotification, Repo } from '../../../shared/types'
import { errorText, timeAgo } from '../util'
import { AiSettingsDialog } from './AiSettingsDialog'

const api = window.prway

interface Props {
  user: GhUser
  repo: string | null
  onSelectRepo: (fullName: string) => void
  notifications: PrNotification[]
  onOpenNotification: (n: PrNotification) => void
  onLogout: () => void
}

const REASON_LABEL: Record<string, string> = {
  review_requested: 'review requested',
  mention: 'mention',
  team_mention: 'team mention',
  comment: 'comment',
  author: 'your PR',
  state_change: 'state change',
  assign: 'assigned'
}

export function TopBar({ user, repo, onSelectRepo, notifications, onOpenNotification, onLogout }: Props) {
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [issues, setIssues] = useState<AccessIssue[]>([])
  const [repoError, setRepoError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [bellOpen, setBellOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const barRef = useRef<HTMLDivElement>(null)

  function loadRepos() {
    setRepos(null)
    setRepoError(null)
    api.repos.list().then(
      (listing) => {
        setRepos(listing.repos)
        setIssues(listing.issues)
      },
      (err) => setRepoError(errorText(err))
    )
  }

  useEffect(loadRepos, [])

  function choose(fullName: string) {
    onSelectRepo(fullName)
    setPickerOpen(false)
    setQuery('')
  }

  // Close dropdowns when clicking elsewhere.
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) {
        setPickerOpen(false)
        setBellOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const q = query.trim().toLowerCase()
  const matches = (repos ?? []).filter((r) => r.fullName.toLowerCase().includes(q)).slice(0, 50)
  // Typing "owner/name" opens a repo even when GitHub left it out of the list.
  const typedRepo = /^[\w.-]+\/[\w.-]+$/.test(query.trim()) ? query.trim() : null
  const showTyped = typedRepo && !(repos ?? []).some((r) => r.fullName.toLowerCase() === typedRepo.toLowerCase())
  const reviewRequests = notifications.filter((n) => n.reason === 'review_requested').length

  return (
    <header className="topbar" ref={barRef}>
      <span className="brand">PRway</span>

      <div className="dropdown">
        <button className="repo-button" onClick={() => setPickerOpen((o) => !o)}>
          {repo ?? 'Select repository'} ▾
          {issues.length > 0 && (
            <span className="warn-chip" title="Some repositories are hidden">
              ⚠ {issues.length}
            </span>
          )}
        </button>
        {pickerOpen && (
          <div className="menu repo-menu">
            <div className="row repo-search">
              <input
                autoFocus
                placeholder="Filter, or type owner/name…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typedRepo) choose(typedRepo)
                }}
              />
              <button className="icon" title="Reload repositories and re-check access" onClick={loadRepos}>
                ⟳
              </button>
            </div>

            {issues.length > 0 && (
              <div className="issues">
                <p className="small muted">Some repositories are hidden by GitHub:</p>
                {issues.map((i, n) => (
                  <div key={n} className="issue small">
                    <p>{i.message}</p>
                    <button className="link" onClick={() => api.openExternal(i.actionUrl)}>
                      {i.actionLabel} ↗
                    </button>
                  </div>
                ))}
              </div>
            )}

            {repoError && <p className="error pad">{repoError}</p>}
            {!repoError && !repos && <p className="muted pad">Loading repositories and checking access…</p>}
            <ul>
              {showTyped && (
                <li>
                  <button onClick={() => choose(typedRepo)}>
                    Open <strong>&nbsp;{typedRepo}</strong>
                  </button>
                </li>
              )}
              {matches.map((r) => (
                <li key={r.fullName}>
                  <button className={r.fullName === repo ? 'active' : ''} onClick={() => choose(r.fullName)}>
                    <span>{r.fullName}</span>
                    {r.private && <span className="tag">private</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="spacer" />

      <div className="dropdown">
        <button className="bell" title="Pull request notifications" onClick={() => setBellOpen((o) => !o)}>
          🔔{notifications.length > 0 && <span className={`count ${reviewRequests ? 'hot' : ''}`}>{notifications.length}</span>}
        </button>
        {bellOpen && (
          <div className="menu notes-menu">
            {notifications.length === 0 && <p className="muted pad">No unread pull request notifications.</p>}
            <ul>
              {notifications.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => {
                      onOpenNotification(n)
                      setBellOpen(false)
                    }}
                  >
                    <span className="note-title">{n.title}</span>
                    <span className="small muted">
                      {n.repo}
                      {n.prNumber ? ` #${n.prNumber}` : ''} ·{' '}
                      <span className={n.reason === 'review_requested' ? 'accent' : ''}>{REASON_LABEL[n.reason] ?? n.reason}</span>{' '}
                      · {timeAgo(n.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button className="bell" title="AI settings" onClick={() => setAiOpen(true)}>
        ⚙
      </button>
      {aiOpen && <AiSettingsDialog onClose={() => setAiOpen(false)} />}

      <img className="avatar" src={user.avatarUrl} alt="" title={user.login} />
      <button className="link small" onClick={onLogout}>
        Sign out
      </button>
    </header>
  )
}
