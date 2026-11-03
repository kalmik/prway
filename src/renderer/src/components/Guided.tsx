// Guided review, PRway's main view: an outline on the left (Overview → files in reading order → Finish),
// and in the middle the current step: the PR overview, one file with its current chunk above the diff,
// or the wrap-up with the submit form.

import { useState, type ReactNode } from 'react'
import type { ChangedFile, DraftComment, Hunk, PullDetail, ReviewGuide, ReviewThread } from '../../../shared/types'
import { storage } from '../util'
import { GuidePanel } from './GuidePanel'
import { Markdown } from './Markdown'
import {
  approvalKey,
  AUTO_LABEL,
  AutoExplain,
  FileCard,
  HunkCard,
  hunkRange,
  progressOf,
  type ReviewFlow,
  type Walkthroughs
} from './ReviewPanel'

export type Step = 'overview' | 'files' | 'finish'

// ---- Outline (left) ----

export function ReviewOutline({
  flow,
  step,
  current,
  currentHunk,
  noise,
  commentCounts,
  drafts,
  onStep,
  onOpenNoise
}: {
  flow: ReviewFlow
  step: Step
  current: ChangedFile | null
  currentHunk: number | null
  noise: ChangedFile[]
  commentCounts: Map<string, number>
  drafts: number
  onStep: (s: Step) => void
  onOpenNoise: (f: ChangedFile) => void
}) {
  const { steps, hunks, approved, guideFiles, wt } = flow
  const { total, done, filesDone, fileDone } = progressOf(flow)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showNoise, setShowNoise] = useState(false)

  function toggleFile(path: string) {
    const all = hunks?.[path] ?? []
    const allDone = fileDone(path)
    for (const h of all) if (approved.has(approvalKey(path, h.hash)) === allDone) flow.onToggleApprove(path, h.hash)
  }

  return (
    <nav className="outline">
      <div className="outline-progress small">
        <div className="row">
          <span className="spacer">
            <strong>{done}</strong>/{total} chunks · {filesDone}/{steps.length} files
          </span>
        </div>
        <div className="progress">
          <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      </div>

      <button className={`outline-step ${step === 'overview' ? 'active' : ''}`} onClick={() => onStep('overview')}>
        <span className="step-icon">◎</span> Overview
      </button>

      <ol className="outline-files">
        {steps.map((f, i) => {
          const fh = hunks?.[f.path] ?? []
          const ok = fh.filter((h) => approved.has(approvalKey(f.path, h.hash))).length
          const autoCount = fh.filter((h) => flow.autoReasons.has(approvalKey(f.path, h.hash))).length
          const isCurrent = step === 'files' && current?.path === f.path
          const expanded = isCurrent || open.has(f.path)
          const g = guideFiles.get(f.path)
          const w = wt.walk[f.path]
          return (
            <li key={f.path} className={`${isCurrent ? 'current' : ''} ${fileDone(f.path) ? 'done' : ''}`}>
              <div className="outline-file">
                <input
                  type="checkbox"
                  title={fileDone(f.path) ? 'Unapprove every chunk of this file' : 'Approve every chunk of this file'}
                  checked={fileDone(f.path)}
                  disabled={!fh.length}
                  onChange={() => toggleFile(f.path)}
                />
                <button className="outline-file-name" onClick={() => flow.onGoFile(f.path)} title={f.path}>
                  <span className="order">{i + 1}</span>
                  {g && <span className={`risk-dot risk-${g.risk}`} title={`${g.risk} risk`} />}
                  <span className="file-name">{f.path.split('/').pop()}</span>
                  {!!commentCounts.get(f.path) && <span className="comment-count">{commentCounts.get(f.path)}</span>}
                  <span className="outline-count" title={autoCount ? `${autoCount} pre-approved` : undefined}>
                    {ok}/{fh.length}
                  </span>
                </button>
                {fh.length > 0 && !isCurrent && (
                  <button
                    className="icon outline-expand"
                    onClick={() => setOpen((s) => (s.has(f.path) ? new Set([...s].filter((x) => x !== f.path)) : new Set([...s, f.path])))}
                  >
                    {expanded ? '▾' : '▸'}
                  </button>
                )}
              </div>
              {expanded && fh.length > 0 && (
                <ul className="outline-hunks">
                  {fh.map((h) => {
                    const note = w?.hunks.find((x) => x.hash === h.hash)
                    const active = isCurrent && currentHunk === h.index
                    const auto = flow.autoReasons.get(approvalKey(f.path, h.hash))
                    return (
                      <li key={h.hash + h.index} className={`${active ? 'active' : ''} ${auto ? 'auto' : ''}`} title={auto?.reason}>
                        <input
                          type="checkbox"
                          checked={approved.has(approvalKey(f.path, h.hash))}
                          onChange={() => flow.onToggleApprove(f.path, h.hash)}
                        />
                        <button onClick={() => flow.onShowHunk(f.path, h)} title={note?.summary ?? h.header}>
                          <span className="hunk-range">{hunkRange(h)}</span> <span className="muted">{h.header}</span>
                        </button>
                        {note && note.risk !== 'low' && <span className={`risk-dot risk-${note.risk}`} />}
                        {auto && <span className="auto-mini">auto</span>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </li>
          )
        })}
      </ol>

      {noise.length > 0 && (
        <>
          <button className="group-toggle small muted" onClick={() => setShowNoise(!showNoise)}>
            {showNoise ? '▾' : '▸'} Skipped — {noise.length} file{noise.length > 1 ? 's' : ''} of noise
          </button>
          {showNoise && (
            <ul className="outline-noise">
              {noise.map((f) => (
                <li key={f.path} className={step === 'files' && current?.path === f.path ? 'current' : ''}>
                  <span className="noise-tag">{f.noise!.kind}</span>
                  <button className="link" onClick={() => onOpenNoise(f)} title={f.noise!.reason}>
                    {f.path.split('/').pop()}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <button className={`outline-step finish ${step === 'finish' ? 'active' : ''}`} onClick={() => onStep('finish')}>
        <span className="step-icon">✓</span> Finish & submit
        {drafts > 0 && <span className="comment-count">{drafts}</span>}
      </button>
    </nav>
  )
}

// ---- Overview step ----

export function OverviewStep({
  guide,
  stale,
  busy,
  error,
  stats,
  pre,
  wt,
  stepPaths,
  onGenerate,
  onGoTo,
  onStart
}: {
  guide: ReviewGuide | null
  stale: boolean
  busy: boolean
  error: string | null
  stats: { files: number; noise: number; chunks: number; pre: number; threads: number }
  pre: { rules: boolean; ai: boolean; setRules: (v: boolean) => void; setAi: (v: boolean) => void }
  wt: Walkthroughs
  stepPaths: string[]
  onGenerate: () => void
  onGoTo: (path: string, line: number | null) => void
  onStart: () => void
}) {
  return (
    <div className="step-page">
      <div className="step-hero">
        <div>
          <h3>Review plan</h3>
          <p className="small muted">
            {stats.files} file{stats.files === 1 ? '' : 's'} · {stats.chunks} chunks:{' '}
            <strong className="needs-you">{stats.chunks - stats.pre} need you</strong>
            {stats.pre > 0 && `, ${stats.pre} pre-approved`}
            {stats.noise > 0 && ` · ${stats.noise} noise file${stats.noise > 1 ? 's' : ''} skipped`}
            {stats.threads > 0 && ` · ${stats.threads} open thread${stats.threads > 1 ? 's' : ''}`}
          </p>
        </div>
        <button className="primary big" onClick={onStart} disabled={!stats.files}>
          Start review →
        </button>
      </div>
      <div className="pre-approve small">
        <label title="Imports and aliases, comments, blank lines, formatting-only and moved code">
          <input type="checkbox" checked={pre.rules} onChange={(e) => pre.setRules(e.target.checked)} /> Pre-approve chunks that can't
          change behaviour (imports, comments, formatting, moved code)
        </label>
        <label title="Only low-risk chunks the AI marks trivial, e.g. log wording or a local rename. Needs the file explained.">
          <input type="checkbox" checked={pre.ai} onChange={(e) => pre.setAi(e.target.checked)} /> Also trust the AI's “trivial” verdicts
          (low-risk only)
        </label>
        {pre.ai && (
          <span className="muted">
            {wt.preparing ? (
              `Explaining files in the background… ${wt.preparing.done}/${wt.preparing.total}`
            ) : stepPaths.some((p) => !wt.walk[p]) ? (
              <>
                {stepPaths.filter((p) => !wt.walk[p]).length} file(s) not explained yet ·{' '}
                <button className="link" onClick={() => wt.prepareAll(stepPaths)}>
                  explain them all now
                </button>{' '}
                (one AI call per file)
              </>
            ) : (
              'Every file is explained.'
            )}
          </span>
        )}
      </div>
      <GuidePanel guide={guide} stale={stale} busy={busy} error={error} onGenerate={onGenerate} onGoTo={onGoTo} />
      {!guide && !busy && (
        <p className="small muted">You can also start right away: files are then reviewed in their order, without the AI reading order.</p>
      )}
    </div>
  )
}

// ---- File step: the current chunk, above the diff ----

export function FileStep({
  flow,
  file,
  currentHunk,
  commentSignal,
  onPrevChunk,
  onNextChunk
}: {
  flow: ReviewFlow
  file: ChangedFile
  currentHunk: number | null
  commentSignal: number
  onPrevChunk: () => void
  onNextChunk: () => void
}) {
  const { steps, hunks, approved, guideFiles, wt } = flow
  const [cardOpen, setCardOpenState] = useState(() => storage.get('ui.fileCardOpen', true))
  const setCardOpen = (v: boolean) => {
    setCardOpenState(v)
    storage.set('ui.fileCardOpen', v)
  }
  const index = steps.findIndex((f) => f.path === file.path)
  const fh = hunks?.[file.path] ?? []
  const hunk: Hunk | undefined =
    fh.find((h) => h.index === currentHunk) ?? fh.find((h) => !approved.has(approvalKey(file.path, h.hash))) ?? fh[0]
  const w = wt.walk[file.path]
  const g = guideFiles.get(file.path)
  const position = hunk ? fh.indexOf(hunk) + 1 : 0

  return (
    <div className="file-step">
      <div className="file-step-head">
        <span className="small muted">{index >= 0 ? `File ${index + 1} of ${steps.length}` : 'Noise file'}</span>
        <code className="file-card-path spacer">{file.path}</code>
        {g && <span className={`risk-tag risk-${g.risk}`}>{g.risk} risk</span>}
        <button className="link small" onClick={() => setCardOpen(!cardOpen)}>
          {cardOpen ? 'Hide summary' : 'Show summary'}
        </button>
      </div>
      {cardOpen && index >= 0 && (
        <FileCard bare file={file} guideFile={g} wt={wt} onOpen={flow.onOpen} onOpenUrl={flow.onOpenUrl} />
      )}
      {file.noise && <p className="small muted">Skipped as noise: {file.noise.reason}</p>}

      {hunk && (
        <>
          <div className="chunk-nav small">
            <strong>
              Chunk {position} of {fh.length}
            </strong>
            <span className="muted">
              {fh.filter((h) => !approved.has(approvalKey(file.path, h.hash))).length} left for you
              {fh.some((h) => flow.autoReasons.has(approvalKey(file.path, h.hash))) &&
                ` · ${fh.filter((h) => flow.autoReasons.has(approvalKey(file.path, h.hash))).length} pre-approved`}
            </span>
            <span className="spacer" />
            <button className="icon" onClick={onPrevChunk} title="Previous chunk (k)">
              ↑ k
            </button>
            <button className="icon" onClick={onNextChunk} title="Next chunk (j)">
              ↓ j
            </button>
            <span className="muted keys" title="a: approve & next · c: comment · n / p: next / previous file">
              a approve · c comment · n/p file
            </span>
          </div>
          <ol className="hunk-list single">
            <HunkCard
              key={hunk.hash + hunk.index}
              path={file.path}
              hunk={hunk}
              note={w?.hunks.find((x) => x.hash === hunk.hash) ?? w?.hunks[hunk.index]}
              approved={approved.has(approvalKey(file.path, hunk.hash))}
              auto={flow.autoReasons.get(approvalKey(file.path, hunk.hash))}
              current
              commentSignal={commentSignal}
              onToggle={() => flow.onToggleApprove(file.path, hunk.hash)}
              onShow={() => flow.onShowHunk(file.path, hunk)}
              onApproveNext={() => flow.onApproveNext(file.path, hunk)}
              onComment={(body) => flow.onComment(file.path, hunk, body)}
              onCodeRef={(p, l) => flow.onOpen(p, l)}
            />
          </ol>
        </>
      )}
      {hunks && !fh.length && !file.noise && <p className="small muted">No text changes to approve in this file (binary or renamed only).</p>}
      {index === 0 && <AutoExplain wt={wt} />}
    </div>
  )
}

// ---- Finish step ----

export function FinishStep({
  flow,
  pull,
  guide,
  drafts,
  threads,
  reviewBox,
  onDeleteDraft,
  onGoTo
}: {
  flow: ReviewFlow
  pull: PullDetail | null
  guide: ReviewGuide | null
  drafts: DraftComment[]
  threads: ReviewThread[]
  reviewBox: ReactNode
  onDeleteDraft: (id: string) => void
  onGoTo: (path: string, line: number | null, side?: 'LEFT' | 'RIGHT') => void
}) {
  const { steps, hunks, approved } = flow
  const { total, done, filesDone } = progressOf(flow)
  const left = steps.flatMap((f) => (hunks?.[f.path] ?? []).filter((h) => !approved.has(approvalKey(f.path, h.hash))).map((h) => ({ f, h })))
  const open = threads.filter((t) => !t.resolved)

  return (
    <div className="step-page finish-page">
      <div className="step-hero">
        <div>
          <h3>{done === total && total > 0 ? 'Every chunk approved' : 'Wrap up'}</h3>
          <p className="small muted">
            {done}/{total} chunks · {filesDone}/{steps.length} files approved · {drafts.length} pending comment{drafts.length === 1 ? '' : 's'}
            {open.length > 0 && ` · ${open.length} open thread${open.length > 1 ? 's' : ''}`}
          </p>
        </div>
      </div>

      <div className="finish-grid">
        <div>
          {left.length > 0 && (
            <section>
              <h4>Not approved yet ({left.length})</h4>
              <ul className="finish-list">
                {left.slice(0, 30).map(({ f, h }) => (
                  <li key={f.path + h.hash}>
                    <button className="link" onClick={() => flow.onShowHunk(f.path, h)}>
                      {f.path.split('/').pop()} {hunkRange(h)}
                    </button>{' '}
                    <span className="muted small">{h.header}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {flow.autoReasons.size > 0 && (
            <section>
              <details>
                <summary>
                  <strong>Pre-approved without you ({[...flow.autoReasons.keys()].filter((k) => steps.some((f) => k.startsWith(f.path + '#'))).length})</strong>{' '}
                  <span className="small muted">— spot-check or untick to review</span>
                </summary>
                <ul className="finish-list">
                  {steps.flatMap((f) =>
                    (hunks?.[f.path] ?? [])
                      .filter((h) => flow.autoReasons.has(approvalKey(f.path, h.hash)))
                      .map((h) => {
                        const a = flow.autoReasons.get(approvalKey(f.path, h.hash))!
                        return (
                          <li key={f.path + h.hash}>
                            <button className="link" onClick={() => flow.onShowHunk(f.path, h)}>
                              {f.path.split('/').pop()} {hunkRange(h)}
                            </button>
                            <span className="small muted">{a.kind === 'ai' ? a.reason : AUTO_LABEL[a.kind]}</span>
                            <button className="link small" onClick={() => flow.onToggleApprove(f.path, h.hash)}>
                              review it myself
                            </button>
                          </li>
                        )
                      })
                  )}
                </ul>
              </details>
            </section>
          )}

          <section>
            <h4>Your pending comments ({drafts.length})</h4>
            {drafts.length === 0 && <p className="small muted">None. They are sent together with the review below.</p>}
            <ul className="finish-list">
              {drafts.map((d) => (
                <li key={d.id}>
                  <button className="link code-ref" onClick={() => onGoTo(d.path, d.line, d.side)}>
                    {d.path.split('/').pop()}:{d.line}
                  </button>
                  <button className="link danger small" onClick={() => onDeleteDraft(d.id)}>
                    delete
                  </button>
                  <Markdown text={d.body} />
                </li>
              ))}
            </ul>
          </section>

          {open.length > 0 && (
            <section>
              <h4>Open threads ({open.length})</h4>
              <ul className="finish-list">
                {open.map((t) => (
                  <li key={t.id}>
                    <button className="link code-ref" onClick={() => onGoTo(t.path, t.line, t.side)}>
                      {t.path.split('/').pop()}
                      {t.line ? `:${t.line}` : ''}
                    </button>{' '}
                    <span className="small muted">
                      {t.comments[0]?.author}: {t.comments[0]?.body.replace(/<[^>]+>/g, '').slice(0, 120)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {guide && guide.questions.length > 0 && (
            <section>
              <h4>Questions the guide suggested</h4>
              <ul className="bullets small">
                {guide.questions.map((q, i) => (
                  <li key={i}>
                    <Markdown text={q} onCodeRef={(p, l) => onGoTo(p, l)} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <section className="finish-submit">
          <h4>Submit to GitHub{pull ? ` · #${pull.number}` : ''}</h4>
          {reviewBox}
        </section>
      </div>
    </div>
  )
}
