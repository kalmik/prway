import { useEffect, useState } from 'react'
import type { ReviewGuide } from '../../../shared/types'
import { timeAgo } from '../util'
import { Markdown } from './Markdown'

interface Props {
  /** The AI account that generates it (its name). */
  account?: string
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

export function GuidePanel({ guide, stale, busy, error, onGenerate, onGoTo, account }: Props) {
  const fileName = (p: string) => p.split('/').pop()

  return (
    <div className="panel-body guide">
      <div className="guide-header">
        <span className="small muted">
          {guide
            ? `${guide.model} via ${guide.account ?? (guide.provider === 'claude-code' ? 'Claude Code' : 'Anthropic API')} · ${timeAgo(guide.createdAt)}`
            : 'AI summary of the intent and the reading order'}
        </span>
        <button className={guide ? '' : 'primary'} disabled={busy} onClick={onGenerate}>
          {busy ? 'Thinking…' : guide ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {busy && (
        <p className="small muted pad">
          Claude{account ? ` (${account})` : ''} is reading the PR… <Elapsed /> (large PRs can take a few minutes)
        </p>
      )}
      {error && <p className="small error pad">{error}</p>}

      {!guide && !busy && !error && (
        <p className="small muted pad">
          Generate a guide to get the intent of the PR and a reading order with the lines worth a careful look. Business rule
          changes and the background of the change show in the Background tab. Noise files are left out.
        </p>
      )}

      {guide && (
        <div className="guide-body">
          {stale && <p className="small warn-box">New commits since this guide was made. Regenerate to include them.</p>}
          {guide.instructionsChanged && (
            <p className="small warn-box">This repository's review instructions changed since this guide was made. Regenerate to apply them.</p>
          )}
          {guide.truncatedFiles.length > 0 && (
            <p className="small warn-box">
              Some diffs were too long and were cut before sending: {guide.truncatedFiles.map(fileName).join(', ')}
            </p>
          )}

          <section>
            <h4>Intent</h4>
            <Markdown text={guide.intent} onCodeRef={onGoTo} />
            <p className="small muted">{SOURCE_LABEL[guide.intentSource]}</p>
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
                  <div className="small">
                    <Markdown text={f.why} onCodeRef={onGoTo} />
                  </div>
                </li>
              ))}
            </ol>
          </section>

        </div>
      )}
    </div>
  )
}
