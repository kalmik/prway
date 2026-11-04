// Review flow pieces: per-file walkthroughs (AI summary, hints, related code, a note per hunk) and the cards
// that show them. Used by the guided review (the main view) and by the Review tab of the Files view.

import { useEffect, useRef, useState } from 'react'
import type { ChangedFile, FileWalkthrough, GuideFile, Hunk, HunkAuto } from '../../../shared/types'
import { errorText, storage, timeAgo } from '../util'
import { Markdown } from './Markdown'

const api = window.prway

export const approvalKey = (path: string, hash: string) => `${path}#${hash}`

/** The line a hunk is "about": its first changed line (skipping up to 3 lines of context). */
export function hunkAnchor(h: Hunk): { line: number; side: 'LEFT' | 'RIGHT' } {
  return h.newLines
    ? { line: Math.min(h.newStart + 3, h.newStart + h.newLines - 1), side: 'RIGHT' }
    : { line: Math.min(h.oldStart + 3, h.oldStart + h.oldLines - 1), side: 'LEFT' }
}

export function hunkRange(h: Hunk): string {
  return h.newLines ? `L${h.newStart}–${h.newStart + h.newLines - 1}` : `removed at old L${h.oldStart}`
}

// ---- Walkthrough loading ----

export interface Walkthroughs {
  walk: Record<string, FileWalkthrough>
  busy: string | null
  error: string | null
  auto: boolean
  setAuto: (v: boolean) => void
  explain: (path: string, regenerate: boolean) => Promise<void>
  /** Background preparation of every file's walkthrough. */
  preparing: { done: number; total: number } | null
  prepareAll: (paths: string[]) => void
}

/**
 * Walkthroughs per file: loads the saved one for `path`, or makes it when "auto" is on, then prepares
 * `next` in the background so moving on is instant.
 */
export function useWalkthroughs(
  repo: string,
  number: number,
  headSha: string,
  path: string | null,
  next: string | null,
  /** Files whose saved walkthroughs are loaded up front (their AI "trivial" verdicts pre-approve chunks). */
  allPaths: string[]
): Walkthroughs {
  const [walk, setWalk] = useState<Record<string, FileWalkthrough>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [auto, setAutoState] = useState(() => storage.get('ui.autoExplain', true))
  const setAuto = (v: boolean) => {
    setAutoState(v)
    storage.set('ui.autoExplain', v)
  }

  const [preparing, setPreparing] = useState<{ done: number; total: number } | null>(null)

  useEffect(() => {
    setWalk({})
  }, [headSha])

  // Saved walkthroughs are cheap to read: load all of them so every file's verdicts count.
  const allKey = allPaths.join('\n')
  useEffect(() => {
    if (!headSha) return
    let live = true
    void Promise.all(allPaths.map((p) => api.review.cachedWalkthrough(repo, number, p).catch(() => null))).then((list) => {
      if (!live) return
      const found = Object.fromEntries(list.filter((w): w is FileWalkthrough => !!w).map((w) => [w.path, w]))
      setWalk((m) => ({ ...found, ...m }))
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, number, headSha, allKey])

  function prepareAll(paths: string[]) {
    const todo = paths.filter((p) => !walk[p])
    if (!todo.length || preparing) return
    setPreparing({ done: 0, total: todo.length })
    // Poll the saved files while the main process works through them, so progress shows.
    const timer = setInterval(() => {
      void Promise.all(todo.map((p) => api.review.cachedWalkthrough(repo, number, p).catch(() => null))).then((list) => {
        const found = list.filter((w): w is FileWalkthrough => !!w)
        setWalk((m) => ({ ...m, ...Object.fromEntries(found.map((w) => [w.path, w])) }))
        setPreparing((pr) => (pr ? { ...pr, done: found.length } : pr))
      })
    }, 4000)
    api.review
      .prepareAll(repo, number, todo)
      .catch((err) => setError(errorText(err)))
      .finally(() => {
        clearInterval(timer)
        void Promise.all(todo.map((p) => api.review.cachedWalkthrough(repo, number, p).catch(() => null))).then((list) => {
          setWalk((m) => ({ ...m, ...Object.fromEntries(list.filter((w): w is FileWalkthrough => !!w).map((w) => [w.path, w])) }))
          setPreparing(null)
        })
      })
  }

  useEffect(() => {
    if (!path || walk[path]) return
    let live = true
    setError(null)
    void (async () => {
      try {
        const saved = await api.review.cachedWalkthrough(repo, number, path)
        if (saved) {
          if (live) setWalk((m) => ({ ...m, [path]: saved }))
        } else if (auto) {
          setBusy(path)
          const made = await api.review.walkthrough(repo, number, path)
          if (live) setWalk((m) => ({ ...m, [path]: made }))
        }
        if (auto && next) {
          api.review.walkthrough(repo, number, next).then(
            (made) => setWalk((m) => ({ ...m, [next]: made })),
            () => undefined
          )
        }
      } catch (err) {
        if (live) setError(errorText(err))
      } finally {
        if (live) setBusy((b) => (b === path ? null : b))
      }
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, headSha, auto])

  async function explain(p: string, regenerate: boolean) {
    setBusy(p)
    setError(null)
    try {
      const made = await api.review.walkthrough(repo, number, p, regenerate)
      setWalk((m) => ({ ...m, [p]: made }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  return { walk, busy, error, auto, setAuto, explain, preparing, prepareAll }
}

function Elapsed() {
  const [s, setS] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setS((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span>{s}s</span>
}

// ---- Cards ----

/** Summary, hints and related code for one file, from its walkthrough. */
export function FileCard({
  file,
  guideFile: g,
  wt,
  bare,
  onOpen,
  onOpenUrl
}: {
  file: ChangedFile
  guideFile?: GuideFile
  wt: Walkthroughs
  /** Without the path/risk header (the guided step already shows it). */
  bare?: boolean
  onOpen: (path: string, line: number | null) => void
  onOpenUrl: (url: string) => void
}) {
  const w = wt.walk[file.path]
  const busy = wt.busy === file.path
  const codeRef = (p: string, l: number) => onOpen(p, l)
  return (
    <div className={`file-card ${g ? `risk-${g.risk}` : ''}`}>
      {!bare && (
        <div className="row">
          <code className="spacer file-card-path">{file.path}</code>
          {g && <span className={`risk-tag risk-${g.risk}`}>{g.risk} risk</span>}
          {g && <span className="small muted">{g.role}</span>}
        </div>
      )}
      {g && (
        <p className="small muted">
          {bare && <strong>{g.role}: </strong>}
          {g.why}
        </p>
      )}

      {busy && (
        <p className="small muted">
          Claude is reading this file… <Elapsed />
        </p>
      )}
      {wt.error && !busy && (
        <p className="small error">
          {wt.error}{' '}
          <button className="link" onClick={() => wt.explain(file.path, false)}>
            retry
          </button>
        </p>
      )}
      {!w && !busy && !wt.error && (
        <p className="small muted">
          <button className="link" onClick={() => wt.explain(file.path, false)}>
            Explain this file
          </button>{' '}
          to get a summary, hints and a note per chunk.
        </p>
      )}
      {w && (
        <div className="file-card-body">
          <div className="file-summary">
            {w.summary.trim() ? (
              <Markdown text={w.summary} onCodeRef={codeRef} onLink={onOpenUrl} />
            ) : (
              <p className="small muted">No behaviour change in this file.</p>
            )}
          </div>
          {w.hints.length > 0 && (
            <div>
              <h4>Check</h4>
              <ul className="bullets small">
                {w.hints.map((h, i) => (
                  <li key={i}>
                    <Markdown text={h} onCodeRef={codeRef} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {w.refs.length > 0 && (
            <div>
              <h4>Related code</h4>
              <ul className="refs small">
                {w.refs.map((r, i) => (
                  <li key={i}>
                    <button className="link code-ref" onClick={() => onOpen(r.path, r.line)}>
                      {r.path}
                      {r.line ? `:${r.line}` : ''}
                    </button>{' '}
                    <span className="muted">{r.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="small muted">
            {w.model} · {timeAgo(w.createdAt)} ·{' '}
            <button className="link" disabled={busy} onClick={() => wt.explain(file.path, true)}>
              regenerate
            </button>
          </p>
        </div>
      )}
    </div>
  )
}

export const AUTO_LABEL: Record<HunkAuto['kind'], string> = {
  imports: 'imports only',
  comments: 'comments only',
  blank: 'blank lines',
  formatting: 'formatting only',
  moved: 'moved code',
  ai: 'AI: trivial'
}

export function HunkCard({
  path,
  hunk,
  note,
  approved,
  current,
  onToggle,
  onShow,
  onApproveNext,
  onComment,
  onCodeRef,
  commentSignal = 0,
  auto
}: {
  /** Set when the chunk is pre-approved (rules or AI) rather than approved by you. */
  auto?: HunkAuto
  path: string
  hunk: Hunk
  note?: FileWalkthrough['hunks'][number]
  approved: boolean
  current: boolean
  onToggle: () => void
  onShow: () => void
  onApproveNext: () => void
  onComment: (body: string) => void
  onCodeRef: (path: string, line: number) => void
  /** Bumped by the "c" shortcut to open the comment box. */
  commentSignal?: number
}) {
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState(false)
  // Keep the current chunk in view when it changes (e.g. after clicking it in the code).
  const ref = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (current) void ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [current])
  // Only a new press of "c" opens the box, not the count left over from an earlier chunk.
  const seenSignal = useRef(commentSignal)
  useEffect(() => {
    if (commentSignal !== seenSignal.current) {
      seenSignal.current = commentSignal
      setWriting(true)
    }
  }, [commentSignal])
  // Pre-approved chunks stay one line: nothing to read unless you ask.
  const quiet = !!auto && !expanded && !writing

  function send() {
    if (!text.trim()) return
    onComment(text.trim())
    setText('')
    setWriting(false)
  }

  return (
    <li ref={ref} className={`hunk-card ${approved ? 'approved' : ''} ${auto ? 'auto' : ''} ${current ? 'current' : ''}`}>
      <div className="hunk-head">
        <label className="approve" title="Approve this chunk locally (only you see it)">
          <input type="checkbox" checked={approved} onChange={onToggle} />
        </label>
        <button className="link hunk-title" onClick={onShow} title={`Show in the diff (${path})`}>
          <span className="hunk-range">{hunkRange(hunk)}</span>
          {hunk.header && <code className="hunk-fn">{hunk.header}</code>}
        </button>
        <span className="small nowrap">
          <span className="add">+{hunk.added}</span> <span className="del">−{hunk.deleted}</span>
        </span>
        {note && note.risk !== 'low' && <span className={`risk-tag risk-${note.risk}`}>{note.risk}</span>}
        {auto && (
          <span className="auto-tag" title={`${auto.reason}. Untick to review it yourself.`}>
            pre-approved · {auto.kind === 'ai' ? auto.reason : AUTO_LABEL[auto.kind]}
          </span>
        )}
        <span className="spacer" />
        {!approved && (
          <button className="small nowrap" onClick={onApproveNext} title="Approve and go to the next chunk (a)">
            Approve & next
          </button>
        )}
        {auto && (
          <button className="link small" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'less' : 'details'}
          </button>
        )}
      </div>
      {quiet ? null : (
        <>
      {note?.summary && (
        <div className="hunk-summary">
          <Markdown text={note.summary} onCodeRef={onCodeRef} />
        </div>
      )}
      {note && note.notes.length > 0 && (
        <ul className="bullets hunk-notes small">
          {note.notes.map((n, i) => (
            <li key={i}>
              <Markdown text={n} onCodeRef={onCodeRef} />
            </li>
          ))}
        </ul>
      )}
      {writing ? (
        <div className="comment-box">
          <textarea
            autoFocus
            rows={2}
            placeholder="Comment on this chunk (added to your pending review)…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send()
              if (e.key === 'Escape') setWriting(false)
            }}
          />
          <div className="row end">
            <button onClick={() => setWriting(false)}>Cancel</button>
            <button className="primary" disabled={!text.trim()} onClick={send}>
              Add to review
            </button>
          </div>
        </div>
      ) : (
        <button className="link small" onClick={() => setWriting(true)} title="Comment on this chunk (c)">
          + Comment on this chunk
        </button>
      )}
        </>
      )}
    </li>
  )
}

// ---- Review tab (Files view) ----

export interface ReviewFlow {
  steps: ChangedFile[]
  guideFiles: Map<string, GuideFile>
  hunks: Record<string, Hunk[]> | null
  /** Approved chunks: yours plus the pre-approved ones you didn't send back. */
  approved: Set<string>
  /** Pre-approved chunks (still in effect), with why. */
  autoReasons: Map<string, HunkAuto>
  wt: Walkthroughs
  onToggleApprove: (path: string, hash: string) => void
  onShowHunk: (path: string, hunk: Hunk) => void
  onGoFile: (path: string) => void
  onApproveNext: (path: string, hunk: Hunk) => void
  onOpen: (path: string, line: number | null) => void
  onComment: (path: string, hunk: Hunk, body: string) => void
  onOpenUrl: (url: string) => void
}

/** Overall progress, in chunks and fully approved files. */
export function progressOf(flow: Pick<ReviewFlow, 'steps' | 'hunks' | 'approved'>) {
  const { steps, hunks, approved } = flow
  const total = steps.reduce((n, f) => n + (hunks?.[f.path]?.length ?? 0), 0)
  const done = steps.reduce((n, f) => n + (hunks?.[f.path] ?? []).filter((h) => approved.has(approvalKey(f.path, h.hash))).length, 0)
  const fileDone = (path: string) => {
    const hs = hunks?.[path] ?? []
    return hs.length > 0 && hs.every((h) => approved.has(approvalKey(path, h.hash)))
  }
  return { total, done, filesDone: steps.filter((f) => fileDone(f.path)).length, fileDone }
}

export function ReviewPanel({ flow, current, currentHunk }: { flow: ReviewFlow; current: ChangedFile | null; currentHunk: number | null }) {
  const { steps, guideFiles, hunks, approved, wt } = flow
  const index = current ? steps.findIndex((f) => f.path === current.path) : -1
  const fileHunks = (current && hunks?.[current.path]) || []
  const w = current ? wt.walk[current.path] : undefined
  const next = index >= 0 ? steps[index + 1] : steps[0]
  const prev = index > 0 ? steps[index - 1] : undefined
  const { total, done, filesDone, fileDone } = progressOf(flow)
  const codeRef = (p: string, l: number) => flow.onOpen(p, l)

  return (
    <div className="panel-body review-panel">
      <div className="review-progress">
        <div className="row">
          <strong className="spacer">
            {index >= 0 ? `File ${index + 1} of ${steps.length}` : current ? 'This file is not in the review steps (noise)' : 'Review'}
          </strong>
          <span className="small muted">
            {done}/{total} chunks · {filesDone}/{steps.length} files approved
          </span>
          <button disabled={!prev} onClick={() => prev && flow.onGoFile(prev.path)}>
            ← Prev
          </button>
          <button className={current && fileDone(current.path) ? 'primary' : ''} disabled={!next} onClick={() => next && flow.onGoFile(next.path)}>
            {index < 0 ? 'Start →' : 'Next file →'}
          </button>
        </div>
        <div className="progress">
          <div style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      </div>

      {current && index >= 0 && (
        <>
          <FileCard file={current} guideFile={guideFiles.get(current.path)} wt={wt} onOpen={flow.onOpen} onOpenUrl={flow.onOpenUrl} />
          <h4>
            Chunks ({fileHunks.filter((h) => approved.has(approvalKey(current.path, h.hash))).length}/{fileHunks.length} approved)
          </h4>
          {!hunks && <p className="small muted">Loading chunks…</p>}
          {hunks && fileHunks.length === 0 && <p className="small muted">No text changes in this file (binary or renamed only).</p>}
          <ol className="hunk-list">
            {fileHunks.map((h) => (
              <HunkCard
                key={h.hash + h.index}
                path={current.path}
                hunk={h}
                note={w?.hunks.find((x) => x.hash === h.hash) ?? w?.hunks[h.index]}
                approved={approved.has(approvalKey(current.path, h.hash))}
                auto={flow.autoReasons.get(approvalKey(current.path, h.hash))}
                current={currentHunk === h.index}
                onToggle={() => flow.onToggleApprove(current.path, h.hash)}
                onShow={() => flow.onShowHunk(current.path, h)}
                onApproveNext={() => flow.onApproveNext(current.path, h)}
                onComment={(body) => flow.onComment(current.path, h, body)}
                onCodeRef={codeRef}
              />
            ))}
          </ol>
        </>
      )}

      {index < 0 && steps.length > 0 && (
        <p className="small muted">
          Go through the files in {guideFiles.size ? 'the guide’s reading order' : 'order'}: each file gets a summary and a note per
          chunk, and you approve chunks as you go (locally, only you see it).{' '}
          <button className="link" onClick={() => flow.onGoFile(steps[0].path)}>
            Start with {steps[0].path.split('/').pop()}
          </button>
        </p>
      )}

      <AutoExplain wt={wt} />
    </div>
  )
}

export function AutoExplain({ wt }: { wt: Walkthroughs }) {
  return (
    <label className="small muted auto-explain">
      <input type="checkbox" checked={wt.auto} onChange={(e) => wt.setAuto(e.target.checked)} /> Explain each file automatically when I
      open it (and prepare the next one)
    </label>
  )
}
