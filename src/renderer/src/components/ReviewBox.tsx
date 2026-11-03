import { useState } from 'react'
import type { DraftComment, ReviewEvent } from '../../../shared/types'
import { errorText } from '../util'

const api = window.prway

export function ReviewBox({
  repo,
  number,
  drafts,
  headSha,
  onSubmitted
}: {
  repo: string
  number: number
  drafts: DraftComment[]
  headSha: string
  onSubmitted: () => void
}) {
  const [body, setBody] = useState('')
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const stale = drafts.filter((d) => d.headSha !== headSha).length

  async function submit() {
    setBusy(true)
    setMessage(null)
    try {
      await api.pulls.submitReview(repo, number, event, body, drafts)
      setBody('')
      setMessage({ ok: true, text: `Review submitted to GitHub${drafts.length ? ` with ${drafts.length} inline comment${drafts.length > 1 ? 's' : ''}` : ''}.` })
      onSubmitted()
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  const canSubmit = event === 'APPROVE' || !!body.trim() || drafts.length > 0
  return (
    <div className="review-box">
      {drafts.length > 0 && (
        <p className="small">
          <span className="tag pending">{drafts.length} pending</span> inline comment{drafts.length > 1 ? 's' : ''} will be sent with
          this review.
          {stale > 0 && <span className="warn-text"> {stale} written on an older commit.</span>}
        </p>
      )}
      <textarea placeholder="Overall review comment…" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      <div className="row">
        <select value={event} onChange={(e) => setEvent(e.target.value as ReviewEvent)}>
          <option value="COMMENT">Comment</option>
          <option value="APPROVE">Approve</option>
          <option value="REQUEST_CHANGES">Request changes</option>
        </select>
        <button className="primary" disabled={busy || !canSubmit} onClick={submit}>
          {busy ? 'Submitting…' : 'Submit review'}
        </button>
      </div>
      {message && <p className={message.ok ? 'small ok' : 'small error'}>{message.text}</p>}
    </div>
  )
}
