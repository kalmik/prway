import { useEffect, useState } from 'react'
import type { ReviewGuide } from '../../../shared/types'
import { timeAgo } from '../util'

interface Props {
  guide: ReviewGuide | null
  /** The guide was made for an older head commit. */
  stale: boolean
  busy: boolean
  error: string | null
  onGenerate: () => void
  onGoTo: (path: string, line: number | null) => void
}

const SOURCE_LABEL: Record<ReviewGuide['intentSource'], string> = {
  'linked-issue': 'from the linked issue',
  description: 'from the PR description',
  commits: 'from the commit messages',
  inferred: 'inferred from the code (no explanation given)'
}

function Elapsed() {
  const [s, setS] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setS((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span>{s}s</span>
}

export function GuidePanel({ guide, stale, busy, error, onGenerate, onGoTo }: Props) {
  const fileName = (p: string) => p.split('/').pop()

  return (
    <aside className="guide">
      <div className="guide-header">
        <strong>Review guide</strong>
        <button className={guide ? '' : 'primary'} disabled={busy} onClick={onGenerate}>
          {busy ? 'Thinking…' : guide ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {busy && (
        <p className="small muted pad">
          Claude is reading the PR… <Elapsed /> (large PRs can take a few minutes)
        </p>
      )}
      {error && <p className="small error pad">{error}</p>}

      {!guide && !busy && !error && (
        <p className="small muted pad">
          Generate a guide to get the intent of the PR, where business rules change, a reading order and the lines worth a
          careful look. Noise files are left out.
        </p>
      )}

      {guide && (
        <div className="guide-body">
          {stale && <p className="small warn-box">New commits since this guide was made. Regenerate to include them.</p>}
          {guide.truncatedFiles.length > 0 && (
            <p className="small warn-box">
              Some diffs were too long and were cut before sending: {guide.truncatedFiles.map(fileName).join(', ')}
            </p>
          )}

          <section>
            <h4>Intent</h4>
            <p>{guide.intent}</p>
            <p className="small muted">{SOURCE_LABEL[guide.intentSource]}</p>
          </section>

          {guide.mismatches.length > 0 && (
            <section className="mismatch">
              <h4>⚠ Not explained by the intent</h4>
              <ul className="bullets">
                {guide.mismatches.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </section>
          )}

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
                    <div>{r.rule}</div>
                    <div className="small muted">{r.change}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h4>What changed</h4>
            <ul className="bullets">
              {guide.summary.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </section>

          <section>
            <h4>Reading order</h4>
            <ol className="reading">
              {guide.files.map((f) => (
                <li key={f.path}>
                  <button className="link" onClick={() => onGoTo(f.path, f.focus[0]?.line ?? null)}>
                    <span className={`risk-dot risk-${f.risk}`} /> {fileName(f.path)}
                  </button>
                  <span className="small muted"> · {f.role}</span>
                  <div className="small">{f.why}</div>
                </li>
              ))}
            </ol>
          </section>

          {guide.questions.length > 0 && (
            <section>
              <h4>Questions for the author</h4>
              <ul className="bullets">
                {guide.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </section>
          )}

          <p className="small muted">
            {guide.model} via {guide.provider === 'claude-code' ? 'Claude Code' : 'Anthropic API'} · {timeAgo(guide.createdAt)}
          </p>
        </div>
      )}
    </aside>
  )
}
