// The diff of one file: Monaco side-by-side (or inline) diff with focus lines from the guide,
// moved-code marks, inline review comments and code navigation.

import { DiffEditor } from '@monaco-editor/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, DiffSide, DraftComment, FileDiff, GuideFile, Hunk, HunkAuto, ReviewThread, WorktreeInfo } from '../../../shared/types'
import { languageFor, monaco, MONO_FONT } from '../monaco'
import { attachCodeNav, linesRef, type NavHandlers } from './codeNav'
import { attachLineMenu, copyReference, LineMenu, type LineMenuAt } from './LineMenu'
import { LineComments, useViewZones, type CommentActions, type ZoneSpec } from './Comments'
import { Markdown } from './Markdown'
import { AUTO_LABEL, hunkAnchor, hunkRange } from './ReviewPanel'

type CodeEditor = monaco.editor.IStandaloneCodeEditor

export interface RevealRequest {
  path: string
  line: number
  side: DiffSide
  /** Changes on every request, so asking twice for the same line still scrolls. */
  seq: number
}

interface Composing {
  side: DiffSide
  line: number
  startLine?: number
}

export interface HunkMark {
  hunk: Hunk
  approved: boolean
  current: boolean
  position: number
  total: number
  auto?: HunkAuto
  /** The walkthrough's one-line summary of the chunk, if any. */
  summary?: string
}

/** Lines a chunk covers on the side it is shown on (removed-only chunks live on the left). */
function hunkSpan(h: Hunk): { side: DiffSide; start: number; end: number } {
  return h.newLines > 0
    ? { side: 'RIGHT', start: h.newStart, end: h.newStart + h.newLines - 1 }
    : { side: 'LEFT', start: h.oldStart, end: h.oldStart + Math.max(1, h.oldLines) - 1 }
}

/** The bar shown just above the current chunk, in the code. */
function ChunkBanner({ mark, onApproveNext, onComment }: { mark: HunkMark; onApproveNext: () => void; onComment: () => void }) {
  const h = mark.hunk
  return (
    <div className={`chunk-banner ${mark.approved ? 'approved' : ''}`}>
      <span className="chunk-banner-title">
        ▶ Chunk {mark.position} of {mark.total}
      </span>
      <span className="muted">{hunkRange(h)}</span>
      {h.header && <code>{h.header}</code>}
      {mark.summary && <span className="chunk-banner-summary">{mark.summary}</span>}
      <span className="spacer" />
      {mark.auto ? (
        <span className="auto-tag">pre-approved · {mark.auto.kind === 'ai' ? mark.auto.reason : AUTO_LABEL[mark.auto.kind]}</span>
      ) : mark.approved ? (
        <span className="ok">✓ approved</span>
      ) : (
        <button className="primary small" onClick={onApproveNext} title="Approve and go to the next chunk (a)">
          Approve & next
        </button>
      )}
      <button className="small" onClick={onComment} title="Comment on this chunk (c)">
        Comment
      </button>
    </div>
  )
}

interface Props {
  file: ChangedFile
  diff: FileDiff
  tree: WorktreeInfo
  guideFile?: GuideFile
  threads: ReviewThread[]
  drafts: DraftComment[]
  sideBySide: boolean
  hideWhitespace: boolean
  dark: boolean
  reveal: RevealRequest | null
  nav: NavHandlers
  /** Review-flow chunks of this file: the current one is outlined, approved ones get a green bar. */
  hunkMarks?: HunkMark[]
  /** Clicking inside a chunk in the code makes it the current one. */
  onSelectHunk?: (h: Hunk) => void
  onApproveNext?: (h: Hunk) => void
  /** Opens the Threads tab (for threads that can't sit on a line). */
  onShowThreads?: () => void
  actions: Omit<CommentActions, 'onAddDraft' | 'onCancelCompose'> & {
    onCreateDraft: (d: Omit<DraftComment, 'id' | 'headSha'>) => void
  }
}

const GUTTER = new Set<number>([
  monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
  monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
])

/**
 * Where you were in each file version ("head/<sha>/<path>"), so coming back to a file or switching between the
 * Guided, Files and Code views returns to the same place. Also the last reveal handled, so a remount doesn't replay it.
 */
const scrollMemory = new Map<string, number>()
const handledReveal = new Map<string, number>()

export function DiffPane(props: Props) {
  const { file, diff, tree, guideFile, threads, drafts, sideBySide, hideWhitespace, dark, reveal } = props
  const [modified, setModified] = useState<CodeEditor | null>(null)
  const [original, setOriginal] = useState<CodeEditor | null>(null)
  const [composing, setComposing] = useState<Composing | null>(null)
  const [lineMenu, setLineMenu] = useState<(LineMenuAt & { side: DiffSide }) | null>(null)
  const closeLineMenu = useCallback(() => setLineMenu(null), [])
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  // Handlers change on every render; editors keep a stable callback that reads the latest ones.
  const latest = useRef(props)
  latest.current = props
  const sideBySideRef = useRef(sideBySide)
  sideBySideRef.current = sideBySide

  const commentable = useMemo(
    () => ({ LEFT: new Set(diff.commentable.left), RIGHT: new Set(diff.commentable.right) }),
    [diff]
  )
  const language = useMemo(() => languageFor(file.path), [file.path])

  // ---- Gutter: click a line number (or drag over several) for the line menu: comment, ask in chat… ----
  useEffect(() => {
    const sides: [CodeEditor | null, DiffSide][] = [
      [modified, 'RIGHT'],
      [original, 'LEFT']
    ]
    const disposables: monaco.IDisposable[] = []
    for (const [ed, side] of sides) {
      if (!ed) continue
      const hover = ed.createDecorationsCollection()
      disposables.push(
        attachLineMenu(ed, (at) => setLineMenu({ ...at, side })),
        ed.onMouseDown((e) => {
          const T = monaco.editor.MouseTargetType
          if ((e.target.type === T.CONTENT_TEXT || e.target.type === T.CONTENT_EMPTY) && e.target.position) {
            if (e.event.metaKey || e.event.ctrlKey) return // go to definition
            const line = e.target.position.lineNumber
            const mark = latest.current.hunkMarks?.find((m) => {
              const span = hunkSpan(m.hunk)
              return (span.side === side || !sideBySideRef.current) && line >= span.start && line <= span.end
            })
            if (mark && !mark.current) latest.current.onSelectHunk?.(mark.hunk)
          }
        }),
        ed.onMouseMove((e) => {
          const line = e.target.position?.lineNumber
          if (GUTTER.has(e.target.type) && line && commentable[side].has(line)) {
            hover.set([{ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'comment-add-glyph' } }])
          } else hover.clear()
        }),
        ed.onMouseLeave(() => hover.clear()),
        { dispose: () => hover.clear() }
      )
    }
    return () => disposables.forEach((d) => d.dispose())
  }, [modified, original, commentable])
  useEffect(() => setLineMenu(null), [file.path])

  function lineMenuItems(m: LineMenuAt & { side: DiffSide }) {
    const ed = m.side === 'LEFT' ? original : modified
    const path = m.side === 'LEFT' ? (file.oldPath ?? file.path) : file.path
    const canComment = commentable[m.side].has(m.end)
    return [
      {
        label: m.start === m.end ? 'Comment on this line' : 'Comment on these lines',
        disabledReason: canComment ? undefined : 'GitHub only takes comments on lines in the diff (changed lines and the few around them)',
        run: () =>
          setComposing({ side: m.side, line: m.end, startLine: m.start < m.end && commentable[m.side].has(m.start) ? m.start : undefined })
      },
      {
        label: 'Ask in Chat',
        hint: '⌘L',
        run: () => {
          const ref = ed && linesRef(ed, m.start, m.end)
          if (ref) latest.current.nav.onAskChat?.(ref)
        }
      },
      { label: 'Copy reference', run: () => copyReference(path, m.start, m.end) }
    ]
  }

  // ---- Keep Monaco's inner container from being scrolled by the browser ----
  // Typing in a comment box inside the diff makes the browser scroll its container to show the caret; Monaco
  // doesn't expect that and the code jumps. Undo any such scroll right away (Monaco scrolls its own way).
  useEffect(() => {
    const guards = [modified, original]
      .map((ed) => ed?.getDomNode()?.querySelector<HTMLElement>('.overflow-guard'))
      .filter((g): g is HTMLElement => !!g)
    const reset = (e: Event) => {
      const g = e.currentTarget as HTMLElement
      if (g.scrollTop || g.scrollLeft) {
        g.scrollTop = 0
        g.scrollLeft = 0
      }
    }
    guards.forEach((g) => g.addEventListener('scroll', reset))
    return () => guards.forEach((g) => g.removeEventListener('scroll', reset))
  }, [modified, original])

  // ---- Code navigation on both sides ----
  useEffect(() => {
    const ds = [modified, original].filter((e): e is CodeEditor => !!e).map((ed) => attachCodeNav(ed, () => latest.current.nav))
    return () => ds.forEach((d) => d.dispose())
  }, [modified, original])

  // ---- Decorations: guide focus lines, moved code, lines with comments ----
  useEffect(() => {
    if (!modified || !original) return
    const commentLines = (side: DiffSide) =>
      new Set([
        ...threads.filter((t) => t.side === side && t.line).map((t) => t.line!),
        ...drafts.filter((d) => d.side === side).map((d) => d.line)
      ])
    const moved = (lines: number[]): monaco.editor.IModelDeltaDecoration[] =>
      lines.map((l) => ({
        range: new monaco.Range(l, 1, l, 1),
        options: { isWholeLine: true, className: 'moved-line', linesDecorationsClassName: 'moved-gutter', hoverMessage: { value: 'Moved code: git found this block elsewhere in the PR' } }
      }))
    const marks = (side: DiffSide): monaco.editor.IModelDeltaDecoration[] =>
      [...commentLines(side)].map((l) => ({ range: new monaco.Range(l, 1, l, 1), options: { glyphMarginClassName: 'comment-glyph' } }))
    const mod = modified.createDecorationsCollection([
      ...(guideFile?.focus ?? []).map((f) => ({
        range: new monaco.Range(f.line, 1, f.line, 1),
        options: {
          isWholeLine: true,
          className: 'focus-line',
          glyphMarginClassName: 'focus-glyph',
          hoverMessage: { value: `**Focus:** ${f.note}` }
        }
      })),
      ...moved(diff.moved.right),
      ...marks('RIGHT')
    ])
    const orig = original.createDecorationsCollection([...moved(diff.moved.left), ...marks('LEFT')])
    return () => {
      mod.clear()
      orig.clear()
    }
  }, [modified, original, diff, guideFile, threads, drafts])

  // ---- Review chunks: current and approved ----
  const { hunkMarks } = props
  useEffect(() => {
    if (!modified || !original || !hunkMarks?.length) return
    const right: monaco.editor.IModelDeltaDecoration[] = []
    const left: monaco.editor.IModelDeltaDecoration[] = []
    for (const { hunk: h, approved, current } of hunkMarks) {
      const { side, start, end } = hunkSpan(h)
      const list = side === 'RIGHT' ? right : left
      if (current) {
        // No background fill (it would stack on the green/red diff colours): a frame above and below instead.
        list.push(
          { range: new monaco.Range(start, 1, start, 1), options: { isWholeLine: true, className: 'hunk-current-top' } },
          { range: new monaco.Range(end, 1, end, 1), options: { isWholeLine: true, className: 'hunk-current-bottom' } }
        )
      }
      list.push({
        range: new monaco.Range(start, 1, end, 1),
        options: current
          ? {
              isWholeLine: true,
              linesDecorationsClassName: 'hunk-current-gutter',
              overviewRuler: { color: '#4493f8', position: monaco.editor.OverviewRulerLane.Full }
            }
          : {
              isWholeLine: true,
              // Every chunk shows its extent in the gutter: green once approved, grey while it waits.
              linesDecorationsClassName: approved ? 'hunk-approved-gutter' : 'hunk-gutter'
            }
      })
    }
    const r = modified.createDecorationsCollection(right)
    const l = original.createDecorationsCollection(left)
    return () => {
      r.clear()
      l.clear()
    }
  }, [modified, original, hunkMarks])

  // ---- Remember the scroll position, and restore it once the diff is ready ----
  const memoryKey = `head/${tree.headSha}/${file.path}`
  useEffect(() => {
    const de = diffEditorRef.current
    if (!modified || !de) return
    let ready = false
    let frame = 0
    const save = modified.onDidScrollChange(() => {
      if (ready) scrollMemory.set(memoryKey, modified.getScrollTop())
    })
    const restore = () => {
      frame = requestAnimationFrame(() => {
        const r = latest.current.reveal
        const pendingReveal = r && r.path === file.path && handledReveal.get(memoryKey) !== r.seq
        const saved = scrollMemory.get(memoryKey)
        if (!pendingReveal && saved !== undefined) modified.setScrollTop(saved)
        ready = true
      })
    }
    let sub: monaco.IDisposable | null = null
    if (de.getLineChanges()) restore()
    else
      sub = de.onDidUpdateDiff(() => {
        sub?.dispose()
        restore()
      })
    return () => {
      save.dispose()
      sub?.dispose()
      cancelAnimationFrame(frame)
    }
  }, [modified, memoryKey, file.path])

  // ---- Scroll to a requested line ----
  // The diff is computed asynchronously, and folding unchanged regions moves lines around:
  // scroll only once the diff for this model is ready.
  useEffect(() => {
    const de = diffEditorRef.current
    if (!reveal || reveal.path !== file.path || !de) return
    // Already shown before this pane was remounted: keep where you scrolled since.
    if (handledReveal.get(`head/${tree.headSha}/${file.path}`) === reveal.seq) return
    const ed = reveal.side === 'LEFT' && sideBySide ? original : modified
    if (!ed) return
    let frame = 0
    const go = () => {
      frame = requestAnimationFrame(() => {
        handledReveal.set(`head/${tree.headSha}/${file.path}`, reveal.seq)
        ed.revealLineInCenter(reveal.line)
        ed.setPosition({ lineNumber: reveal.line, column: 1 })
      })
    }
    if (de.getLineChanges()) {
      go()
      return () => cancelAnimationFrame(frame)
    }
    const sub = de.onDidUpdateDiff(() => {
      sub.dispose()
      go()
    })
    return () => {
      sub.dispose()
      cancelAnimationFrame(frame)
    }
  }, [reveal, modified, original, file.path, sideBySide, tree.headSha])

  // ---- Comment zones ----
  const actions: CommentActions = useMemo(
    () => ({
      onReply: (t, b) => latest.current.actions.onReply(t, b),
      onResolve: (t, r) => latest.current.actions.onResolve(t, r),
      onSaveDraft: (d) => latest.current.actions.onSaveDraft(d),
      onDeleteDraft: (id) => latest.current.actions.onDeleteDraft(id),
      onOpenUrl: (u) => latest.current.actions.onOpenUrl(u),
      onCodeRef: (p, l) => latest.current.actions.onCodeRef(p, l),
      onCancelCompose: () => setComposing(null),
      onAddDraft: () => undefined
    }),
    []
  )

  const zonesFor = (side: DiffSide): ZoneSpec[] => {
    const lines = new Set<number>([
      ...threads.filter((t) => t.side === side && t.line).map((t) => t.line!),
      ...drafts.filter((d) => d.side === side).map((d) => d.line),
      ...(composing?.side === side ? [composing.line] : [])
    ])
    return [...lines].map((line) => {
      const compose = composing?.side === side && composing.line === line ? composing : null
      return {
        key: `${side}:${line}`,
        line,
        node: (
          <LineComments
            threads={threads.filter((t) => t.side === side && t.line === line)}
            drafts={drafts.filter((d) => d.side === side && d.line === line)}
            composing={compose}
            headSha={tree.headSha}
            actions={{
              ...actions,
              onAddDraft: (body) => {
                latest.current.actions.onCreateDraft({ path: file.path, side, line, startLine: compose?.startLine, body })
                setComposing(null)
              }
            }}
          />
        )
      }
    })
  }
  const currentMark = hunkMarks?.find((m) => m.current)
  const bannerZone = (): ZoneSpec[] => {
    if (!currentMark) return []
    const h = currentMark.hunk
    return [
      {
        key: `chunk:${h.hash}:${currentMark.approved}:${currentMark.summary ?? ''}`,
        // Above the chunk, on the new side (inline view shows removed lines there too).
        line: Math.max(0, h.newStart - 1),
        node: (
          <ChunkBanner
            mark={currentMark}
            onApproveNext={() => latest.current.onApproveNext?.(h)}
            onComment={() => {
              const a = hunkAnchor(h)
              setComposing({ side: a.side === 'LEFT' && sideBySideRef.current ? 'LEFT' : 'RIGHT', line: a.side === 'LEFT' ? h.newStart : a.line })
            }}
          />
        )
      }
    ]
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rightZones = useMemo(() => [...bannerZone(), ...zonesFor('RIGHT')], [threads, drafts, composing, tree.headSha, file.path, dark, currentMark])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const leftZones = useMemo(() => (sideBySide ? zonesFor('LEFT') : []), [threads, drafts, composing, tree.headSha, file.path, sideBySide, dark])
  useViewZones(modified, rightZones)
  useViewZones(original, leftZones)

  // Comments that can't sit on a line: outdated threads, and removed-line comments in the inline view.
  const detached = threads.filter((t) => !t.line || (!sideBySide && t.side === 'LEFT'))
  const detachedDrafts = sideBySide ? [] : drafts.filter((d) => d.side === 'LEFT')

  return (
    <div className="diff-pane">
      {lineMenu && <LineMenu at={lineMenu} items={lineMenuItems(lineMenu)} onClose={closeLineMenu} />}
      {(detached.length > 0 || detachedDrafts.length > 0) && (
        <div className="detached small">
          {detached.length > 0 && (
            <>
              {detached.length} thread{detached.length > 1 ? 's' : ''} on this file can't be shown on a line
              {detached.some((t) => t.outdated) ? ' (the code changed since)' : ''} ·{' '}
              <button className="link" onClick={() => latest.current.onShowThreads?.()}>
                read {detached.length > 1 ? 'them' : 'it'} in the Threads tab
              </button>
            </>
          )}
          {detachedDrafts.length > 0 && (
            <span>
              {detached.length > 0 && ' · '}
              {detachedDrafts.length} pending comment{detachedDrafts.length > 1 ? 's' : ''} on removed lines (turn on side by side to see{' '}
              {detachedDrafts.length > 1 ? 'them' : 'it'})
            </span>
          )}
        </div>
      )}
      <div className="editor-host">
        <DiffEditor
          key={file.path}
          original={diff.original}
          modified={diff.modified}
          language={language}
          originalModelPath={`base/${tree.mergeBase}/${file.oldPath ?? file.path}`}
          modifiedModelPath={`head/${tree.headSha}/${file.path}`}
          theme={dark ? 'prway-dark' : 'prway-light'}
          onMount={(ed) => {
            diffEditorRef.current = ed
            setModified(ed.getModifiedEditor())
            setOriginal(ed.getOriginalEditor())
          }}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: sideBySide,
            // Too narrow for two sides (e.g. with the outline and review card open): show inline, like GitHub.
            useInlineViewWhenSpaceIsLimited: true,
            renderSideBySideInlineBreakpoint: 760,
            ignoreTrimWhitespace: hideWhitespace,
            automaticLayout: true,
            minimap: { enabled: false },
            glyphMargin: true,
            scrollBeyondLastLine: false,
            renderOverviewRuler: true,
            fontFamily: MONO_FONT,
            fontSize: 12.5,
            lineHeight: 19,
            fontLigatures: false,
            // Moves inside the file; moves between files come from git (see the moved-line marks).
            experimental: { showMoves: true },
            // Fold long runs of unchanged lines so the focus stays on what changed.
            hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 }
          }}
        />
      </div>
    </div>
  )
}
