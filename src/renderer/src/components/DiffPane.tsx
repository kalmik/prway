// The diff of one file: Monaco side-by-side (or inline) diff with focus lines from the guide,
// moved-code marks, inline review comments and code navigation.

import { DiffEditor } from '@monaco-editor/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, DiffSide, DraftComment, FileDiff, GuideFile, ReviewThread, WorktreeInfo } from '../../../shared/types'
import { languageFor, monaco, MONO_FONT } from '../monaco'
import { attachCodeNav, type NavHandlers } from './codeNav'
import { LineComments, useViewZones, type CommentActions, type ZoneSpec } from './Comments'
import { Markdown } from './Markdown'

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
  actions: Omit<CommentActions, 'onAddDraft' | 'onCancelCompose'> & {
    onCreateDraft: (d: Omit<DraftComment, 'id' | 'headSha'>) => void
  }
}

const GUTTER = new Set<number>([
  monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
  monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
])

export function DiffPane(props: Props) {
  const { file, diff, tree, guideFile, threads, drafts, sideBySide, hideWhitespace, dark, reveal } = props
  const [modified, setModified] = useState<CodeEditor | null>(null)
  const [original, setOriginal] = useState<CodeEditor | null>(null)
  const [composing, setComposing] = useState<Composing | null>(null)
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)
  // Handlers change on every render; editors keep a stable callback that reads the latest ones.
  const latest = useRef(props)
  latest.current = props

  const commentable = useMemo(
    () => ({ LEFT: new Set(diff.commentable.left), RIGHT: new Set(diff.commentable.right) }),
    [diff]
  )
  const language = useMemo(() => languageFor(file.path), [file.path])

  // ---- Gutter: click a line to comment (a multi-line selection makes a range comment) ----
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
        ed.onMouseDown((e) => {
          if (!GUTTER.has(e.target.type) || !e.target.position) return
          const line = e.target.position.lineNumber
          if (!commentable[side].has(line)) return
          const sel = ed.getSelection()
          const startLine =
            sel && sel.startLineNumber < sel.endLineNumber && sel.endLineNumber === line && commentable[side].has(sel.startLineNumber)
              ? sel.startLineNumber
              : undefined
          setComposing({ side, line, startLine })
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

  // ---- Scroll to a requested line ----
  // The diff is computed asynchronously, and folding unchanged regions moves lines around:
  // scroll only once the diff for this model is ready.
  useEffect(() => {
    const de = diffEditorRef.current
    if (!reveal || reveal.path !== file.path || !de) return
    const ed = reveal.side === 'LEFT' && sideBySide ? original : modified
    if (!ed) return
    let frame = 0
    const go = () => {
      frame = requestAnimationFrame(() => {
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
  }, [reveal, modified, original, file.path, sideBySide])

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rightZones = useMemo(() => zonesFor('RIGHT'), [threads, drafts, composing, tree.headSha, file.path, dark])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const leftZones = useMemo(() => (sideBySide ? zonesFor('LEFT') : []), [threads, drafts, composing, tree.headSha, file.path, sideBySide, dark])
  useViewZones(modified, rightZones)
  useViewZones(original, leftZones)

  // Comments that can't sit on a line: outdated threads, and removed-line comments in the inline view.
  const detached = threads.filter((t) => !t.line || (!sideBySide && t.side === 'LEFT'))
  const detachedDrafts = sideBySide ? [] : drafts.filter((d) => d.side === 'LEFT')
  const [showDetached, setShowDetached] = useState(false)

  return (
    <div className="diff-pane">
      {(detached.length > 0 || detachedDrafts.length > 0) && (
        <div className="detached small">
          <button className="link" onClick={() => setShowDetached(!showDetached)}>
            {showDetached ? '▾' : '▸'} {detached.length + detachedDrafts.length} comment
            {detached.length + detachedDrafts.length > 1 ? 's' : ''} not shown on a line (outdated, or on removed lines in the
            inline view)
          </button>
          {showDetached && (
            <div className="detached-list">
              {detached.map((t) => (
                <div key={t.id} className="thread">
                  <div className="thread-head small muted">
                    {t.outdated ? 'outdated' : `removed line ${t.line}`} {t.resolved && <span className="tag">resolved</span>}
                  </div>
                  {t.comments.map((c) => (
                    <div key={c.id} className="comment">
                      <div className="comment-meta small">
                        <strong>{c.author}</strong>
                      </div>
                      <Markdown text={c.body} onLink={actions.onOpenUrl} />
                    </div>
                  ))}
                </div>
              ))}
              {detachedDrafts.map((d) => (
                <div key={d.id} className="thread draft">
                  <div className="thread-head small">
                    <span className="tag pending">pending</span> removed line {d.line}
                  </div>
                  <Markdown text={d.body} />
                </div>
              ))}
            </div>
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
          theme={dark ? 'vs-dark' : 'vs'}
          onMount={(ed) => {
            diffEditorRef.current = ed
            setModified(ed.getModifiedEditor())
            setOriginal(ed.getOriginalEditor())
          }}
          options={{
            readOnly: true,
            originalEditable: false,
            renderSideBySide: sideBySide,
            useInlineViewWhenSpaceIsLimited: false,
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
