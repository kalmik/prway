// Conversation tab: the PR description, general comments and review summaries, oldest first,
// with a box to post a new comment.

import { useState } from 'react'
import type { ConversationItem } from '../../../shared/types'
import { errorText, timeAgo, useOpenChoice } from '../util'
import { Markdown, plainPreview } from './Markdown'
import { Loading } from './Loading'

const STATE: Record<string, { text: string; className: string }> = {
  APPROVED: { text: 'approved', className: 'state-approved' },
  CHANGES_REQUESTED: { text: 'requested changes', className: 'state-changes' },
  COMMENTED: { text: 'reviewed', className: '' },
  DISMISSED: { text: 'review dismissed', className: 'muted' }
}

export function ConversationPanel({
  items,
  error,
  loading,
  onRefresh,
  onPost,
  onCodeRef,
  onOpenUrl
}: {
  items: ConversationItem[] | null
  error: string | null
  loading: boolean
  onRefresh: () => void
  onPost: (body: string) => Promise<void>
  onCodeRef: (path: string, line: number) => void
  onOpenUrl: (url: string) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [postError, setPostError] = useState<string | null>(null)

  async function post() {
    if (!text.trim()) return
    setBusy(true)
    setPostError(null)
    try {
      await onPost(text.trim())
      setText('')
    } catch (err) {
      setPostError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel-body conversation">
      <div className="row small muted">
        <span className="spacer">
          {items ? `${items.filter((i) => i.kind !== 'description').length} comments and reviews` : ''} · inline threads are in the diff
        </span>
        <button className="link" disabled={loading} onClick={onRefresh} title="Reload comments, reviews and inline threads from GitHub">
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>
      {error && <p className="small error">{error}</p>}
      {!items && !error && <p className="small">
          <Loading>Loading the conversation…</Loading>
        </p>}

      <ol className="timeline">
        {items?.map((item) => (
          <TimelineItem key={item.id} item={item} onCodeRef={onCodeRef} onOpenUrl={onOpenUrl} />
        ))}
      </ol>

      <div className="comment-box">
        <textarea
          rows={3}
          placeholder="Comment on the PR (posted right away, not part of your review)…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post()
          }}
        />
        <div className="row end">
          {postError && <span className="small error spacer">{postError}</span>}
          <button className="primary" disabled={busy || !text.trim()} onClick={post} title="⌘/Ctrl + Enter">
            {busy ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One entry; bot comments (CodeRabbit…) start collapsed, and your open/closed choice is kept. */
function TimelineItem({
  item,
  onCodeRef,
  onOpenUrl
}: {
  item: ConversationItem
  onCodeRef: (path: string, line: number) => void
  onOpenUrl: (url: string) => void
}) {
  const state = item.state ? STATE[item.state] : undefined
  const empty = !item.body.trim()
  const collapsible = item.kind !== 'description' && !empty
  const [choice, setOpen] = useOpenChoice(`conv:${item.url}`, !item.bot)
  const open = !collapsible || choice
  return (
    <li className={`timeline-item ${item.kind}`}>
      <div className="comment-meta small">
        {collapsible && (
          <button className="link muted" onClick={() => setOpen(!open)} title={open ? 'Collapse' : 'Expand'}>
            {open ? '▾' : '▸'}
          </button>
        )}
        {item.authorAvatar ? <img className="avatar-sm" src={item.authorAvatar} alt="" /> : <span className="avatar-sm" />}
        <strong>{item.author}</strong>
        {item.bot && <span className="tag">bot</span>}
        {item.kind === 'description' && <span className="muted">opened this PR</span>}
        {state && <span className={`review-state ${state.className}`}>{state.text}</span>}
        {!!item.inlineCount && (
          <span className="muted">
            with {item.inlineCount} inline comment{item.inlineCount > 1 ? 's' : ''}
          </span>
        )}
        <span className="muted">{timeAgo(item.createdAt)}</span>
        {!open && <span className="muted ellipsis">{plainPreview(item.body)}</span>}
        <span className="spacer" />
        <button className="link" onClick={() => onOpenUrl(item.url)}>
          GitHub ↗
        </button>
      </div>
      {empty ? (
        item.kind === 'description' && <p className="small muted">No description.</p>
      ) : (
        open && (
          <div className="timeline-body">
            <Markdown text={item.body} onCodeRef={onCodeRef} onLink={onOpenUrl} />
          </div>
        )
      )}
    </li>
  )
}
