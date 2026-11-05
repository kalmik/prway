// Review flow pieces: per-file walkthroughs (AI summary, related code, a note per hunk), the AI review's findings, and the cards
// that show them. Used by the guided review (the main view) and by the Review tab of the Files view.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChangedFile, FileWalkthrough, GuideFile, HintFeedback, HintVerdict, Hunk, HunkAuto, PrReview, ReviewFinding } from '../../../shared/types'
import { errorText, storage, timeAgo } from '../util'
import { Markdown } from './Markdown'
import { useAiInUse } from './AiAccounts'
import { FindingItem, findingsIn } from './Findings'

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
  /** The AI account that explains files for this repository (its name). */
  account: string | null
  /** Changes whenever a rating does (for memos). */
  ratings: Map<string, HintFeedback>
  /** Your rating of a hint (a Check item, a chunk's note, a focus line) and your reason, if any. */
  feedbackOf: (kind: HintFeedback['kind'], path: string, text: string) => HintFeedback | undefined
  /**
   * Rates a hint (null clears it); `comment` is your reason (null removes it, undefined keeps it). Later
   * walkthroughs and guides get the ratings as examples and the reasons as rules.
   */
  rate: (kind: HintFeedback['kind'], path: string, text: string, verdict: HintVerdict | null, comment?: string | null) => void
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

  const aiInUse = useAiInUse(repo)
  const [ratings, setRatings] = useState<Map<string, HintFeedback>>(new Map())
  const toMap = (list: HintFeedback[]) => new Map(list.map((f) => [f.id, f]))
  useEffect(() => {
    let live = true
    api.feedback.list(repo).then((list) => live && setRatings(toMap(list)), () => undefined)
    return () => {
      live = false
    }
  }, [repo])
  const feedbackOf = (kind: HintFeedback['kind'], p: string, text: string) => ratings.get(`${kind}|${p}|${text}`)
  const rate = (kind: HintFeedback['kind'], p: string, text: string, v: HintVerdict | null, comment?: string | null) => {
    const id = `${kind}|${p}|${text}`
    setRatings((m) => {
      const next = new Map(m)
      const old = m.get(id)
      if (v) {
        const kept = comment === undefined && old?.verdict === v ? old.comment : comment?.trim() || undefined
        next.set(id, { id, kind, pr: number, path: p, text, verdict: v, comment: kept, at: new Date().toISOString() })
      } else next.delete(id)
      return next
    })
    api.feedback.rate(repo, { kind, pr: number, path: p, text, verdict: v, comment }).then(
      (list) => setRatings(toMap(list)),
      (err) => setError(errorText(err))
    )
  }

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

  return { walk, busy, error, auto, setAuto, explain, preparing, prepareAll, ratings, feedbackOf, rate, account: aiInUse?.account.name ?? null }
}

export function Elapsed() {
  const [s, setS] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setS((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span>{s}s</span>
}

/**
 * 👎 on an AI hint ("not useful"), and 💬 for your reason once marked. Shown on hover (and always once marked). The hint
 * dims; PRway tells the AI to skip points like it in later files and PRs of this repository, and your reason becomes a
 * rule. Useful hints need nothing: they keep coming.
 */
export function Rate({
  verdict,
  comment,
  onRate,
  onComment
}: {
  verdict?: HintVerdict
  comment?: string
  onRate: (v: HintVerdict | null) => void
  /** Opens the box for your reason. */
  onComment: () => void
}) {
  const noise = verdict === 'noise'
  return (
    <span className={`rate ${noise ? 'rated' : ''}`}>
      <button
        className={`rate-btn ${noise ? 'on' : ''}`}
        title={
          noise
            ? 'Marked not useful (click to undo)'
            : 'Not useful: noise, too picky or wrong here. The AI skips points like this from now on, and pre-approves chunks with nothing else to say'
        }
        onClick={(e) => {
          e.stopPropagation()
          onRate(noise ? null : 'noise')
        }}
      >
        👎
      </button>
      {noise && (
        <button
          className={`rate-btn ${comment ? 'on' : ''}`}
          title={comment ? `Your reason: ${comment} (click to edit)` : 'Say why: PRway uses your reason as a rule in later reviews'}
          onClick={(e) => {
            e.stopPropagation()
            onComment()
          }}
        >
          💬
        </button>
      )}
    </span>
  )
}

/**
 * A hint with its 👎; dimmed once marked as not useful. 👎 (or 💬) opens a box for your reason, which later AI
 * requests on this repository follow as a rule.
 */
export function RatedHint({
  text,
  feedback,
  onRate,
  onDone,
  children
}: {
  text: string
  feedback?: Pick<HintFeedback, 'verdict' | 'comment'>
  /** `comment`: your reason (null removes it, undefined keeps it). */
  onRate: (v: HintVerdict | null, comment?: string | null) => void
  /** After the reason box closes (e.g. to close the menu it sits in). */
  onDone?: () => void
  children: ReactNode
}) {
  // Only "not useful" counts (older versions also stored 👍).
  const verdict = feedback?.verdict === 'noise' ? 'noise' : undefined
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const open = () => {
    setDraft(feedback?.comment ?? '')
    setEditing(true)
  }
  const close = () => {
    setEditing(false)
    onDone?.()
  }
  const save = (v: HintVerdict) => {
    onRate(v, draft.trim() || null)
    close()
  }
  return (
    <div className={`rated-hint-wrap ${verdict === 'noise' ? 'noise' : ''}`} data-hint={text.slice(0, 40)}>
      <div className="rated-hint">
        <div className="rated-hint-text">{children}</div>
        <Rate
          verdict={verdict}
          comment={feedback?.comment}
          onRate={(v) => {
            onRate(v)
            if (v === 'noise') {
              setDraft(feedback?.verdict === 'noise' ? (feedback.comment ?? '') : '')
              setEditing(true)
            } else if (!v) setEditing(false)
          }}
          onComment={open}
        />
      </div>
      {verdict && feedback?.comment && !editing && (
        <div className="hint-reason" title="Your reason: later reviews of this repository follow it as a rule">
          💬 {feedback.comment}
        </div>
      )}
      {editing && verdict && (
        <div className="hint-reason-box" onClick={(e) => e.stopPropagation()}>
          <textarea
            autoFocus
            rows={2}
            value={draft}
            placeholder="Why isn’t this useful? e.g. “we always validate this in the controller” (optional)"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                save(verdict)
              }
              if (e.key === 'Escape') close()
            }}
          />
          <div className="row end small">
            <span className="muted spacer">PRway follows your reason as a rule in later reviews of this repository.</span>
            <button className="small" onClick={close}>
              {feedback?.comment ? 'Cancel' : 'Skip'}
            </button>
            <button className="small primary" onClick={() => save(verdict)}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Cards ----

/** Summary, hints and related code for one file, from its walkthrough. */
export function FileCard({
  file,
  guideFile: g,
  wt,
  bare,
  brief,
  findings = [],
  onOpen,
  onOpenUrl
}: {
  /** The AI review's findings in this file. */
  findings?: ReviewFinding[]
  file: ChangedFile
  guideFile?: GuideFile
  wt: Walkthroughs
  /** Without the path/risk header (the guided step already shows it). */
  bare?: boolean
  /** Only the walkthrough's content (the guided view shows the rest in the line under the file name). */
  brief?: boolean
  onOpen: (path: string, line: number | null) => void
  onOpenUrl: (url: string) => void
}) {
  const w = wt.walk[file.path]
  const busy = wt.busy === file.path
  const codeRef = (p: string, l: number) => onOpen(p, l)
  return (
    <div className={`file-card ${g ? `risk-${g.risk}` : ''}`}>
      {!bare && !brief && (
        <div className="row">
          <code className="spacer file-card-path">{file.path}</code>
          {g && <span className={`risk-tag risk-${g.risk}`}>{g.risk} risk</span>}
          {g && <span className="small muted">{g.role}</span>}
        </div>
      )}
      {g && !brief && (
        <p className="small muted">
          {bare && <strong>{g.role}: </strong>}
          {g.why}
        </p>
      )}

      {busy && !brief && (
        <p className="small muted">
          Claude{wt.account ? ` (${wt.account})` : ''} is reading this file… <Elapsed />
        </p>
      )}
      {wt.error && !busy && !brief && (
        <p className="small error">
          {wt.error}{' '}
          <button className="link" onClick={() => wt.explain(file.path, false)}>
            retry
          </button>
        </p>
      )}
      {!w && !busy && !wt.error && !brief && (
        <p className="small muted">
          <button className="link" onClick={() => wt.explain(file.path, false)}>
            Explain this file
          </button>{' '}
          to get a summary of what changes and a note per chunk.
        </p>
      )}
      {findings.length > 0 && (
        <div className="file-findings">
          <h4>AI review</h4>
          {findings.map((f) => (
            <FindingItem key={f.id} finding={f} wt={wt} onGoTo={onOpen} />
          ))}
        </div>
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
            {w.model}
            {w.account ? ` · ${w.account}` : ''} · {timeAgo(w.createdAt)} ·{' '}
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
  ai: 'AI: trivial',
  background: 'outside the core change',
  review: 'AI review: nothing to check'
}

/** How a pre-approval is described: AI and background verdicts carry their own reason. */
export const autoLabel = (a: HunkAuto) => (a.kind === 'ai' || a.kind === 'background' || a.kind === 'review' ? a.reason : AUTO_LABEL[a.kind])

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
  auto,
  wt,
  findings = []
}: {
  /** For rating the chunk's note. */
  wt?: Walkthroughs
  /** The AI review's findings in this chunk. */
  findings?: ReviewFinding[]
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
            pre-approved · {autoLabel(auto)}
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
          <RatedHint text={note.summary} feedback={wt?.feedbackOf('note', path, note.summary)} onRate={(v, c) => wt?.rate('note', path, note.summary, v, c)}>
            <Markdown text={note.summary} onCodeRef={onCodeRef} />
          </RatedHint>
        </div>
      )}
      {findings.map((f) => (
        <FindingItem key={f.id} finding={f} wt={wt} onGoTo={(p, l) => onCodeRef(p, l ?? 1)} />
      ))}
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
  /** The AI review: its findings sit in the chunks and file summaries. */
  review: PrReview | null
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
          <FileCard
            file={current}
            guideFile={guideFiles.get(current.path)}
            wt={wt}
            findings={flow.review?.findings.filter((f) => f.path === current.path)}
            onOpen={flow.onOpen}
            onOpenUrl={flow.onOpenUrl}
          />
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
                wt={wt}
                findings={findingsIn(flow.review, current.path, h)}
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
