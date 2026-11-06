// Code view: the whole repository at the PR head, like an IDE. A file tree (changed files marked), quick open,
// editor tabs, read-only files with the PR's changed lines marked in the gutter, and go to definition.

import { Editor } from '@monaco-editor/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, DraftComment } from '../../../shared/types'
import { languageFor, monaco, MONO_FONT } from '../monaco'
import { errorText, useStored } from '../util'
import { buildTree, compact, type Dir } from '../fileTree'
import { attachCodeNav, linesRef, type NavHandlers } from './codeNav'
import { attachLineMenu, copyReference, LineMenu, type LineMenuAt } from './LineMenu'
import { LineComments, useViewZones, type CommentActions, type ZoneSpec } from './Comments'
import { Loading } from './Loading'

const api = window.prway

const MAX_MATCHES = 200

export interface CodeOpenRequest {
  path: string
  line: number | null
  seq: number
}

interface Props {
  repo: string
  number: number
  headSha: string
  /** Files the PR changed. */
  changed: ChangedFile[]
  dark: boolean
  nav: NavHandlers
  /** Opens a file (from go to definition, the Context tab, the guide…). */
  request: CodeOpenRequest | null
  /** Shows a changed file's diff in the review. */
  onViewDiff: (path: string, line: number | null) => void
  /** Set when a link from the review opened the code view: returns to where you were. */
  onBack?: () => void
  comments?: CodeComments
}

/** Your pending comments, to write and show them on changed files. */
export interface CodeComments {
  drafts: DraftComment[]
  actions: Omit<CommentActions, 'onAddDraft' | 'onCancelCompose'>
  onCreateDraft: (d: Omit<DraftComment, 'id' | 'headSha'>) => void
}

/** Greedy subsequence match of `q` in `text`: a score (consecutive characters count more), or null. */
function subsequence(text: string, q: string): number | null {
  let score = 0
  let at = -1
  for (const ch of q) {
    const i = text.indexOf(ch, at + 1)
    if (i < 0) return null
    score += i === at + 1 ? 5 : 1
    at = i
  }
  return score
}

/** Quick-open score: a match inside the file name beats one spread over the folders; shorter paths win ties. */
function fuzzyScore(path: string, query: string): number | null {
  const p = path.toLowerCase()
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const name = p.slice(p.lastIndexOf('/') + 1)
  const penalty = p.length / 10 + (/(^|\/)(test|tests|spec|__tests__)\//.test(p) ? 2 : 0)
  if (name.includes(q)) return 3000 - (name.startsWith(q) ? 0 : 100) - penalty
  const inName = subsequence(name, q)
  if (inName !== null) return 2000 + inName - penalty
  if (p.includes(q)) return 1000 - penalty
  const inPath = subsequence(p, q)
  return inPath === null ? null : inPath - penalty
}

/** Last open request handled per PR. */
const handledRequests = new Map<string, number>()

const STATUS_LABEL: Record<string, string> = { A: 'added', M: 'modified', R: 'renamed', C: 'copied', T: 'type changed', D: 'deleted' }

export function CodeBrowser({ repo, number, headSha, changed, dark, nav, request, onViewDiff, onBack, comments }: Props) {
  const prKey = `${repo}#${number}`
  const rootRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<string[] | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [onlyChanged, setOnlyChanged] = useStored('ui.code.onlyChanged', false)
  const [expanded, setExpanded] = useStored<string[]>(`codeTree:${prKey}`, [])
  const [tabs, setTabs] = useStored<string[]>(`codeTabs:${prKey}`, [])
  const [active, setActive] = useStored<string | null>(`codeActive:${prKey}`, null)

  const changedByPath = useMemo(() => new Map(changed.map((f) => [f.path, f])), [changed])

  useEffect(() => {
    let current = true
    setListError(null)
    api.code.listFiles(repo, number).then(
      (f) => current && setFiles(f),
      (err) => current && setListError(errorText(err))
    )
    return () => {
      current = false
    }
  }, [repo, number, headSha])

  // ---- Opening files ----

  const [pendingLine, setPendingLine] = useState<{ path: string; line: number; seq: number } | null>(null)
  const seq = useRef(0)

  function open(path: string, line: number | null = null) {
    if (!tabs.includes(path)) setTabs([...tabs, path].slice(-20))
    setActive(path)
    // Show the file in the tree.
    const parents = path.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))
    if (parents.some((p) => !expanded.includes(p))) setExpanded([...new Set([...expanded, ...parents])])
    if (line) setPendingLine({ path, line, seq: ++seq.current })
  }

  useEffect(() => {
    // Only new requests: coming back to the code view must not replay the last one.
    if (!request || handledRequests.get(prKey) === request.seq) return
    handledRequests.set(prKey, request.seq)
    open(request.path, request.line)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq])

  function close(path: string) {
    const i = tabs.indexOf(path)
    const next = tabs.filter((t) => t !== path)
    setTabs(next)
    if (active === path) setActive(next[Math.min(i, next.length - 1)] ?? null)
  }

  // Keep the open file visible in the tree (after go to definition, quick open…).
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      rootRef.current?.querySelector('.code-tree-body .tree-row.selected')?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(id)
  }, [active, expanded])

  // ⌘/Ctrl+P: quick open (only in the visible PR tab, and only in this view).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current?.offsetParent) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        filterRef.current?.focus()
        filterRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ---- Tree ----

  const visible = useMemo(() => {
    if (!files) return null
    if (!onlyChanged) return files
    const set = new Set(files)
    return changed.map((f) => f.path).filter((p) => set.has(p))
  }, [files, onlyChanged, changed])
  const tree = useMemo(() => (visible ? buildTree(visible) : null), [visible])
  const dirsWithChanges = useMemo(() => {
    const s = new Set<string>()
    for (const f of changed) {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'))
    }
    return s
  }, [changed])
  const matches = useMemo(() => {
    if (!filter.trim() || !visible) return null
    return visible
      .map((p) => ({ p, s: fuzzyScore(p, filter) }))
      .filter((m): m is { p: string; s: number } => m.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, MAX_MATCHES)
      .map((m) => m.p)
  }, [filter, visible])
  const [cursor, setCursor] = useState(0)
  useEffect(() => setCursor(0), [filter])

  const expandedSet = useMemo(() => new Set(expanded), [expanded])
  function toggle(path: string) {
    setExpanded(expandedSet.has(path) ? expanded.filter((p) => p !== path) : [...expanded, path])
  }

  function fileRow(path: string, depth: number, showDir = false) {
    const c = changedByPath.get(path)
    const name = path.split('/').pop()
    return (
      <li key={path}>
        <button
          className={`tree-row ${active === path ? 'selected' : ''}`}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => open(path)}
          title={path}
        >
          <span className="tree-twisty" />
          <span className={`tree-name ${c ? `changed status-${c.status}` : ''}`}>{name}</span>
          {showDir && <span className="tree-dir muted ellipsis">{path.split('/').slice(0, -1).join('/')}</span>}
          {c && (
            <span className={`tree-status status-${c.status}`} title={STATUS_LABEL[c.status] ?? c.status}>
              {c.status}
            </span>
          )}
        </button>
      </li>
    )
  }

  function dirRows(d: Dir, depth: number): React.ReactNode[] {
    const rows: React.ReactNode[] = []
    for (const raw of d.dirs) {
      const sub = compact(raw)
      const isOpen = expandedSet.has(sub.path) || onlyChanged
      rows.push(
        <li key={`d:${sub.path}`}>
          <button className="tree-row" style={{ paddingLeft: 10 + depth * 12 }} onClick={() => toggle(sub.path)} title={sub.path}>
            <span className="tree-twisty">{isOpen ? '▾' : '▸'}</span>
            <span className="tree-name dir">{sub.name}</span>
            {dirsWithChanges.has(sub.path) && <span className="tree-dot" title="Has files changed by this PR" />}
          </button>
        </li>
      )
      if (isOpen) rows.push(...dirRows(sub, depth + 1))
    }
    for (const f of d.files) rows.push(fileRow(f, depth))
    return rows
  }

  const activeChange = active ? changedByPath.get(active) : undefined

  return (
    <div className="code-browser" ref={rootRef}>
      <div className="code-tree">
        <div className="code-tree-head">
          <input
            ref={filterRef}
            className="code-filter"
            placeholder="Go to file…  ⌘P"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (!matches) return
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor(Math.min(cursor + 1, matches.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor(Math.max(cursor - 1, 0))
              } else if (e.key === 'Enter' && matches[cursor]) {
                open(matches[cursor])
                setFilter('')
              } else if (e.key === 'Escape') setFilter('')
            }}
          />
          <label className="small muted nowrap" title="Show only the files this PR changed">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Changed ({changed.length})
          </label>
        </div>
        <div className="code-tree-body">
          {listError && <p className="small error pad">{listError}</p>}
          {!files && !listError && <p className="small pad">
              <Loading>Loading files…</Loading>
            </p>}
          {matches ? (
            <ul>
              {matches.length === 0 && <li className="small muted pad">No file matches.</li>}
              {matches.map((p, i) => (
                <div key={p} className={i === cursor ? 'tree-cursor' : ''} onMouseDown={() => setFilter('')}>
                  {fileRow(p, 0, true)}
                </div>
              ))}
            </ul>
          ) : (
            tree && <ul>{dirRows(tree, 0)}</ul>
          )}
        </div>
        {files && <div className="code-tree-foot small muted">{files.length.toLocaleString()} files at {headSha.slice(0, 7)}</div>}
      </div>

      <div className="code-main">
        <div className="code-tabs">
          {tabs.map((t) => {
            const c = changedByPath.get(t)
            return (
              <div key={t} className={`code-tab ${t === active ? 'active' : ''}`} title={t}>
                <button className="code-tab-name" onClick={() => setActive(t)} onAuxClick={(e) => e.button === 1 && close(t)}>
                  <span className={c ? `changed status-${c.status}` : ''}>{t.split('/').pop()}</span>
                </button>
                <button className="code-tab-close" title="Close" onClick={() => close(t)}>
                  ×
                </button>
              </div>
            )
          })}
        </div>
        {active ? (
          <>
            <div className="diff-toolbar small">
              {onBack && (
                <button className="icon" title="Back to where you were in the review" onClick={onBack}>
                  ← Back to review
                </button>
              )}
              <span className="file-path" title={active}>
                {active}
              </span>
              {activeChange ? (
                <>
                  <span className={`tag status-${activeChange.status}`}>{STATUS_LABEL[activeChange.status] ?? 'changed'} in this PR</span>
                  <button className="link" onClick={() => onViewDiff(active, null)}>
                    View diff
                  </button>
                </>
              ) : (
                <span className="tag">not changed in this PR</span>
              )}
              <span
                className="muted hint"
                title="Read-only, at the PR head. ⌘/Ctrl+click or F12: go to definition. Shift+F12: references. Lines changed by the PR are marked in the gutter."
              >
                ⓘ
              </span>
            </div>
            <CodeEditor
              repo={repo}
              number={number}
              headSha={headSha}
              path={active}
              changed={!!activeChange}
              line={pendingLine?.path === active ? pendingLine : null}
              dark={dark}
              nav={nav}
              onViewDiff={activeChange ? (l) => onViewDiff(active, l) : undefined}
              comments={activeChange && activeChange.status !== 'D' ? comments : undefined}
            />
          </>
        ) : (
          <div className="center muted small code-empty">
            <p>Pick a file in the tree, or press ⌘P to find one.</p>
            <p>Files are shown as they are at the PR head. Go to definition (⌘/Ctrl+click, F12) opens in a new tab.</p>
          </div>
        )}
      </div>
    </div>
  )
}

/** Scroll position and cursor per file ("<sha>:<path>"), kept across tab switches and leaving the code view. */
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>()

/** One editor for every tab: each file keeps its own model and its scroll position and cursor. */
function CodeEditor({
  repo,
  number,
  headSha,
  path,
  changed,
  line,
  dark,
  nav,
  onViewDiff,
  comments
}: {
  repo: string
  number: number
  headSha: string
  path: string
  changed: boolean
  line: { line: number; seq: number } | null
  dark: boolean
  nav: NavHandlers
  /** For files the PR changed: opens the diff at a line. */
  onViewDiff?: (line: number) => void
  /** For files the PR changed: comment on any line (outside the diff it goes as a file comment). */
  comments?: CodeComments
}) {
  const texts = useRef(new Map<string, { text: string; changedLines: number[]; commentable: Set<number> } | { note: string }>())
  const [, setLoaded] = useState(0)
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const navRef = useRef(nav)
  navRef.current = nav
  const key = `${headSha}:${path}`

  useEffect(() => {
    texts.current.clear()
    setLoaded((n) => n + 1)
  }, [headSha])

  useEffect(() => {
    if (texts.current.has(key)) return
    let current = true
    const none = Promise.resolve([] as number[])
    Promise.all([
      api.code.readFile(repo, number, path),
      changed ? api.code.changedLines(repo, number, path) : none,
      changed ? api.code.commentableLines(repo, number, path).catch(() => [] as number[]) : none
    ]).then(
      ([f, lines, commentable]) => {
        if (!current) return
        texts.current.set(
          key,
          f.skipped
            ? { note: f.skipped === 'binary' ? 'Binary file, not shown.' : 'File is too large to show.' }
            : { text: f.text, changedLines: lines, commentable: new Set(commentable) }
        )
        setLoaded((n) => n + 1)
      },
      (err) => {
        if (!current) return
        texts.current.set(key, { note: errorText(err) })
        setLoaded((n) => n + 1)
      }
    )
    return () => {
      current = false
    }
  }, [repo, number, path, key, changed])

  useEffect(() => {
    if (!editor) return
    const ds = [attachCodeNav(editor, () => navRef.current), attachLineMenu(editor, setLineMenu)]
    return () => ds.forEach((d) => d.dispose())
  }, [editor])

  const [lineMenu, setLineMenu] = useState<LineMenuAt | null>(null)
  const closeLineMenu = useCallback(() => setLineMenu(null), [])
  useEffect(() => setLineMenu(null), [key])

  const entry = texts.current.get(key)
  const ready = entry && 'text' in entry ? entry : null

  // ---- Comments: your drafts on this file (new side) and the box to write one ----
  const [composing, setComposing] = useState<{ line: number; startLine?: number; outside: boolean } | null>(null)
  useEffect(() => setComposing(null), [key])
  const commentsRef = useRef(comments)
  commentsRef.current = comments
  const drafts = useMemo(() => (comments?.drafts ?? []).filter((d) => d.path === path && d.side === 'RIGHT'), [comments?.drafts, path])
  const zones: ZoneSpec[] = useMemo(() => {
    if (!comments || !ready) return []
    const lines = new Set([...drafts.map((d) => d.line), ...(composing ? [composing.line] : [])])
    return [...lines].map((l) => {
      const compose = composing?.line === l ? composing : null
      return {
        key: `draft:${l}`,
        line: l,
        node: (
          <LineComments
            threads={[]}
            drafts={drafts.filter((d) => d.line === l)}
            composing={compose}
            headSha={headSha}
            actions={{
              onReply: (t, b) => commentsRef.current!.actions.onReply(t, b),
              onResolve: (t, r) => commentsRef.current!.actions.onResolve(t, r),
              onSaveDraft: (d) => commentsRef.current?.actions.onSaveDraft(d),
              onDeleteDraft: (id) => commentsRef.current?.actions.onDeleteDraft(id),
              onOpenUrl: (u) => commentsRef.current?.actions.onOpenUrl(u),
              onCodeRef: (p, ln) => commentsRef.current?.actions.onCodeRef(p, ln),
              onCancelCompose: () => setComposing(null),
              onAddDraft: (body) => {
                commentsRef.current?.onCreateDraft({
                  path,
                  side: 'RIGHT',
                  line: l,
                  startLine: compose?.startLine,
                  body,
                  ...(compose?.outside ? { outside: true } : {})
                })
                setComposing(null)
              }
            }}
          />
        )
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, composing, ready, headSha, path, !!comments, dark])
  useViewZones(editor, zones)
  // The editor keeps the last loaded file until the next one is ready (never an empty model for a path).
  const shown = useRef<{ path: string; text: string } | null>(null)
  if (ready) shown.current = { path, text: ready.text }

  // Lines changed by the PR: a bar in the gutter and marks in the scrollbar.
  useEffect(() => {
    if (!editor || !ready) return
    const deco = editor.createDecorationsCollection(
      ready.changedLines.map((l) => ({
        range: new monaco.Range(l, 1, l, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: 'code-changed-gutter',
          overviewRuler: { color: 'rgba(46, 160, 67, 0.7)', position: monaco.editor.OverviewRulerLane.Left }
        }
      }))
    )
    return () => deco.clear()
  }, [editor, ready])

  // Save the view state of the file shown; restore it when a file comes back. Saving waits for the restore, so the
  // model swap (which scrolls to the top first) doesn't overwrite what was saved.
  const restoredKey = useRef<string | null>(null)
  const handledLine = useRef(0)
  useEffect(() => {
    if (!editor) return
    const save = () => {
      const k = restoredKey.current
      if (!k) return
      const sep = k.indexOf(':')
      if (!editor.getModel()?.uri.path.endsWith(`code/${k.slice(0, sep)}/${k.slice(sep + 1)}`)) return
      const v = editor.saveViewState()
      if (v) viewStates.set(k, v)
    }
    const subs = [editor.onDidScrollChange(save), editor.onDidChangeCursorPosition(save)]
    return () => subs.forEach((d) => d.dispose())
  }, [editor])
  useEffect(() => {
    if (!editor || !ready) return
    restoredKey.current = null
    const pendingLine = line && handledLine.current !== line.seq
    const saved = viewStates.get(key)
    if (!pendingLine && saved) editor.restoreViewState(saved)
    restoredKey.current = key
  }, [editor, ready, key])

  // Jump to a line when asked (go to definition, a link…), once the file is shown.
  useEffect(() => {
    if (!editor || !ready || !line || handledLine.current === line.seq) return
    handledLine.current = line.seq
    const id = requestAnimationFrame(() => {
      editor.revealLineInCenter(line.line)
      editor.setPosition({ lineNumber: line.line, column: 1 })
      const deco = editor.createDecorationsCollection([
        { range: new monaco.Range(line.line, 1, line.line, 1), options: { isWholeLine: true, className: 'nav-target-line' } }
      ])
      setTimeout(() => deco.clear(), 1500)
    })
    return () => cancelAnimationFrame(id)
  }, [editor, ready, line?.seq])

  function lineMenuItems(m: LineMenuAt) {
    const changedHere = ready?.changedLines.find((l) => l >= m.start && l <= m.end)
    return [
      ...(comments && ready
        ? [
            {
              label: m.start === m.end ? 'Comment on this line' : 'Comment on these lines',
              run: () => {
                const inDiff = ready.commentable.has(m.end) && (m.start === m.end || ready.commentable.has(m.start))
                setComposing({ line: m.end, startLine: m.start < m.end ? m.start : undefined, outside: !inDiff })
              }
            }
          ]
        : []),
      {
        label: 'Ask in Chat',
        hint: '⌘L',
        run: () => {
          const ref = editor && linesRef(editor, m.start, m.end)
          if (ref) navRef.current.onAskChat?.(ref)
        }
      },
      ...(onViewDiff
        ? [
            {
              label: 'View diff',
              disabledReason: changedHere ? undefined : 'These lines are not changed in this PR',
              run: () => onViewDiff(changedHere ?? m.start)
            }
          ]
        : []),
      { label: 'Copy reference', run: () => copyReference(path, m.start, m.end) }
    ]
  }

  return (
    <div className="editor-area">
      {lineMenu && <LineMenu at={lineMenu} items={lineMenuItems(lineMenu)} onClose={closeLineMenu} />}
      {entry && 'note' in entry && <div className="center muted">{entry.note}</div>}
      {!entry && <div className="center">
          <Loading>Loading {path}…</Loading>
        </div>}
      {/* Kept mounted while another file loads, so switching tabs doesn't rebuild the editor. */}
      <div className="editor-host" hidden={!ready}>
        {shown.current && (
          <Editor
            value={shown.current.text}
            language={languageFor(shown.current.path)}
            path={`code/${headSha}/${shown.current.path}`}
            theme={dark ? 'prway-dark' : 'prway-light'}
            onMount={(ed) => setEditor(ed)}
            saveViewState={false}
            options={{
              readOnly: true,
              automaticLayout: true,
              minimap: { enabled: true, renderCharacters: false },
              scrollBeyondLastLine: false,
              fontFamily: MONO_FONT,
              fontSize: 12.5,
              lineHeight: 19,
              fontLigatures: false,
              lineDecorationsWidth: 6
            }}
          />
        )}
      </div>
    </div>
  )
}
