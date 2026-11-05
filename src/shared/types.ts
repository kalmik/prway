// Types shared by the main process (Node side) and the renderer (UI side).

export interface GhUser {
  login: string
  name: string | null
  avatarUrl: string
}

export interface AuthState {
  user: GhUser | null
  /** True when a GitHub OAuth client ID is configured, so "Sign in with GitHub" works. */
  deviceFlowAvailable: boolean
  /** False when the OS keyring is unavailable and the token only lives in memory. */
  tokenPersisted: boolean
}

export interface DeviceCode {
  userCode: string
  verificationUri: string
  expiresIn: number
}

export interface Repo {
  fullName: string
  private: boolean
  pushedAt: string
  description: string | null
}

/** A reason why some repositories (usually an org's) are hidden, with how to fix it. */
export interface AccessIssue {
  kind: 'sso' | 'oauth-restricted' | 'fine-grained-token' | 'missing-scopes'
  org?: string
  message: string
  actionLabel: string
  actionUrl: string
}

export interface RepoListing {
  repos: Repo[]
  issues: AccessIssue[]
}

export interface PullSummary {
  repo: string
  number: number
  title: string
  author: string
  authorAvatar: string
  draft: boolean
  updatedAt: string
  headRef: string
  baseRef: string
  url: string
  /** The signed-in user is a requested reviewer (team requests are not counted yet). */
  reviewRequested: boolean
  /** Your latest review on GitHub, if any. `stale`: the PR got new commits after it. */
  myReview?: { state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'; stale: boolean }
}

export interface PullDetail extends PullSummary {
  body: string | null
  additions: number
  deletions: number
  changedFiles: number
}

/** Git name-status letters: Added, Modified, Deleted, Renamed, Copied, Type change. */
export type FileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T'

/** Why a file is considered noise: it doesn't need a careful read. */
export type NoiseKind = 'generated' | 'rename-only' | 'formatting-only' | 'moved' | 'repo-rule'

export interface ChangedFile {
  path: string
  oldPath?: string
  status: FileStatus
  /** Lines added/deleted; null for binary files. */
  additions: number | null
  deletions: number | null
  /** Set when the noise filter says the file can be skipped. */
  noise?: { kind: NoiseKind; reason: string }
}

// ---- AI review guide ----

export type Risk = 'high' | 'medium' | 'low'

export interface GuideFocus {
  /** Line number in the new version of the file. */
  line: number
  note: string
}

export interface GuideFile {
  path: string
  risk: Risk
  /** Short label such as "business rule", "core logic", "test", "config". */
  role: string
  why: string
  focus: GuideFocus[]
}

export interface ReviewGuide {
  intent: string
  intentSource: 'linked-issue' | 'description' | 'commits' | 'inferred'
  summary: string[]
  businessRules: { path: string; line: number | null; rule: string; change: string }[]
  /** Changes the stated intent doesn't explain. */
  mismatches: string[]
  /** Reviewable files in the suggested reading order. */
  files: GuideFile[]
  questions: string[]
  /** The core of the change: what a reviewer must understand, with the functions where it lives. */
  concepts?: GuideConcept[]
  // Filled in by PRway, not by the model:
  headSha: string
  provider: AiProviderId
  model: string
  createdAt: string
  /** Files whose diff was too long and was cut before sending. */
  truncatedFiles: string[]
  /** Hash of the instructions used (see Settings → Review prompts). */
  promptHash?: string
  /** Set when loading: the repo's instructions changed since this guide was made. */
  instructionsChanged?: boolean
}

/** One core idea of a PR (a feature or business rule it touches), found by the guide. */
export interface GuideConcept {
  name: string
  kind: 'behavior' | 'feature' | 'refactor' | 'plumbing'
  /** Functions where the behaviour lives, in the changed files. */
  seeds: { path: string; name: string }[]
  /** What the reviewer needs to understand about it. */
  question: string
}

// ---- Background briefing (how the code worked before the PR, and why) ----

export type TraceRole = 'seed' | 'caller' | 'entry' | 'callee' | 'test' | 'data'

/** A function (or schema) found while tracing a concept through the code. */
export interface TraceNode {
  /** "path#name". */
  id: string
  path: string
  name: string
  kind: string
  container?: string
  line: number
  endLine: number
  role: TraceRole
  depth: number
  /** id of the node that led here (the function it calls, or is called by). */
  via?: string
  /** Key of the function's card: a hash of its path, name and code. */
  cardKey: string
  /** Test names, for test nodes. */
  tests?: string[]
}

export interface ConceptTrace {
  /** At the merge base, before the PR. */
  base: TraceNode[]
  /** At the PR head. */
  head: TraceNode[]
  /** Earlier PRs that changed the seeds. */
  prs: { number: number; title: string; url: string }[]
}

export interface BriefingCite {
  kind: 'code' | 'pr'
  /** Code: the version, path and line. */
  side?: 'base' | 'head'
  path?: string
  line?: number
  /** PR: number and link. */
  pr?: number
  url?: string
}

export interface BriefingClaim {
  text: string
  cites: BriefingCite[]
}

export interface BriefingConcept {
  name: string
  kind: GuideConcept['kind']
  question: string
  before: BriefingClaim[]
  why: BriefingClaim[]
  change: string
  watchOut: BriefingClaim[]
  trace: ConceptTrace
}

/** What PRway knows about one function: written by the AI, editable by you. */
export interface FunctionCard {
  /** "path#name". */
  id: string
  /** Hash of the path, name and code it describes: the card is reused while the code stays the same. */
  key: string
  summary: string
  rules: string[]
  source: 'ai' | 'edited'
  updatedAt: string
  /** Set when shown for code that changed since (the card was made or edited for an older version). */
  outdated?: boolean
}

export interface Briefing {
  headSha: string
  /** createdAt of the guide whose concepts were traced. */
  guideCreatedAt: string
  createdAt: string
  model: string
  concepts: BriefingConcept[]
  /** Cards of every traced function, by key. */
  cards: Record<string, FunctionCard>
  stats: { nodes: number; factsFromCache: number; cardsReused: number; cardsNew: number; traceSeconds?: number; seconds: number }
}

// ---- File-by-file review walkthrough ----

/** Why PRway pre-approved a hunk without asking you. */
export interface HunkAuto {
  /** 'background': low risk and outside the core change the Background tab traced. */
  kind: 'imports' | 'comments' | 'blank' | 'formatting' | 'moved' | 'ai' | 'background'
  reason: string
}

/** One hunk of a file diff (a "chunk" in the UI), the unit you approve locally. */
export interface Hunk {
  index: number
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Function context git prints after @@, e.g. "def pick_inventory(". */
  header: string
  /** Hash of the changed lines: the same hunk keeps its approval after unrelated new commits. */
  hash: string
  added: number
  deleted: number
  /** Set when a rule says the hunk can't change behaviour (imports, comments, formatting, moved code). */
  auto?: HunkAuto
}

/** AI explanation of one file, hunk by hunk. Saved per head commit. */
export interface FileWalkthrough {
  path: string
  headSha: string
  summary: string
  hints: string[]
  refs: { path: string; line: number | null; why: string }[]
  hunks: {
    index: number
    hash: string
    summary: string
    notes: string[]
    risk: Risk
    /** The model says this hunk can't change behaviour (e.g. log wording, a local rename). */
    trivial?: boolean
    trivialReason?: string
  }[]
  model: string
  createdAt: string
}

// ---- Your feedback on AI hints (per repository) ----

export type HintVerdict = 'useful' | 'noise'

/** Your rating of one AI hint: a file's "Check" item, a chunk's note or a guide focus line. Fed back into later AI requests. */
export interface HintFeedback {
  /** `<kind>|<path>|<text>`: rating the same hint again replaces the old rating. */
  id: string
  kind: 'check' | 'note' | 'focus'
  pr: number
  path: string
  text: string
  verdict: HintVerdict
  at: string
}

// ---- Prompt customisation (per repository) ----

export type PromptKind = 'guide' | 'walkthrough' | 'chat'

/** One layer of prompt customisation: yours (all repos or one repo) or the team's (.prway.json). */
export interface PromptLayer {
  /** About the repository: what the system does, domain terms, conventions. Sent with every AI request. */
  context: string
  /** Extra instructions per prompt (or the full replacement when `replace[kind]` is true). */
  guide: string
  walkthrough: string
  chat: string
  replace: Partial<Record<PromptKind, boolean>>
}

export interface PromptSettingsView {
  /** null = "All repositories". */
  repo: string | null
  /** What you saved for this scope. */
  personal: PromptLayer
  /** Your "All repositories" layer (only when a repo is selected). */
  global: PromptLayer | null
  /** The repo's .prway.json "prompts", read from its default branch as fetched last. */
  team: PromptLayer | null
  teamSource: string | null
  builtIn: Record<PromptKind, string>
  /** Repositories to pick from: the selected one and those with local data. */
  repos: string[]
}

// ---- AI provider settings ----

export type AiProviderId = 'claude-code' | 'anthropic-api'
export type AiEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface AiSettings {
  provider: AiProviderId
  model: string
  effort: AiEffort
  /** Only for the anthropic-api provider; the key itself never reaches the UI. */
  hasApiKey: boolean
}

export interface AiStatus {
  ok: boolean
  detail: string
}

export interface WorktreeInfo {
  path: string
  headSha: string
  mergeBase: string
  files: ChangedFile[]
}

/** Line numbers per side of a diff: LEFT = base (old) file, RIGHT = PR head (new) file. */
export interface SideLines {
  left: number[]
  right: number[]
}

/** Result of removing worktrees of PRs that are no longer open. */
export interface CleanupReport {
  /** PR numbers whose worktree was removed. */
  removed: number[]
  /** Closed PRs whose worktree has local changes: kept, remove them by hand. */
  dirty: number[]
  /** Skipped because a cleanup ran recently (automatic runs only). */
  skipped?: boolean
}

export interface FileDiff {
  original: string
  modified: string
  /** Set when the file is binary or too large to show; contents are then empty. */
  skipped?: 'binary' | 'too-large'
  /** Lines GitHub accepts review comments on (inside a diff hunk). */
  commentable: SideLines
  /** Lines that git sees as moved code (within or between files). */
  moved: SideLines
}

// ---- Inline review comments ----

export type DiffSide = 'LEFT' | 'RIGHT'

export interface ReviewComment {
  /** REST id, used to reply. */
  id: number
  author: string
  authorAvatar: string
  body: string
  createdAt: string
  url: string
}

export interface ReviewThread {
  /** GraphQL node id, used to resolve. */
  id: string
  path: string
  /** Line in the current diff; null when the thread is outdated or on the whole file. */
  line: number | null
  startLine: number | null
  side: DiffSide
  resolved: boolean
  outdated: boolean
  /** Line the thread was written on, in the commit it was written on (still set when outdated). */
  originalLine: number | null
  /** The code the thread was written on (GitHub's diff hunk ending at that line). */
  diffHunk: string
  comments: ReviewComment[]
}

/** One entry of the PR's Conversation tab, in date order. */
export interface ConversationItem {
  kind: 'description' | 'comment' | 'review'
  id: string
  author: string
  authorAvatar: string
  body: string
  createdAt: string
  url: string
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED. */
  state?: string
  /** Reviews only: inline comments that came with it. */
  inlineCount?: number
}

/** A comment written in PRway, not sent yet. Sent with the next review. */
export interface DraftComment {
  id: string
  path: string
  line: number
  startLine?: number
  side: DiffSide
  body: string
  /** PR head commit the line numbers refer to. */
  headSha: string
}

// ---- Code navigation and context ----

export interface CodeLocation {
  path: string
  line: number
  text: string
  /** Set for definitions, e.g. "function", "module". */
  kind?: string
}

export interface CodeSymbol {
  name: string
  kind: string
  line: number
  endLine: number
  /** Enclosing module or class, e.g. "Warehouse.Inbound.Receiving". */
  container?: string
}

export interface ChangedFunction extends CodeSymbol {
  path: string
  /** Changed lines inside it (new-file numbers). */
  changedLines: number
}

export interface PastPr {
  number: number
  title: string
  url: string
  /** Review comments that PR got on this file. */
  comments: { author: string; body: string; url: string }[]
}

export interface HistoryCommit {
  sha: string
  date: string
  author: string
  subject: string
  pr?: PastPr
}

export interface FunctionContext {
  fn: ChangedFunction
  /** Earlier commits that touched these lines, newest first (the PR's own commits left out). */
  history: HistoryCommit[]
  callers: CodeLocation[]
  /** Callers inside test files. */
  tests: CodeLocation[]
  /** More callers exist than shown. */
  truncated: boolean
}

// ---- Chat about a PR ----

/** Lines of code the reviewer attached to a chat question. */
export interface ChatCodeRef {
  path: string
  startLine: number
  endLine: number
  /** 'base' is the old version (left side of the diff), 'head' the PR's version. */
  side: 'base' | 'head'
  code: string
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  /** Code the question is about (user messages only). */
  refs?: ChatCodeRef[]
}

// ---- Knowledge base ----

export interface KbEntry {
  repo: string
  number: number
  title: string
  url: string
  author: string
  mergedAt: string
  intent: string
  rules: { path: string; line: number | null; rule: string; change: string }[]
  decisions: { reviewer: string; state: string; body: string }[]
  discussions: { path: string; line: number | null; resolved: boolean; author: string; body: string }[]
  files: string[]
  /** "path#name" of the functions the PR changed. */
  symbols: string[]
  domains: string[]
}

export interface KbMatch {
  entry: KbEntry
  files: string[]
  symbols: string[]
}

export interface KbStatus {
  entries: number
  folder: string
  lastSync: string | null
  /** PRs added by the last sync. */
  added: number
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

export interface PrNotification {
  id: string
  repo: string
  prNumber: number | null
  title: string
  /** GitHub reason, e.g. review_requested, mention, comment, state_change. */
  reason: string
  updatedAt: string
  url: string
}

export interface OpenPrRequest {
  repo: string
  number: number
}

/** The API the preload script exposes to the UI as `window.prway`. */
export interface PrwayApi {
  auth: {
    state(): Promise<AuthState>
    startDeviceFlow(): Promise<DeviceCode>
    waitForDeviceFlow(): Promise<AuthState>
    cancelDeviceFlow(): Promise<void>
    loginWithToken(token: string): Promise<AuthState>
    logout(): Promise<void>
  }
  repos: {
    list(): Promise<RepoListing>
    getSelected(): Promise<string | null>
    setSelected(fullName: string): Promise<void>
  }
  pulls: {
    list(repo: string): Promise<PullSummary[]>
    get(repo: string, number: number): Promise<PullDetail>
    /** Submits a review with the given drafts as inline comments, on the head commit PRway shows. */
    submitReview(repo: string, number: number, event: ReviewEvent, body: string, comments: DraftComment[]): Promise<void>
    threads(repo: string, number: number): Promise<ReviewThread[]>
    reply(repo: string, number: number, commentId: number, body: string): Promise<ReviewComment>
    setResolved(threadId: string, resolved: boolean): Promise<void>
    /** Description, general comments and review summaries, oldest first. */
    conversation(repo: string, number: number): Promise<ConversationItem[]>
    /** Posts a general comment on the PR (Conversation tab on GitHub). */
    comment(repo: string, number: number, body: string): Promise<ConversationItem>
  }
  worktree: {
    prepare(repo: string, number: number): Promise<WorktreeInfo>
    fileDiff(repo: string, number: number, file: ChangedFile): Promise<FileDiff>
    reveal(repo: string, number: number): Promise<void>
    remove(repo: string, number: number): Promise<void>
    /**
     * Removes worktrees of PRs that are closed or merged (after saving merged ones to the knowledge base).
     * `keep`: PR numbers open in a tab. `auto`: at most every 30 minutes per repo.
     */
    cleanup(repo: string, keep: number[], auto?: boolean): Promise<CleanupReport>
  }
  code: {
    /** Where `word` is defined. `qualifier` is the text before a dot, e.g. "Repo" in "Repo.get". */
    definitions(repo: string, number: number, word: string, qualifier?: string): Promise<CodeLocation[]>
    references(repo: string, number: number, word: string): Promise<{ locations: CodeLocation[]; truncated: boolean }>
    /** Any file at the PR head, for files the PR did not change. */
    readFile(repo: string, number: number, path: string): Promise<{ text: string; skipped?: FileDiff['skipped'] }>
    /** Every file of the repository at the PR head (for the code browser). */
    listFiles(repo: string, number: number): Promise<string[]>
    /** Lines of `path` at the PR head that the PR added or changed. */
    changedLines(repo: string, number: number, path: string): Promise<number[]>
  }
  context: {
    changedFunctions(repo: string, number: number, path: string): Promise<ChangedFunction[]>
    forFunction(repo: string, number: number, fn: ChangedFunction): Promise<FunctionContext>
  }
  review: {
    /** Hunks of every changed file, from the merge base to the PR head. */
    hunks(repo: string, number: number): Promise<Record<string, Hunk[]>>
    /** The saved walkthrough for a file at the current head, if any. */
    cachedWalkthrough(repo: string, number: number, path: string): Promise<FileWalkthrough | null>
    /** Explains one file hunk by hunk (cached; `regenerate` forces a new one). */
    walkthrough(repo: string, number: number, path: string, regenerate?: boolean): Promise<FileWalkthrough>
    /** Makes the missing walkthroughs for these files in the background (2 at a time); resolves when done. */
    prepareAll(repo: string, number: number, paths: string[]): Promise<number>
  }
  feedback: {
    /** Your ratings of AI hints in this repository. */
    list(repo: string): Promise<HintFeedback[]>
    /** Rates a hint (`verdict` null removes the rating); returns the updated list. */
    rate(repo: string, hint: Omit<HintFeedback, 'id' | 'at' | 'verdict'> & { verdict: HintVerdict | null }): Promise<HintFeedback[]>
  }
  chat: {
    /** Asks a question about the PR. The diff, guide and context are sent along with the conversation. */
    send(repo: string, number: number, messages: ChatMessage[]): Promise<ChatMessage>
  }
  briefing: {
    /** The saved briefing for this PR (the newest one when the head moved), or null. */
    get(repo: string, number: number): Promise<Briefing | null>
    /** Traces the guide's concepts through the code and explains how it worked before. */
    generate(repo: string, number: number): Promise<Briefing>
    /** Saves your edit of a function card; it wins over the AI's from now on. */
    saveCard(repo: string, card: Pick<FunctionCard, 'id' | 'key' | 'summary' | 'rules'>): Promise<FunctionCard>
  }
  kb: {
    /** Knowledge base entries about the code this PR touches. */
    related(repo: string, number: number): Promise<KbMatch[]>
    /** Adds merged PRs you reviewed in PRway. */
    sync(repo: string): Promise<KbStatus>
    status(repo: string): Promise<KbStatus>
    reveal(repo: string): Promise<void>
  }
  notifications: {
    list(): Promise<PrNotification[]>
    markRead(id: string): Promise<void>
  }
  ai: {
    getSettings(): Promise<AiSettings>
    /** apiKey: a string saves it, null deletes it, undefined leaves it unchanged. */
    saveSettings(settings: Omit<AiSettings, 'hasApiKey'>, apiKey?: string | null): Promise<AiSettings>
    test(): Promise<AiStatus>
  }
  guide: {
    /** The saved guide for the PR's current head commit, if any. */
    get(repo: string, number: number): Promise<ReviewGuide | null>
    generate(repo: string, number: number): Promise<ReviewGuide>
  }
  /** UI state saved by the main process (survives crashes, unlike localStorage). */
  state: {
    loadAll(): Record<string, unknown>
    set(key: string, value: unknown): void
  }
  prompts: {
    get(repo: string | null): Promise<PromptSettingsView>
    save(repo: string | null, layer: PromptLayer): Promise<PromptSettingsView>
    /** The system prompt as it would be sent for this repo. */
    preview(repo: string | null, kind: PromptKind): Promise<string>
  }
  openExternal(url: string): Promise<void>
  onNotifications(cb: (items: PrNotification[]) => void): () => void
  onOpenPr(cb: (req: OpenPrRequest) => void): () => void
  /** Steps of a background build in progress ("repo#number" and the step). */
  onBriefingProgress(cb: (p: { pr: string; step: string }) => void): () => void
}
