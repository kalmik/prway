// The AI review's findings: confirmed problems, each at a line of the PR, shown where you read (the chunk bar, the file
// summary, the overview). Mark one 👎 with a reason and later reviews of the repository skip that kind of point.

import type { Hunk, PrReview, ReviewFinding, ReviewGuide } from '../../../shared/types'
import { timeAgo } from '../util'
import { Markdown } from './Markdown'
import { Elapsed, RatedHint, type Walkthroughs } from './ReviewPanel'

/** The review as PrView keeps it, and how to (re)run it. */
export interface ReviewState {
  review: PrReview | null
  busy: boolean
  error: string | null
  run: (force: boolean) => void
  /** Run it by itself after the guide (and when a PR with a current guide has none). */
  auto: boolean
  setAuto: (v: boolean) => void
}

/** Findings inside a chunk: by the chunk it was attached to, or by its line falling in the chunk. */
export function findingsIn(review: PrReview | null, path: string, hunk: Hunk): ReviewFinding[] {
  if (!review) return []
  return review.findings.filter(
    (f) => f.path === path && (f.hunkHash ? f.hunkHash === hunk.hash : hunk.newLines > 0 && f.line >= hunk.newStart && f.line < hunk.newStart + hunk.newLines)
  )
}

/**
 * The guide with its focus lines taken from the AI review: the line to look at in each chunk that needs you. Guides
 * made before focus lines moved to the review keep their own until a review with lines exists.
 */
export function withReviewFocus(guide: ReviewGuide | null, review: PrReview | null): ReviewGuide | null {
  if (!guide || !review?.chunks?.some((c) => c.line)) return guide
  const byPath = new Map<string, { line: number; note: string }[]>()
  for (const c of review.chunks) {
    if (!c.needsYou || !c.line) continue
    byPath.set(c.path, [...(byPath.get(c.path) ?? []), { line: c.line, note: c.reason || 'Look here' }])
  }
  return { ...guide, files: guide.files.map((f) => ({ ...f, focus: (byPath.get(f.path) ?? []).sort((a, b) => a.line - b.line) })) }
}

/** What a 👎 on a finding is remembered as. */
export const findingText = (f: ReviewFinding) => `${f.title} — ${f.detail}`

const fileName = (p: string) => p.split('/').pop() ?? p

export function FindingItem({
  finding: f,
  wt,
  showPath,
  onGoTo
}: {
  finding: ReviewFinding
  wt?: Walkthroughs
  /** Show the file name (lists across files). */
  showPath?: boolean
  onGoTo: (path: string, line: number | null) => void
}) {
  const text = findingText(f)
  return (
    <div className={`finding sev-${f.severity}`}>
      <RatedHint text={text} feedback={wt?.feedbackOf('finding', f.path, text)} onRate={(v, c) => wt?.rate('finding', f.path, text, v, c)}>
        <div className="finding-head">
          <span className={`risk-tag risk-${f.severity}`}>{f.severity}</span>
          <strong>{f.title}</strong>
          <button className="link code-ref small" onClick={() => onGoTo(f.path, f.line)}>
            {showPath ? `${fileName(f.path)}:${f.line}` : `L${f.line}`}
          </button>
        </div>
        <div className="finding-detail">
          <Markdown text={f.detail} onCodeRef={(p, l) => onGoTo(p, l)} />
        </div>
        {f.evidence.length > 0 && (
          <div className="finding-evidence small muted">
            checked:{' '}
            {f.evidence.map((e, i) => (
              <button key={i} className="link code-ref" onClick={() => onGoTo(e.path, e.line)}>
                {fileName(e.path)}
                {e.line ? `:${e.line}` : ''}
              </button>
            ))}
          </div>
        )}
      </RatedHint>
    </div>
  )
}

/** The AI review of the whole PR: status, verdict and every finding. For the overview and the Summary tab. */
export function ReviewStatus({
  state,
  account,
  wt,
  onGoTo
}: {
  state: ReviewState
  account?: string | null
  wt?: Walkthroughs
  onGoTo: (path: string, line: number | null) => void
}) {
  const { review, busy, error, run } = state
  const high = review?.findings.filter((f) => f.severity === 'high').length ?? 0
  return (
    <section className="review-status">
      <div className="row">
        <h4 className="spacer">
          AI review
          {review && !review.skipped && (
            <span className={`review-count ${review.findings.length ? (high ? 'high' : 'some') : 'none'}`}>
              {review.findings.length ? `${review.findings.length} finding${review.findings.length > 1 ? 's' : ''}` : 'no findings'}
            </span>
          )}
        </h4>
        {!busy && review && (
          <button className="link small" onClick={() => run(true)} title="Review the PR again (reads the code; one AI request)">
            {review.skipped ? 'Review anyway' : 'Review again'}
          </button>
        )}
      </div>
      {busy && (
        <p className="small muted">
          Claude{account ? ` (${account})` : ''} is reviewing the PR, reading the code to confirm what it finds… <Elapsed /> (a few minutes on
          big PRs)
        </p>
      )}
      {error && !busy && (
        <p className="small error">
          {error}{' '}
          <button className="link" onClick={() => run(false)}>
            retry
          </button>
        </p>
      )}
      {!review && !busy && !error && (
        <p className="small muted">
          Looks for real problems across the PR (it reads callers and tests to confirm each one). Findings show up in the chunks they’re in.{' '}
          <button className="link" onClick={() => run(false)}>
            Review now
          </button>
        </p>
      )}
      {review?.skipped && !busy && <p className="small muted">Skipped: {review.skipped}</p>}
      {review && !review.skipped && (
        <>
          {review.verdict && <p className="small review-verdict">{review.verdict}</p>}
          <div className="finding-list">
            {review.findings.map((f) => (
              <FindingItem key={f.id} finding={f} wt={wt} showPath onGoTo={onGoTo} />
            ))}
          </div>
          <p className="small muted">
            {[review.model, review.account, review.seconds !== undefined ? `${review.seconds}s` : '', timeAgo(review.createdAt)]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </>
      )}
    </section>
  )
}
