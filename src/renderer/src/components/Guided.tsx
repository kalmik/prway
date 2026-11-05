// Guided review, PRway's main view: an outline on the left (Overview → files in reading order → Finish),
// and in the middle the current step: the PR overview, one file with its current chunk above the diff,
// or the wrap-up with the submit form.

import { useState, type ReactNode } from 'react'
import type { ChangedFile, DraftComment, Hunk, PullDetail, ReviewGuide, ReviewThread } from '../../../shared/types'
import { storage } from '../util'
import { GuidePanel } from './GuidePanel'
import { openSettings } from './SettingsDialog'
import { Markdown } from './Markdown'
import {
  approvalKey,
  AutoExplain,
  Elapsed,
  FileCard,
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
  onOpenNoise,
  onShowPreApproved
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
  /** Opens the Files view, where pre-approved chunks are listed. */
  onShowPreApproved: () => void
}) {
  const { steps, hunks, approved, guideFiles, wt } = flow
  const { fileDone } = progressOf(flow)
  // Only what needs you: pre-approved chunks are left out (the Files view has them), except the one you are on.
  const isPre = (path: string, h: Hunk) => flow.autoReasons.has(approvalKey(path, h.hash))
  const shown = (f: ChangedFile) =>
    (hunks?.[f.path] ?? []).filter((h) => !isPre(f.path, h) || (step === 'files' && current?.path === f.path && currentHunk === h.index))
  const files = steps.filter((f) => !(hunks?.[f.path] ?? []).length || shown(f).length || (step === 'files' && current?.path === f.path))
  const total = steps.reduce((n, f) => n + (hunks?.[f.path] ?? []).filter((h) => !isPre(f.path, h)).length, 0)
  const done = steps.reduce((n, f) => n + (hunks?.[f.path] ?? []).filter((h) => !isPre(f.path, h) && approved.has(approvalKey(f.path, h.hash))).length, 0)
  const preCount = steps.reduce((n, f) => n + (hunks?.[f.path] ?? []).filter((h) => isPre(f.path, h)).length, 0)
  const filesDone = files.filter((f) => fileDone(f.path)).length
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
            <strong>{done}</strong>/{total} chunks · {filesDone}/{files.length} files
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
        {files.map((f, i) => {
          const fh = shown(f)
          const ok = fh.filter((h) => approved.has(approvalKey(f.path, h.hash))).length
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
                  <span className="outline-count">
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
      {preCount > 0 && (
        <button className="outline-pre small muted" onClick={onShowPreApproved} title="Pre-approved chunks are listed in the Files view">
          {preCount} pre-approved chunk{preCount > 1 ? 's' : ''} hidden · see them in Files
        </button>
      )}

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
  repo,
  onGenerate,
  onGoTo,
  onStart
}: {
  repo: string
  guide: ReviewGuide | null
  stale: boolean
  busy: boolean
  error: string | null
  stats: { files: number; noise: number; chunks: number; pre: number; threads: number }
  pre: {
    rules: boolean
    ai: boolean
    background: boolean
    hasBriefing: boolean
    setRules: (v: boolean) => void
    setAi: (v: boolean) => void
    setBackground: (v: boolean) => void
  }
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
        <label title="Chunks the file walkthrough rates low risk that touch none of the traced core functions, business rules or watch-out lines. The core itself is never pre-approved by the AI.">
          <input type="checkbox" checked={pre.background} onChange={(e) => pre.setBackground(e.target.checked)} /> Pre-approve low-risk chunks
          outside the core change{!pre.hasBriefing && <span className="muted"> (build the Background tab first)</span>}
        </label>
        <span className="muted">
          Review instructions for this repository:{' '}
          <button className="link" onClick={() => openSettings('prompts', repo)}>
            customise
          </button>
        </span>
        {pre.ai && (
          <span className="muted">
            {wt.preparing ? (
              `Explaining files in the background${wt.account ? ` (${wt.account})` : ''}… ${wt.preparing.done}/${wt.preparing.total}`
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
      <GuidePanel guide={guide} stale={stale} busy={busy} error={error} onGenerate={onGenerate} onGoTo={onGoTo} account={wt.account ?? undefined} />
      {!guide && !busy && (
        <p className="small muted">You can also start right away: files are then reviewed in their order, without the AI reading order.</p>
      )}
    </div>
  )
}

// ---- File step: the current chunk, above the diff ----

/**
 * What the open file is about, under its name in the guided view: one line from the guide (its role and why it
 * matters) with the walkthrough's summary, checks and related code a click away. Chunk notes live in the diff.
 */
export function FileBrief({ flow, file }: { flow: ReviewFlow; file: ChangedFile }) {
  const { steps, hunks, guideFiles, wt } = flow
  const [open, setOpenState] = useState(() => storage.get('ui.fileBriefOpen', false))
  const setOpen = (v: boolean) => {
    setOpenState(v)
    storage.set('ui.fileBriefOpen', v)
  }
  const index = steps.findIndex((f) => f.path === file.path)
  const g = guideFiles.get(file.path)
  const w = wt.walk[file.path]
  const busy = wt.busy === file.path
  const checks = w?.hints.length ?? 0
  const noChunks = !!hunks && !(hunks[file.path] ?? []).length

  return (
    <div className={`file-brief ${g ? `risk-${g.risk}` : ''}`}>
      <div className="file-brief-row small">
        {index >= 0 && (
          <span className="muted nowrap">
            File {index + 1} of {steps.length}
          </span>
        )}
        <span className="file-brief-why" title={g ? `${g.role}: ${g.why}` : undefined}>
          {g ? (
            <>
              <strong>{g.role}</strong>: {g.why}
            </>
          ) : (
            <span className="muted">Not in the guide.</span>
          )}
        </span>
        {busy && (
          <span className="muted nowrap">
            Claude{wt.account ? ` (${wt.account})` : ''} is reading this file… <Elapsed />
          </span>
        )}
        {!busy && wt.error && (
          <span className="error">
            {wt.error}{' '}
            <button className="link" onClick={() => wt.explain(file.path, false)}>
              retry
            </button>
          </span>
        )}
        {!busy && !wt.error && !w && (
          <button className="link nowrap" onClick={() => wt.explain(file.path, false)} title="A summary, things to check and a note per chunk">
            Explain this file
          </button>
        )}
        {w && (
          <button className="link nowrap" onClick={() => setOpen(!open)}>
            {open ? '▾ less' : `▸ summary${checks ? ` · ${checks} to check` : ''}`}
          </button>
        )}
      </div>
      {noChunks && <p className="small muted">No text changes to approve in this file (binary or renamed only).</p>}
      {open && w && (
        <div className="file-brief-body">
          <FileCard brief file={file} guideFile={g} wt={wt} onOpen={flow.onOpen} onOpenUrl={flow.onOpenUrl} />
          <AutoExplain wt={wt} />
        </div>
      )}
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
  onGoTo,
  onShowPreApproved
}: {
  flow: ReviewFlow
  pull: PullDetail | null
  guide: ReviewGuide | null
  drafts: DraftComment[]
  threads: ReviewThread[]
  reviewBox: ReactNode
  onDeleteDraft: (id: string) => void
  onGoTo: (path: string, line: number | null, side?: 'LEFT' | 'RIGHT') => void
  onShowPreApproved: () => void
}) {
  const { steps, hunks, approved } = flow
  const { total, done, filesDone } = progressOf(flow)
  const pre = steps.reduce((n, f) => n + (hunks?.[f.path] ?? []).filter((h) => flow.autoReasons.has(approvalKey(f.path, h.hash))).length, 0)
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

          {pre > 0 && (
            <p className="small muted">
              {pre} chunk{pre > 1 ? 's were' : ' was'} pre-approved without you ·{' '}
              <button className="link" onClick={onShowPreApproved}>
                spot-check them in Files
              </button>
            </p>
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
