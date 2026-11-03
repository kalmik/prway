import { useState } from 'react'
import type { ReviewEvent } from '../../../shared/types'
import { errorText } from '../util'

const api = window.diffscope

export function ReviewBox({ repo, number }: { repo: string; number: number }) {
  const [body, setBody] = useState('')
  const [event, setEvent] = useState<ReviewEvent>('COMMENT')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit() {
    setBusy(true)
    setMessage(null)
    try {
      await api.pulls.submitReview(repo, number, event, body)
      setBody('')
      setMessage({ ok: true, text: 'Review submitted to GitHub.' })
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="review-box">
      <textarea placeholder="Leave a review comment…" value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      <div className="row">
        <select value={event} onChange={(e) => setEvent(e.target.value as ReviewEvent)}>
          <option value="COMMENT">Comment</option>
          <option value="APPROVE">Approve</option>
          <option value="REQUEST_CHANGES">Request changes</option>
        </select>
        <button className="primary" disabled={busy || (event !== 'APPROVE' && !body.trim())} onClick={submit}>
          {busy ? 'Submitting…' : 'Submit review'}
        </button>
      </div>
      {message && <p className={message.ok ? 'small ok' : 'small error'}>{message.text}</p>}
    </div>
  )
}
