// Threads tab: every review thread of the PR, grouped by who should act next, with new replies marked and
// outdated threads shown with the code they were written on.

import { useEffect, useState } from 'react'
import type { ReviewThread } from '../../../shared/types'
import { errorText, timeAgo } from '../util'
import { Markdown } from './Markdown'

export type ThreadGroup = 'you' | 'others' | 'open' | 'resolved'

const mentions = (body: string, me: string) => new RegExp(`@${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)

/** Who should act on a thread: you (someone answered you or mentioned you), others (you spoke last), or nobody in particular. */
export function threadGroup(t: ReviewThread, me: string): ThreadGroup {
  if (t.resolved) return 'resolved'
  const mine = (login: string) => login.toLowerCase() === me.toLowerCase()
  const last = t.comments.at(-1)
  if (!last) return 'open'
  const involved = t.comments.some((c) => mine(c.author)) || t.comments.some((c) => !mine(c.author) && mentions(c.body, me))
  if (mine(last.author)) return 'others'
  return involved ? 'you' : 'open'
}

const GROUPS: { id: ThreadGroup; title: string; hint: string }[] = [
  { id: 'you', title: 'Waiting for you', hint: 'Someone replied to you or mentioned you' },
  { id: 'others', title: 'Waiting on others', hint: 'You spoke last' },
  { id: 'open', title: 'Other open threads', hint: 'You are not part of these yet' },
  { id: 'resolved', title: 'Resolved', hint: '' }
]

interface Props {
  threads: ReviewThread[]
  me: string
  /** Last comment id you saw per thread (empty: first visit, nothing is marked new). */
  seen: Record<string, number>
  onSeen: (seen: Record<string, number>) => void
  error: string | null
  loading: boolean
  onRefresh: () => void
  onReply: (t: ReviewThread, body: string) => Promise<void>
  onResolve: (t: ReviewThread, resolved: boolean) => Promise<void>
  /** Opens the thread's line in the diff (only for threads that still sit on a line). */
  onShowInCode: (t: ReviewThread) => void
  onOpenFile: (path: string) => void
  onCodeRef: (path: string, line: number) => void
  onOpenUrl: (url: string) => void
}

/** The last lines of the code a thread was written on. */
function Snippet({ hunk }: { hunk: string }) {
  const lines = hunk.split('\n').filter((l) => !l.startsWith('@@')).slice(-6)
  if (!lines.length) return null
  return (
    <pre className="thread-snippet">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith('+') ? 'add-line' : l.startsWith('-') ? 'del-line' : ''}>
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

function ThreadCard({ t, isNew, props }: { t: ReviewThread; isNew: (id: number) => boolean; props: Props }) {
  const [showAll, setShowAll] = useState(false)
  const [reply, setReply] = useState('')
  const [writing, setWriting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hidden = t.comments.length > 3 && !showAll ? t.comments.length - 2 : 0
  const shown = hidden ? t.comments.slice(-2) : t.comments
  const newCount = t.comments.filter((c) => isNew(c.id)).length

  async function send() {
    if (!reply.trim()) return
    setBusy(true)
    setError(null)
    try {
      await props.onReply(t, reply.trim())
      setReply('')
      setWriting(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`thread-card ${t.resolved ? 'resolved' : ''}`}>
      <div className="thread-card-head small">
        <button
          className="link code-ref"
          onClick={() => (t.line ? props.onShowInCode(t) : props.onOpenFile(t.path))}
          title={t.line ? 'Show in the code' : 'Open the current version of the file'}
        >
          {t.path.split('/').pop()}
          {t.line ? `:${t.line}` : ''}
        </button>
        {t.outdated && (
          <span className="tag outdated-tag" title="The code changed since this thread was written">
            outdated{t.originalLine ? ` · was line ${t.originalLine}` : ''}
          </span>
        )}
        {newCount > 0 && <span className="tag new-tag">{newCount} new</span>}
        <span className="muted ellipsis">{t.path.split('/').slice(0, -1).join('/')}</span>
        <span className="spacer" />
        <button className="link" onClick={() => props.onResolve(t, !t.resolved)}>
          {t.resolved ? 'Unresolve' : 'Resolve'}
        </button>
        {t.comments[0] && (
          <button className="link" onClick={() => props.onOpenUrl(t.comments[0].url)}>
            GitHub ↗
          </button>
        )}
      </div>

      {(t.outdated || !t.line) && <Snippet hunk={t.diffHunk} />}

      {hidden > 0 && (
        <button className="link small" onClick={() => setShowAll(true)}>
          Show {hidden} earlier comment{hidden > 1 ? 's' : ''}
        </button>
      )}
      {shown.map((c) => (
        <div key={c.id} className={`comment ${isNew(c.id) ? 'is-new' : ''}`}>
          <div className="comment-meta small">
            {c.authorAvatar ? <img className="avatar-sm" src={c.authorAvatar} alt="" /> : <span className="avatar-sm" />}
            <strong>{c.author}</strong> <span className="muted">{timeAgo(c.createdAt)}</span>
            {isNew(c.id) && <span className="new-dot" title="New since you last looked" />}
          </div>
          <Markdown text={c.body} onCodeRef={props.onCodeRef} onLink={props.onOpenUrl} />
        </div>
      ))}

      {writing ? (
        <div className="comment-box">
          <textarea
            autoFocus
            rows={3}
            placeholder="Reply (sent right away)…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
              if (e.key === 'Escape') setWriting(false)
            }}
          />
          <div className="row end">
            {error && <span className="small error spacer">{error}</span>}
            <button onClick={() => setWriting(false)}>Cancel</button>
            <button className="primary" disabled={busy || !reply.trim()} onClick={send} title="⌘/Ctrl + Enter">
              {busy ? 'Sending…' : 'Reply'}
            </button>
          </div>
        </div>
      ) : (
        <button className="reply-stub small" onClick={() => setWriting(true)}>
          Reply…
        </button>
      )}
    </li>
  )
}

export function ThreadsPanel(props: Props) {
  const { threads, me, error, loading } = props
  const [open, setOpen] = useState<Record<ThreadGroup, boolean>>({ you: true, others: true, open: true, resolved: false })
  // What was new when you opened the tab stays marked while you read; then everything counts as seen.
  const [snapshot] = useState(props.seen)
  const firstVisit = Object.keys(snapshot).length === 0
  useEffect(() => {
    const latest: Record<string, number> = {}
    for (const t of threads) latest[t.id] = Math.max(0, ...t.comments.map((c) => c.id))
    props.onSeen(latest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads])

  const grouped = new Map<ThreadGroup, ReviewThread[]>(GROUPS.map((g) => [g.id, []]))
  for (const t of threads) grouped.get(threadGroup(t, me))!.push(t)
  const isNewIn = (t: ReviewThread) => (id: number) =>
    !firstVisit && id > (snapshot[t.id] ?? 0) && t.comments.find((c) => c.id === id)?.author.toLowerCase() !== me.toLowerCase()

  return (
    <div className="panel-body threads-panel">
      <div className="row small muted">
        <span className="spacer">
          {threads.filter((t) => !t.resolved).length} open · {threads.filter((t) => t.outdated && !t.resolved).length} outdated ·{' '}
          {threads.filter((t) => t.resolved).length} resolved
        </span>
        <button className="link" disabled={loading} onClick={props.onRefresh}>
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
      {!threads.length && !error && <p className="small muted">No review threads on this PR yet.</p>}

      {GROUPS.map(({ id, title, hint }) => {
        const list = grouped.get(id)!
        if (!list.length) return null
        return (
          <section key={id} className={`thread-group group-${id}`}>
            <button className="thread-group-title" onClick={() => setOpen({ ...open, [id]: !open[id] })}>
              {open[id] ? '▾' : '▸'} <strong>{title}</strong> ({list.length}) {hint && <span className="small muted">— {hint}</span>}
            </button>
            {open[id] && (
              <ol className="thread-list">
                {list
                  .slice()
                  .sort((a, b) => (b.comments.at(-1)?.createdAt ?? '').localeCompare(a.comments.at(-1)?.createdAt ?? ''))
                  .map((t) => (
                    <ThreadCard key={t.id} t={t} isNew={isNewIn(t)} props={props} />
                  ))}
              </ol>
            )}
          </section>
        )
      })}
    </div>
  )
}
