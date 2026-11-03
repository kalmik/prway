import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangedFile,
  ChatMessage,
  DiffSide,
  DraftComment,
  FileDiff,
  GuideFile,
  PullDetail,
  ReviewGuide,
  ReviewThread,
  WorktreeInfo
} from '../../../shared/types'
import { errorText, storage } from '../util'
import { ChatBar, ChatLog } from './ChatPanel'
import type { NavRequest } from './codeNav'
import { ContextPanel, type NavResults } from './ContextPanel'
import { DiffPane, type RevealRequest } from './DiffPane'
import { FileList } from './FileList'
import { FileViewer } from './FileViewer'
import { GuidePanel } from './GuidePanel'
import { KnowledgePanel } from './KnowledgePanel'
import { ReviewBox } from './ReviewBox'

const api = window.prway

type Tab = 'guide' | 'context' | 'knowledge' | 'chat'

/** Where the reviewer was, for the Back button after jumping to a definition. */
interface Place {
  path: string
  line: number
  /** True for a file the PR did not change (shown read-only). */
  outside: boolean
}

function usePrefersDark(): boolean {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const onChange = () => setDark(m.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])
  return dark
}

/** State that survives restarts (localStorage), per key. */
function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => storage.get(key, initial))
  const set = useCallback(
    (v: T) => {
      setValue(v)
      storage.set(key, v)
    },
    [key]
  )
  return [value, set]
}

export function PrView({ repo, number }: { repo: string; number: number }) {
  const prKey = `${repo}#${number}`
  const [pull, setPull] = useState<PullDetail | null>(null)
  const [tree, setTree] = useState<WorktreeInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<ChangedFile | null>(null)
  // The diff is stored with its path so a new file never renders with the previous file's contents.
  const [loadedDiff, setLoadedDiff] = useState<{ path: string; diff: FileDiff } | null>(null)
  const diff = loadedDiff && loadedDiff.path === file?.path ? loadedDiff.diff : null
  const [outside, setOutside] = useState<{ path: string; line: number } | null>(null)
  const [backStack, setBackStack] = useState<Place[]>([])
  const [reveal, setReveal] = useState<RevealRequest | null>(null)
  const revealSeq = useRef(0)
  const lastLine = useRef(1)

  const [guide, setGuide] = useState<ReviewGuide | null>(null)
  const [guideBusy, setGuideBusy] = useState(false)
  const [guideError, setGuideError] = useState<string | null>(null)

  const [threads, setThreads] = useState<ReviewThread[]>([])
  const [threadsError, setThreadsError] = useState<string | null>(null)
  const [drafts, setDrafts] = useStored<DraftComment[]>(`drafts:${prKey}`, [])

  const [nav, setNav] = useState<NavResults | null>(null)
  const [tab, setTab] = useStored<Tab>('ui.panelTab', 'guide')
  const [panelOpen, setPanelOpen] = useStored('ui.panelOpen', true)
  const [panelHeight, setPanelHeight] = useStored('ui.panelHeight', 300)

  const [chatLog, setChatLog] = useStored<ChatMessage[]>(`chat:${prKey}`, [])
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)

  const [sideBySide, setSideBySide] = useStored('ui.sideBySide', true)
  const [hideWhitespace, setHideWhitespace] = useStored('ui.hideWhitespace', true)
  const dark = usePrefersDark()

  // "Viewed" marks are tied to the PR head commit: new commits reset them.
  const viewedKey = tree ? `viewed:${prKey}@${tree.headSha}` : null
  const [viewed, setViewed] = useState<Set<string>>(new Set())

  const loadThreads = useCallback(() => {
    api.pulls.threads(repo, number).then(
      (t) => {
        setThreads(t)
        setThreadsError(null)
      },
      (err) => setThreadsError(errorText(err))
    )
  }, [repo, number])

  useEffect(() => {
    api.pulls.get(repo, number).then(setPull, (err) => setError(errorText(err)))
    api.worktree.prepare(repo, number).then(
      async (t) => {
        setTree(t)
        const saved = await api.guide.get(repo, number)
        setGuide(saved)
        // Start with the first file of the reading order, else the first file that isn't noise.
        const first = saved?.files[0]?.path
        setFile(t.files.find((f) => f.path === first) ?? t.files.find((f) => !f.noise) ?? t.files[0] ?? null)
      },
      (err) => setError(errorText(err))
    )
    loadThreads()
  }, [repo, number, loadThreads])

  useEffect(() => {
    if (viewedKey) setViewed(new Set(storage.get<string[]>(viewedKey, [])))
  }, [viewedKey])

  useEffect(() => {
    if (!file) return
    let current = true
    api.worktree.fileDiff(repo, number, file).then(
      (d) => current && setLoadedDiff({ path: file.path, diff: d }),
      (err) => current && setError(errorText(err))
    )
    return () => {
      current = false
    }
  }, [repo, number, file])

  const guideFile: GuideFile | undefined = useMemo(() => guide?.files.find((g) => g.path === file?.path), [guide, file])

  function toggleViewed(path: string) {
    const next = new Set(viewed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setViewed(next)
    if (viewedKey) storage.set(viewedKey, [...next])
  }

  // ---- Navigation ----

  const here = (): Place | null =>
    outside ? { path: outside.path, line: outside.line, outside: true } : file ? { path: file.path, line: lastLine.current, outside: false } : null

  /** Opens a file at a line: in the diff when the PR changed it, else read-only. */
  function openAt(path: string, line: number | null, side: DiffSide = 'RIGHT', remember = true) {
    const current = here()
    if (remember && current && (current.path !== path || current.line !== line)) setBackStack((s) => [...s.slice(-30), current])
    const target = tree?.files.find((f) => f.path === path)
    if (target) {
      setOutside(null)
      if (target.path !== file?.path) setFile(target)
      if (line) {
        lastLine.current = line
        setReveal({ path, line, side, seq: ++revealSeq.current })
      }
    } else {
      setOutside({ path, line: line ?? 1 })
    }
  }

  function back() {
    const prev = backStack.at(-1)
    if (!prev) return
    setBackStack((s) => s.slice(0, -1))
    if (prev.outside) setOutside({ path: prev.path, line: prev.line })
    else openAt(prev.path, prev.line, 'RIGHT', false)
  }

  async function goToDefinition({ word, qualifier }: NavRequest) {
    setNav({ kind: 'def', word, locations: null })
    try {
      const locations = await api.code.definitions(repo, number, word, qualifier)
      setNav({ kind: 'def', word, locations })
      if (locations.length === 1) openAt(locations[0].path, locations[0].line)
      else showTab('context')
    } catch (err) {
      setNav({ kind: 'def', word, locations: [], error: errorText(err) })
      showTab('context')
    }
  }

  async function findReferences({ word }: NavRequest) {
    setNav({ kind: 'refs', word, locations: null })
    showTab('context')
    try {
      const r = await api.code.references(repo, number, word)
      setNav({ kind: 'refs', word, locations: r.locations, truncated: r.truncated })
    } catch (err) {
      setNav({ kind: 'refs', word, locations: [], error: errorText(err) })
    }
  }

  const navHandlers = { onDefinition: goToDefinition, onReferences: findReferences }

  function showTab(t: Tab) {
    setTab(t)
    setPanelOpen(true)
  }

  // ---- Guide ----

  async function generateGuide() {
    setGuideBusy(true)
    setGuideError(null)
    try {
      const g = await api.guide.generate(repo, number)
      setGuide(g)
      // The worktree was refreshed; pick up new commits if any.
      if (tree && g.headSha !== tree.headSha) setTree(await api.worktree.prepare(repo, number))
    } catch (err) {
      setGuideError(errorText(err))
    } finally {
      setGuideBusy(false)
    }
  }

  // ---- Comments ----

  const fileThreads = useMemo(() => threads.filter((t) => t.path === file?.path), [threads, file])
  const fileDrafts = useMemo(() => drafts.filter((d) => d.path === file?.path), [drafts, file])
  const commentCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of threads) if (!t.resolved) m.set(t.path, (m.get(t.path) ?? 0) + 1)
    for (const d of drafts) m.set(d.path, (m.get(d.path) ?? 0) + 1)
    return m
  }, [threads, drafts])

  const commentActions = {
    onReply: async (thread: ReviewThread, body: string) => {
      const c = await api.pulls.reply(repo, number, thread.comments[0].id, body)
      setThreads((ts) => ts.map((t) => (t.id === thread.id ? { ...t, comments: [...t.comments, c] } : t)))
    },
    onResolve: async (thread: ReviewThread, resolved: boolean) => {
      try {
        await api.pulls.setResolved(thread.id, resolved)
        setThreads((ts) => ts.map((t) => (t.id === thread.id ? { ...t, resolved } : t)))
      } catch (err) {
        setError(errorText(err))
      }
    },
    onCreateDraft: (d: Omit<DraftComment, 'id' | 'headSha'>) => {
      if (!tree) return
      setDrafts([...drafts, { ...d, id: crypto.randomUUID(), headSha: tree.headSha }])
    },
    onSaveDraft: (d: DraftComment) => setDrafts(drafts.map((x) => (x.id === d.id ? d : x))),
    onDeleteDraft: (id: string) => setDrafts(drafts.filter((x) => x.id !== id)),
    onOpenUrl: (url: string) => void api.openExternal(url),
    onCodeRef: (path: string, line: number) => openAt(path, line)
  }

  // ---- Chat ----

  async function ask(text: string) {
    const messages: ChatMessage[] = [...chatLog, { role: 'user', text }]
    setChatLog(messages)
    setChatError(null)
    showTab('chat')
    setChatBusy(true)
    try {
      const answer = await api.chat.send(repo, number, messages)
      setChatLog([...messages, answer])
    } catch (err) {
      setChatError(errorText(err))
    } finally {
      setChatBusy(false)
    }
  }

  // ---- Bottom panel resize ----

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startY = e.clientY
    const startH = panelHeight
    let h = startH
    const move = (ev: MouseEvent) => {
      h = Math.max(140, Math.min(window.innerHeight - 220, startH + startY - ev.clientY))
      setPanelHeightLive(h)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setPanelHeight(h)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const [panelHeightLive, setPanelHeightLive] = useState(panelHeight)
  useEffect(() => setPanelHeightLive(panelHeight), [panelHeight])

  const stale = !!guide && !!tree && guide.headSha !== tree.headSha
  const openThreads = threads.filter((t) => !t.resolved).length

  return (
    <div className="pr-view">
      <div className="pr-header">
        <div className="pr-heading">
          <h2>
            {pull?.title ?? 'Loading…'} <span className="muted">#{number}</span>
          </h2>
          {pull && (
            <p className="small muted">
              {pull.author} wants to merge <code>{pull.headRef}</code> into <code>{pull.baseRef}</code> ·{' '}
              <span className="add">+{pull.additions}</span> <span className="del">−{pull.deletions}</span> · {pull.changedFiles} files
              {openThreads > 0 && ` · ${openThreads} open thread${openThreads > 1 ? 's' : ''}`}
            </p>
          )}
        </div>
        <div className="row nowrap">
          {pull && <button onClick={() => api.openExternal(pull.url)}>GitHub ↗</button>}
          <button disabled={!tree} onClick={() => api.worktree.reveal(repo, number).catch((e) => setError(errorText(e)))}>
            Worktree folder
          </button>
        </div>
      </div>

      {error && (
        <p className="error pad">
          {error}{' '}
          <button className="link" onClick={() => setError(null)}>
            dismiss
          </button>
        </p>
      )}

      {!tree && !error && <div className="center muted">Preparing worktree… (the first PR of a repo needs a clone, which can take a while)</div>}

      {tree && (
        <div className="review-area">
          <div className="files">
            <FileList
              files={tree.files}
              guide={guide}
              selected={outside ? null : file}
              viewed={viewed}
              commentCounts={commentCounts}
              onSelect={(f) => {
                setOutside(null)
                setFile(f)
              }}
              onToggleViewed={toggleViewed}
            />
            {threadsError && <p className="small error pad">Comments: {threadsError}</p>}
            {pull && (
              <ReviewBox
                repo={repo}
                number={number}
                drafts={drafts}
                headSha={tree.headSha}
                onSubmitted={() => {
                  setDrafts([])
                  loadThreads()
                }}
              />
            )}
          </div>

          <div className="center-col">
            <div className="diff-toolbar small">
              {backStack.length > 0 && (
                <button className="icon" title="Back to where you were" onClick={back}>
                  ← Back
                </button>
              )}
              <span className="file-path" title={outside?.path ?? file?.path}>
                {outside ? (
                  <>
                    {outside.path} <span className="tag">not changed in this PR</span>
                  </>
                ) : (
                  <>
                    {file?.oldPath ? `${file.oldPath} → ` : ''}
                    {file?.path}
                  </>
                )}
              </span>
              {!outside && (
                <>
                  <label>
                    <input type="checkbox" checked={sideBySide} onChange={(e) => setSideBySide(e.target.checked)} /> Side by side
                  </label>
                  <label>
                    <input type="checkbox" checked={hideWhitespace} onChange={(e) => setHideWhitespace(e.target.checked)} /> Hide
                    whitespace
                  </label>
                </>
              )}
              <span className="muted hint" title="Click a line number to comment. Select several lines first for a range. ⌘/Ctrl+click or F12: go to definition. Shift+F12: references.">
                ⓘ
              </span>
            </div>

            {!outside && file?.noise && <div className="file-note noise-note small">Skippable: {file.noise.reason}</div>}
            {!outside && guideFile && (
              <div className={`file-note small risk-${guideFile.risk}`}>
                <strong>{guideFile.risk} risk</strong> · {guideFile.role} — {guideFile.why}
                {guideFile.focus.length > 0 && (
                  <span className="focus-links">
                    {guideFile.focus.map((f) => (
                      <button key={f.line} className="link" title={f.note} onClick={() => openAt(guideFile.path, f.line)}>
                        L{f.line}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            )}

            <div className="editor-area">
              {outside ? (
                <FileViewer
                  repo={repo}
                  number={number}
                  headSha={tree.headSha}
                  path={outside.path}
                  line={outside.line}
                  dark={dark}
                  nav={navHandlers}
                />
              ) : (
                <>
                  {!file && <div className="center muted">This PR has no file changes.</div>}
                  {file && !diff && <div className="center muted">Loading file…</div>}
                  {diff?.skipped && (
                    <div className="center muted">{diff.skipped === 'binary' ? 'Binary file, not shown.' : 'File is too large to show.'}</div>
                  )}
                  {file && diff && !diff.skipped && (
                    <DiffPane
                      file={file}
                      diff={diff}
                      tree={tree}
                      guideFile={guideFile}
                      threads={fileThreads}
                      drafts={fileDrafts}
                      sideBySide={sideBySide}
                      hideWhitespace={hideWhitespace}
                      dark={dark}
                      reveal={reveal}
                      nav={navHandlers}
                      actions={commentActions}
                    />
                  )}
                </>
              )}
            </div>

            <div className={`panel ${panelOpen ? 'open' : ''}`} style={panelOpen ? { height: panelHeightLive } : undefined}>
              {panelOpen && <div className="panel-resizer" onMouseDown={startResize} title="Drag to resize" />}
              <div className="panel-tabs">
                {(
                  [
                    ['guide', `Guide${stale ? ' •' : ''}`],
                    ['context', 'Context'],
                    ['knowledge', 'Knowledge'],
                    ['chat', `Chat${chatLog.length ? ` (${chatLog.filter((m) => m.role === 'user').length})` : ''}`]
                  ] as [Tab, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={tab === id && panelOpen ? 'active' : ''}
                    onClick={() => (tab === id && panelOpen ? setPanelOpen(false) : showTab(id))}
                  >
                    {label}
                  </button>
                ))}
                <span className="spacer" />
                <button className="icon" title={panelOpen ? 'Collapse panel' : 'Expand panel'} onClick={() => setPanelOpen(!panelOpen)}>
                  {panelOpen ? '▾' : '▴'}
                </button>
              </div>
              {panelOpen && (
                <div className="panel-content">
                  {tab === 'guide' && (
                    <GuidePanel
                      guide={guide}
                      stale={stale}
                      busy={guideBusy}
                      error={guideError}
                      onGenerate={generateGuide}
                      onGoTo={(p, l) => openAt(p, l)}
                    />
                  )}
                  {tab === 'context' && (
                    <ContextPanel
                      repo={repo}
                      number={number}
                      path={outside ? null : (file?.path ?? null)}
                      headSha={tree.headSha}
                      nav={nav}
                      onClearNav={() => setNav(null)}
                      onOpen={(p, l) => openAt(p, l)}
                      onOpenUrl={(u) => void api.openExternal(u)}
                    />
                  )}
                  {tab === 'knowledge' && (
                    <KnowledgePanel
                      repo={repo}
                      number={number}
                      headSha={tree.headSha}
                      onOpen={(p, l) => openAt(p, l)}
                      onOpenUrl={(u) => void api.openExternal(u)}
                    />
                  )}
                  {tab === 'chat' && (
                    <ChatLog
                      messages={chatLog}
                      busy={chatBusy}
                      error={chatError}
                      onCodeRef={(p, l) => openAt(p, l)}
                      onOpenUrl={(u) => void api.openExternal(u)}
                      onClear={() => setChatLog([])}
                      onAsk={ask}
                    />
                  )}
                </div>
              )}
              <ChatBar busy={chatBusy} onSend={ask} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
