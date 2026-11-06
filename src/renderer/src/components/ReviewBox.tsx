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
  /** `notSent`: drafts that couldn't be sent (kept). */
  onSubmitted: (notSent: string[]) => void
}) {
  const [body, setBody] = useState('')
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const stale = drafts.filter((d) => d.headSha !== headSha).length
  const outside = drafts.filter((d) => d.outside).length

  async function submit() {
    setBusy(true)
    setMessage(null)
    try {
      const r = await api.pulls.submitReview(repo, number, event, body, drafts)
      const sent = drafts.length - r.notSent.length
      setBody('')
      setMessage(
        r.error
          ? { ok: false, text: r.error }
          : { ok: true, text: `Review submitted to GitHub${sent ? ` with ${sent} comment${sent > 1 ? 's' : ''}` : ''}.` }
      )
      onSubmitted(r.notSent)
      // The PR list shows your review state: let it reload.
      window.dispatchEvent(new CustomEvent('prway-reviewed', { detail: { repo, number } }))
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
          {outside > 0 && (
            <span className="muted">
              {' '}
              {outside === drafts.length ? (outside > 1 ? 'They are' : 'It is') : `${outside} of them ${outside > 1 ? 'are' : 'is'}`} outside the diff and
              {outside > 1 ? ' go as file comments linking to their lines.' : ' goes as a file comment linking to its line.'}
            </span>
          )}
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
