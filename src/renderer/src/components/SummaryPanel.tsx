// Summary tab: what the PR changes, at a glance. What changed, the business rules it changes (before → after)
// and changes its stated intent doesn't explain. All from the guide.

import type { ReviewGuide } from '../../../shared/types'
import { Markdown } from './Markdown'

const fileName = (p: string) => p.split('/').pop() ?? p

export function SummaryPanel({
  guide,
  busy,
  onGenerate,
  onGoTo
}: {
  guide: ReviewGuide | null
  busy: boolean
  onGenerate: () => void
  onGoTo: (path: string, line: number | null) => void
}) {
  if (!guide) {
    return (
      <div className="panel-body">
        <p className="small muted">
          The summary comes from the guide: what changed, the business rules it changes and anything the intent doesn't explain.{' '}
          <button className="link" disabled={busy} onClick={onGenerate}>
            {busy ? 'Generating the guide…' : 'Generate the guide'}
          </button>
        </p>
      </div>
    )
  }
  return (
    <div className="panel-body summary-panel">
      <section>
        <h4>What changed</h4>
        <ul className="bullets">
          {guide.summary.map((s, i) => (
            <li key={i}>
              <Markdown text={s} onCodeRef={onGoTo} />
            </li>
          ))}
        </ul>
      </section>
      {guide.businessRules.length > 0 && (
        <section>
          <h4>Business rules changed</h4>
          <ul className="rules">
            {guide.businessRules.map((r, i) => (
              <li key={i}>
                <button className="link small" onClick={() => onGoTo(r.path, r.line)}>
                  {fileName(r.path)}
                  {r.line ? `:${r.line}` : ''}
                </button>
                <Markdown text={r.rule} onCodeRef={onGoTo} />
                <div className="small muted">
                  <Markdown text={r.change} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {guide.mismatches.length > 0 && (
        <section className="mismatch">
          <h4>⚠ Not explained by the intent</h4>
          <ul className="bullets">
            {guide.mismatches.map((m, i) => (
              <li key={i}>
                <Markdown text={m} onCodeRef={onGoTo} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
