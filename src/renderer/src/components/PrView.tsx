import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChangedFile,
  ConversationItem,
  ChatMessage,
  DiffSide,
  DraftComment,
  FileDiff,
  Hunk,
  HunkAuto,
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
import { ConversationPanel } from './ConversationPanel'
import { DiffPane, type HunkMark, type RevealRequest } from './DiffPane'
import { FileList } from './FileList'
import { FileViewer } from './FileViewer'
import { GuidePanel } from './GuidePanel'
import { KnowledgePanel } from './KnowledgePanel'
import { ReviewBox } from './ReviewBox'
import { FileStep, FinishStep, OverviewStep, ReviewOutline, type Step } from './Guided'
import { approvalKey, hunkAnchor, ReviewPanel, useWalkthroughs, type ReviewFlow } from './ReviewPanel'

const api = window.prway

/** "Start review" prepares every file's walkthrough up to this many files; bigger PRs get a button. */
const PREPARE_ALL_LIMIT = 15

type Tab = 'review' | 'guide' | 'conversation' | 'context' | 'knowledge' | 'chat'

/** Where the reviewer was, for the Back button after jumping to a definition. */
interface Place {
  path: string
  line: number
  /** True for a file the PR did not change (shown read-only). */
  outside: boolean
}

/**
 * True when a key press is text input: any input, textarea, select or editable element, including the
 * comment boxes shown inside the diff. The only exception is the read-only code view itself, where the
 * review shortcuts should work.
 */
function isTyping(t: HTMLElement | null): boolean {
  if (!t) return false
  if (t.closest('.zone-host, .find-widget, .monaco-inputbox')) return true
  // Monaco's own hidden input: textarea.ime-text-area (0.5x), textarea.inputarea (older), or the EditContext div.
  const monacoInput =
    !!t.closest('.monaco-editor') && ['ime-text-area', 'inputarea', 'native-edit-context'].some((c) => t.classList.contains(c))
  if (monacoInput) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
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

/** State that survives restarts (localStorage), per key. Every open tab using the same key stays in sync. */
function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => storage.get(key, initial))
  useEffect(() => {
    const onChange = (e: Event) => {
      const { key: k, value: v } = (e as CustomEvent<{ key: string; value: T }>).detail
      if (k === key) setValue(v)
    }
    window.addEventListener('prway-stored', onChange)
    return () => window.removeEventListener('prway-stored', onChange)
  }, [key])
  const set = useCallback(
    (v: T) => {
      storage.set(key, v)
      window.dispatchEvent(new CustomEvent('prway-stored', { detail: { key, value: v } }))
    },
    [key]
  )
  return [value, set]
}

/** What the tab bar shows about a PR. */
export interface PrStatus {
  title: string
  /** Pending inline comments not sent yet. */
  drafts: number
}

export function PrView({ repo, number, onStatus }: { repo: string; number: number; onStatus?: (s: PrStatus) => void }) {
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
  const [conversation, setConversation] = useState<ConversationItem[] | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [drafts, setDrafts] = useStored<DraftComment[]>(`drafts:${prKey}`, [])

  const [nav, setNav] = useState<NavResults | null>(null)
  const [tab, setTab] = useStored<Tab>('ui.panelTab', 'guide')
  const [panelOpen, setPanelOpen] = useStored('ui.panelOpen', true)
  const [panelHeight, setPanelHeight] = useStored('ui.panelHeight', 300)
  const [panelWidth, setPanelWidth] = useStored('ui.panelWidth', 420)
  const [panelPosition, setPanelPosition] = useStored<'bottom' | 'right'>('ui.panelPosition', 'bottom')

  const [chatLog, setChatLog] = useStored<ChatMessage[]>(`chat:${prKey}`, [])
  const [chatBusy, setChatBusy] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)

  /** Guided review is the main view; "files" is the classic file list + diff. */
  const [mode, setMode] = useStored<'guided' | 'files'>('ui.viewMode', 'guided')
  const [step, setStep] = useStored<Step>(`step:${prKey}`, 'overview')
  const guided = mode === 'guided'
  const [commentSignal, setCommentSignal] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const [sideBySide, setSideBySide] = useStored('ui.sideBySide', true)
  const [hideWhitespace, setHideWhitespace] = useStored('ui.hideWhitespace', true)
  const dark = usePrefersDark()

  // "Viewed" marks are tied to the PR head commit: new commits reset them.
  const viewedKey = tree ? `viewed:${prKey}@${tree.headSha}` : null
  const [viewed, setViewed] = useState<Set<string>>(new Set())

  /** Reloads inline threads and the conversation from GitHub. */
  const loadThreads = useCallback(() => {
    setRefreshing(true)
    return Promise.all([
      api.pulls.threads(repo, number).then(
        (t) => {
          setThreads(t)
          setThreadsError(null)
        },
        (err) => setThreadsError(errorText(err))
      ),
      api.pulls.conversation(repo, number).then(
        (c) => {
          setConversation(c)
          setConversationError(null)
        },
        (err) => setConversationError(errorText(err))
      )
    ]).finally(() => setRefreshing(false))
  }, [repo, number])

  useEffect(() => {
    api.pulls.get(repo, number).then(setPull, (err) => setError(errorText(err)))
    api.worktree.prepare(repo, number).then(
      async (t) => {
        setTree(t)
        const saved = await api.guide.get(repo, number)
        setGuide(saved)
        // Start where you left off, else the first file of the reading order, else the first file that isn't noise.
        const last = storage.get<string | null>(`file:${prKey}`, null)
        const first = saved?.files[0]?.path
        setFile(
          t.files.find((f) => f.path === last) ??
            t.files.find((f) => f.path === first) ??
            t.files.find((f) => !f.noise) ??
            t.files[0] ??
            null
        )
      },
      (err) => setError(errorText(err))
    )
    loadThreads()
  }, [repo, number, loadThreads])

  useEffect(() => {
    if (viewedKey) setViewed(new Set(storage.get<string[]>(viewedKey, [])))
  }, [viewedKey])

  useEffect(() => {
    if (file) storage.set(`file:${prKey}`, file.path)
  }, [file, prKey])

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

  // ---- Review flow: steps in reading order, hunks, local approvals ----

  const steps = useMemo(() => {
    const files = tree?.files.filter((f) => !f.noise) ?? []
    const order = new Map(guide?.files.map((g, i) => [g.path, i]) ?? [])
    return [...files].sort((a, b) => (order.get(a.path) ?? 1e6) - (order.get(b.path) ?? 1e6))
  }, [tree, guide])
  const guideFiles = useMemo(() => new Map(guide?.files.map((g) => [g.path, g]) ?? []), [guide])
  const [hunks, setHunks] = useState<Record<string, Hunk[]> | null>(null)
  const [currentHunk, setCurrentHunk] = useState<{ path: string; index: number } | null>(null)

  useEffect(() => {
    if (!tree) return
    api.review.hunks(repo, number).then(setHunks, (err) => setError(errorText(err)))
  }, [repo, number, tree])

  // Walkthroughs: the file you are on (and the next one) are explained; saved ones for every file are loaded.
  const reviewing = guided ? step === 'files' : tab === 'review' && panelOpen
  const stepIndex = file && !outside ? steps.findIndex((f) => f.path === file.path) : -1
  const stepPaths = useMemo(() => steps.filter((f) => hunks?.[f.path]?.length).map((f) => f.path), [steps, hunks])
  const wt = useWalkthroughs(
    repo,
    number,
    tree?.headSha ?? '',
    reviewing && stepIndex >= 0 && hunks?.[steps[stepIndex].path]?.length ? steps[stepIndex].path : null,
    reviewing && stepIndex >= 0 ? (steps.slice(stepIndex + 1).find((f) => hunks?.[f.path]?.length)?.path ?? null) : null,
    stepPaths
  )

  // Approvals = the chunks you ticked + the pre-approved ones (rules, AI) you didn't send back for review.
  const [preRules, setPreRules] = useStored('ui.preApproveRules', true)
  const [preAi, setPreAi] = useStored('ui.preApproveAi', true)
  const [manualList, setManualList] = useStored<string[]>(`approved:${prKey}`, [])
  const [overrideList, setOverrideList] = useStored<string[]>(`reviewAuto:${prKey}`, [])
  const manual = useMemo(() => new Set(manualList), [manualList])
  const overrides = useMemo(() => new Set(overrideList), [overrideList])
  const allAutoReasons = useMemo(() => {
    const m = new Map<string, HunkAuto>()
    for (const [p, hs] of Object.entries(hunks ?? {})) {
      for (const h of hs) {
        const key = approvalKey(p, h.hash)
        if (preRules && h.auto) m.set(key, h.auto)
        else if (preAi) {
          const n = wt.walk[p]?.hunks.find((x) => x.hash === h.hash)
          if (n?.trivial) m.set(key, { kind: 'ai', reason: n.trivialReason ? `AI: ${n.trivialReason}` : 'AI: trivial' })
        }
      }
    }
    return m
  }, [hunks, wt.walk, preRules, preAi])
  const autoReasons = useMemo(() => new Map([...allAutoReasons].filter(([k]) => !overrides.has(k))), [allAutoReasons, overrides])
  const approved = useMemo(() => new Set([...manual, ...autoReasons.keys()]), [manual, autoReasons])
  const isAuto = (path: string, h: Hunk) => autoReasons.has(approvalKey(path, h.hash))

  function toggleApprove(path: string, hash: string) {
    const key = approvalKey(path, hash)
    if (approved.has(key)) {
      if (manual.has(key)) setManualList(manualList.filter((k) => k !== key))
      // Unticking a pre-approved chunk sends it back to you.
      if (allAutoReasons.has(key)) setOverrideList([...overrideList, key])
    } else if (allAutoReasons.has(key) && overrides.has(key)) {
      setOverrideList(overrideList.filter((k) => k !== key))
    } else setManualList([...manualList, key])
  }

  function showHunk(path: string, h: Hunk) {
    setCurrentHunk({ path, index: h.index })
    const a = hunkAnchor(h)
    // Stepping through chunks is not a jump you'd want to go "Back" from.
    openAt(path, a.line, a.side, false)
  }

  function goToStep(path: string) {
    const first =
      hunks?.[path]?.find((h) => !approved.has(approvalKey(path, h.hash))) ??
      hunks?.[path]?.find((h) => !isAuto(path, h)) ??
      hunks?.[path]?.[0]
    if (first) showHunk(path, first)
    else openAt(path, null, 'RIGHT', false)
  }

  /** The chunk shown as current: the selected one, else the first not yet approved in the file. */
  function activeHunk(): Hunk | undefined {
    if (!file) return undefined
    const fh = hunks?.[file.path] ?? []
    return (
      fh.find((h) => currentHunk?.path === file.path && h.index === currentHunk.index) ??
      fh.find((h) => !approved.has(approvalKey(file.path, h.hash))) ??
      fh[0]
    )
  }

  /** Moves through chunks across files: within the file first, then the next/previous file in reading order. */
  function moveChunk(delta: 1 | -1) {
    if (!file) return
    // Pre-approved chunks are skipped: they are what you don't need to look at.
    const needs = (p: string) => (hunks?.[p] ?? []).filter((h) => !isAuto(p, h))
    const fh = hunks?.[file.path] ?? []
    const cur = activeHunk()
    const i = cur ? fh.indexOf(cur) : -1
    const ordered = delta === 1 ? fh.slice(i + 1) : fh.slice(0, Math.max(0, i)).reverse()
    const target = ordered.find((h) => !isAuto(file.path, h))
    if (target) return showHunk(file.path, target)
    const si = steps.findIndex((f) => f.path === file.path)
    const others = delta === 1 ? steps.slice(si + 1) : steps.slice(0, Math.max(0, si)).reverse()
    const other = others.find((f) => needs(f.path).length)
    if (!other) {
      if (delta === 1 && guided) setStep('finish')
      return
    }
    const oh = needs(other.path)
    showHunk(other.path, (delta === 1 ? oh[0] : oh.at(-1))!)
  }

  function moveFile(delta: 1 | -1) {
    const si = file ? steps.findIndex((f) => f.path === file.path) : -1
    // Files with nothing left for you (all pre-approved) are skipped.
    const others = delta === 1 ? steps.slice(si + 1) : steps.slice(0, Math.max(0, si)).reverse()
    const other = others.find((f) => (hunks?.[f.path] ?? []).some((h) => !isAuto(f.path, h))) ?? others[0]
    if (other) goToStep(other.path)
    else if (delta === 1 && guided) setStep('finish')
    else if (delta === -1 && guided) setStep('overview')
  }

  function approveAndNext(path: string, h: Hunk) {
    if (!approved.has(approvalKey(path, h.hash))) toggleApprove(path, h.hash)
    const fh = hunks?.[path] ?? []
    const after = fh.find((x) => x.index > h.index && !approved.has(approvalKey(path, x.hash)))
    if (after) return showHunk(path, after)
    // File done: on to the first file in reading order that still has unapproved chunks.
    const si = steps.findIndex((f) => f.path === path)
    const rest = [...steps.slice(si + 1), ...steps.slice(0, Math.max(0, si))]
    const nextFile = rest.find((f) => (hunks?.[f.path] ?? []).some((x) => !(f.path === path && x.hash === h.hash) && !approved.has(approvalKey(f.path, x.hash))))
    if (nextFile) goToStep(nextFile.path)
    else if (guided) setStep('finish')
  }

  // A file whose chunks are all approved counts as viewed.
  useEffect(() => {
    if (!hunks || !viewedKey) return
    const done = Object.entries(hunks).filter(([p, hs]) => hs.length && !viewed.has(p) && hs.every((h) => approved.has(approvalKey(p, h.hash))))
    if (!done.length) return
    const next = new Set(viewed)
    done.forEach(([p]) => next.add(p))
    setViewed(next)
    storage.set(viewedKey, [...next])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approved, hunks])


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
    // In the guided view the diff lives in the "files" step.
    if (guided && step !== 'files') setStep('files')
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

  // ---- Panel resize (height when below the diff, width when on the right) ----

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const right = panelPosition === 'right'
    const start = right ? e.clientX : e.clientY
    const startSize = right ? panelWidth : panelHeight
    let size = startSize
    const move = (ev: MouseEvent) => {
      if (right) {
        size = Math.max(280, Math.min(window.innerWidth - 600, startSize + start - ev.clientX))
        setPanelWidthLive(size)
      } else {
        size = Math.max(140, Math.min(window.innerHeight - 220, startSize + start - ev.clientY))
        setPanelHeightLive(size)
      }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (right) setPanelWidth(size)
      else setPanelHeight(size)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const [panelHeightLive, setPanelHeightLive] = useState(panelHeight)
  const [panelWidthLive, setPanelWidthLive] = useState(panelWidth)
  useEffect(() => setPanelHeightLive(panelHeight), [panelHeight])
  useEffect(() => setPanelWidthLive(panelWidth), [panelWidth])

  // ---- Walkthroughs and the flow handlers shared by the guided view and the Review tab ----

  // Chunks of the open file as the diff shows them; the current one gets a banner and a strong highlight.
  const fileHunkMarks = useMemo((): HunkMark[] => {
    if (!file || !hunks?.[file.path]) return []
    const fh = hunks[file.path]
    const active =
      fh.find((h) => currentHunk?.path === file.path && h.index === currentHunk.index) ??
      ((guided && step === 'files') || (tab === 'review' && panelOpen) ? fh.find((h) => !approved.has(approvalKey(file.path, h.hash))) : undefined)
    const w = wt.walk[file.path]
    return fh.map((h, i) => ({
      hunk: h,
      approved: approved.has(approvalKey(file.path, h.hash)),
      current: h === active,
      position: i + 1,
      total: fh.length,
      auto: autoReasons.get(approvalKey(file.path, h.hash)),
      summary: w?.hunks.find((x) => x.hash === h.hash)?.summary || undefined
    }))
  }, [file, hunks, approved, currentHunk, autoReasons, wt.walk, guided, step, tab, panelOpen])

  const flow: ReviewFlow = {
    steps,
    guideFiles,
    hunks,
    approved,
    autoReasons,
    wt,
    onToggleApprove: toggleApprove,
    onShowHunk: showHunk,
    onGoFile: (path) => {
      if (guided) setStep('files')
      goToStep(path)
    },
    onApproveNext: approveAndNext,
    onOpen: (p, l) => openAt(p, l),
    onComment: (path, h, body) => {
      const a = hunkAnchor(h)
      commentActions.onCreateDraft({ path, line: a.line, side: a.side, body })
    },
    onOpenUrl: (u) => void api.openExternal(u)
  }

  // Keyboard: j/k chunks, a approve & next, c comment, n/p files. Not while typing, only in the visible tab.
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keys.current = (e: KeyboardEvent) => {
    if (!guided || step !== 'files' || !file || outside) return
    if (e.metaKey || e.ctrlKey || e.altKey || !rootRef.current?.offsetParent) return
    if (isTyping(e.target as HTMLElement)) return
    const h = activeHunk()
    const actions: Record<string, () => void> = {
      j: () => moveChunk(1),
      k: () => moveChunk(-1),
      n: () => moveFile(1),
      p: () => moveFile(-1),
      a: () => h && approveAndNext(file.path, h),
      c: () => h && setCommentSignal((x) => x + 1)
    }
    const run = actions[e.key]
    if (run) {
      e.preventDefault()
      e.stopPropagation()
      run()
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Keep the tab's title and draft count current.
  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  useEffect(() => {
    if (pull) onStatusRef.current?.({ title: pull.title, drafts: drafts.length })
  }, [pull, drafts.length])

  const stale = !!guide && !!tree && guide.headSha !== tree.headSha
  const openThreads = threads.filter((t) => !t.resolved).length

  // The guided view shows the review and the guide in the middle, so the panel holds the rest.
  const visibleTab: Tab = guided && (tab === 'review' || tab === 'guide') ? 'conversation' : tab

  function renderPanel(tree: WorktreeInfo) {
    return (
      <div
        className={`panel panel-${panelPosition} ${panelOpen ? 'open' : ''}`}
        style={panelOpen ? (panelPosition === 'right' ? { width: panelWidthLive } : { height: panelHeightLive }) : undefined}
      >
        {panelOpen && <div className="panel-resizer" onMouseDown={startResize} title="Drag to resize" />}
        <div className="panel-tabs">
          {(
            [
              ['review', `Review${hunks ? ` ${steps.filter((f) => (hunks[f.path] ?? []).length && hunks[f.path].every((h) => approved.has(approvalKey(f.path, h.hash)))).length}/${steps.length}` : ''}`],
              ['guide', `Guide${stale ? ' •' : ''}`],
              ['conversation', `Conversation${conversation && conversation.length > 1 ? ` (${conversation.length - 1})` : ''}`],
              ['context', 'Context'],
              ['knowledge', 'Knowledge'],
              ['chat', `Chat${chatLog.length ? ` (${chatLog.filter((m) => m.role === 'user').length})` : ''}`]
            ] as [Tab, string][]
          )
            .filter(([id]) => !guided || (id !== 'review' && id !== 'guide'))
            .map(([id, label]) => (
            <button
              key={id}
              className={visibleTab === id && panelOpen ? 'active' : ''}
              onClick={() => (visibleTab === id && panelOpen ? setPanelOpen(false) : showTab(id))}
            >
              {label}
            </button>
          ))}
          <span className="spacer" />
        <button
          className="icon"
          title={panelPosition === 'bottom' ? 'Move the panel to the right' : 'Move the panel below the diff'}
          onClick={() => setPanelPosition(panelPosition === 'bottom' ? 'right' : 'bottom')}
        >
          {panelPosition === 'bottom' ? '→' : '↓'}
        </button>
        <button className="icon" title={panelOpen ? 'Collapse panel' : 'Expand panel'} onClick={() => setPanelOpen(!panelOpen)}>
          {panelPosition === 'right' ? (panelOpen ? '▸' : '◂') : panelOpen ? '▾' : '▴'}
        </button>
        </div>
        {panelOpen && (
          <div className="panel-content">
            {visibleTab === 'review' && (
              <ReviewPanel
                flow={flow}
                current={outside ? null : file}
                currentHunk={currentHunk && currentHunk.path === file?.path ? currentHunk.index : null}
              />
            )}
            {visibleTab === 'guide' && (
              <GuidePanel
                guide={guide}
                stale={stale}
                busy={guideBusy}
                error={guideError}
                onGenerate={generateGuide}
                onGoTo={(p, l) => openAt(p, l)}
              />
            )}
            {visibleTab === 'conversation' && (
              <ConversationPanel
                items={conversation}
                error={conversationError}
                loading={refreshing}
                onRefresh={() => void loadThreads()}
                onPost={async (body) => {
                  const item = await api.pulls.comment(repo, number, body)
                  setConversation((c) => [...(c ?? []), item])
                }}
                onCodeRef={(p, l) => openAt(p, l)}
                onOpenUrl={(u) => void api.openExternal(u)}
              />
            )}
            {visibleTab === 'context' && (
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
            {visibleTab === 'knowledge' && (
              <KnowledgePanel
                repo={repo}
                number={number}
                headSha={tree.headSha}
                onOpen={(p, l) => openAt(p, l)}
                onOpenUrl={(u) => void api.openExternal(u)}
              />
            )}
            {visibleTab === 'chat' && (
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
    )
  }


  return (
    <div className="pr-view" ref={rootRef}>
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
          <div className="segmented" role="tablist" title="Guided review, or the classic file list">
            <button className={guided ? 'active' : ''} onClick={() => setMode('guided')}>
              Guided
            </button>
            <button className={!guided ? 'active' : ''} onClick={() => setMode('files')}>
              Files
            </button>
          </div>
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
          {guided ? (
            <ReviewOutline
              flow={flow}
              step={step}
              current={outside ? null : file}
              currentHunk={currentHunk && currentHunk.path === file?.path ? currentHunk.index : (activeHunk()?.index ?? null)}
              noise={tree.files.filter((f) => f.noise)}
              commentCounts={commentCounts}
              drafts={drafts.length}
              onStep={setStep}
              onOpenNoise={(f) => {
                setStep('files')
                setOutside(null)
                setFile(f)
              }}
            />
          ) : (
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
          )}

          <div className="center-col">
            {guided && step === 'overview' && (
              <div className="step-scroll">
                <OverviewStep
                  guide={guide}
                  stale={stale}
                  busy={guideBusy}
                  error={guideError}
                  stats={{
                    files: steps.length,
                    noise: tree.files.length - steps.length,
                    chunks: steps.reduce((n, f) => n + (hunks?.[f.path]?.length ?? 0), 0),
                    pre: steps.reduce((n, f) => n + (hunks?.[f.path] ?? []).filter((h) => isAuto(f.path, h)).length, 0),
                    threads: openThreads
                  }}
                  pre={{ rules: preRules, ai: preAi, setRules: setPreRules, setAi: setPreAi }}
                  wt={wt}
                  stepPaths={stepPaths}
                  onGenerate={generateGuide}
                  onGoTo={(p, l) => openAt(p, l)}
                  onStart={() => {
                    // Explain every file in the background (small PRs), so the AI can pre-approve trivial chunks up front.
                    if (wt.auto && preAi && stepPaths.length <= PREPARE_ALL_LIMIT) wt.prepareAll(stepPaths)
                    setStep('files')
                    const first = steps.find((f) => (hunks?.[f.path] ?? []).some((h) => !approved.has(approvalKey(f.path, h.hash)))) ?? steps[0]
                    if (first) goToStep(first.path)
                  }}
                />
              </div>
            )}
            {guided && step === 'finish' && (
              <div className="step-scroll">
                <FinishStep
                  flow={flow}
                  pull={pull}
                  guide={guide}
                  drafts={drafts}
                  threads={threads}
                  onDeleteDraft={commentActions.onDeleteDraft}
                  onGoTo={(p, l, side) => openAt(p, l, side)}
                  reviewBox={
                    pull && (
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
                    )
                  }
                />
              </div>
            )}
            {(!guided || step === 'files') && (
            <>
            <div className="step-row">
            <div className="step-main">
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
            {!outside && guideFile && !guided && (
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
                      hunkMarks={fileHunkMarks}
                      onSelectHunk={(h) => setCurrentHunk({ path: file.path, index: h.index })}
                      onApproveNext={(h) => approveAndNext(file.path, h)}
                    />
                  )}
                </>
              )}
            </div>
            </div>
            {guided && file && !outside && (
              <FileStep
                flow={flow}
                file={file}
                currentHunk={currentHunk && currentHunk.path === file.path ? currentHunk.index : null}
                commentSignal={commentSignal}
                onPrevChunk={() => moveChunk(-1)}
                onNextChunk={() => moveChunk(1)}
              />
            )}
            </div>
            </>
            )}

            {panelPosition === 'bottom' && renderPanel(tree)}
          </div>
          {panelPosition === 'right' && renderPanel(tree)}
        </div>
      )}
    </div>
  )
}
