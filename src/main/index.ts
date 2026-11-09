import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { join } from 'node:path'
import { fixPath } from './shellPath'
import { Updater } from './updater'
import { checkSetup, fixGit, installClaude, openClaudeLogin } from './setup'
import type {
  AiAccount,
  PrReview,
  AuthState,
  ChangedFile,
  ChangedFunction,
  ChatMessage,
  DraftComment,
  GhUser,
  PrNotification,
  PromptKind,
  PromptLayer,
  ReviewEvent,
  WorktreeInfo
} from '../shared/types'
import { GitHub } from './github/api'
import { cancelDeviceFlow, CLIENT_ID, startDeviceFlow, waitForDeviceFlow } from './github/auth'
import { NotificationPoller } from './github/notifications'
import {
  getPull,
  getViewer,
  listPulls,
  listRepos,
  listConversation,
  listThreads,
  postComment,
  replyToComment,
  setThreadResolved,
  submitReview
} from './github/pulls'
import { WorktreeManager } from './git/worktrees'
import { CodeNavigator } from './code/navigator'
import { KnowledgeBase } from './kb/knowledge'
import { WorktreeCleanup } from './git/cleanup'
import { aiConfig, aiFor, deleteAccount, linkOrg, saveAccount, setDefaultAccount } from './ai/provider'
import { claudeSignIn } from './ai/claudeCode'
import { chat } from './review/chat'
import { loadFeedback, rateHint, removeFeedback } from './review/feedback'
import { generateReview, loadReview } from './review/reviewer'
import { generateBriefing, loadBriefing } from './trace/briefing'
import { CardStore } from './trace/cards'
import { Walkthroughs } from './review/walkthrough'
import { generateGuide, loadGuide, relatedKnowledge, testProvider, type GuideDeps } from './review/guide'
import { previewPrompt, promptsView, savePrompts, systemPrompt } from './review/prompts'
import {
  clearSecret,
  clearToken,
  flushUiState,
  loadSettings,
  loadToken,
  loadUiState,
  saveSecret,
  saveSettings,
  saveToken,
  setUiState
} from './store'

// Before anything spawns git or claude: a packaged app started from the Dock has a minimal PATH.
if (app.isPackaged) fixPath()

// ---- Session state (one signed-in GitHub account) ----

let win: BrowserWindow | null = null
let gh: GitHub | null = null
let viewer: GhUser | null = null
let tokenPersisted = false
let poller: NotificationPoller | null = null
const worktrees = new WorktreeManager(() => gh?.token ?? null)
const navigator = new CodeNavigator(worktrees, () => gh)
const kb = new KnowledgeBase(worktrees, () => gh)
const walkthroughs = new Walkthroughs(worktrees, navigator)
const cleanup = new WorktreeCleanup(worktrees, kb, () => gh)
/** Last prepared worktree per PR ("owner/name#n"). */
const trees = new Map<string, WorktreeInfo>()

async function prepare(repo: string, number: number): Promise<WorktreeInfo> {
  const { gh, me } = requireGh()
  const pull = await getPull(gh, repo, number, me)
  const tree = await worktrees.prepare(
    repo,
    number,
    pull.baseRef,
    (step) => win?.webContents.send('worktree:progress', { pr: `${repo}#${number}`, step }),
    pull.headSha
  )
  trees.set(`${repo}#${number}`, tree)
  return tree
}

/** The prepared worktree, preparing it when PRway has not done so since it started. */
async function prepared(repo: string, number: number): Promise<WorktreeInfo> {
  return trees.get(`${repo}#${number}`) ?? prepare(repo, number)
}

function guideDeps(): GuideDeps {
  return { gh: requireGh().gh, worktrees, navigator, kb }
}

function requireGh(): { gh: GitHub; me: string } {
  if (!gh || !viewer) throw new Error('Not signed in')
  return { gh, me: viewer.login }
}

function authState(): AuthState {
  return { user: viewer, deviceFlowAvailable: !!CLIENT_ID, tokenPersisted }
}

async function signIn(token: string, persist: boolean): Promise<AuthState> {
  const client = new GitHub(token)
  viewer = await getViewer(client) // throws if the token is invalid
  gh = client
  tokenPersisted = persist ? saveToken(token) : tokenPersisted
  startPoller()
  return authState()
}

function signOut(): void {
  poller?.stop()
  poller = null
  gh = null
  viewer = null
  tokenPersisted = false
  clearToken()
}

// ---- Notifications: relay GitHub PR notifications to the desktop ----

const REASON_TEXT: Record<string, string> = {
  review_requested: 'Review requested',
  mention: 'You were mentioned',
  team_mention: 'Your team was mentioned',
  comment: 'New comment',
  author: 'Activity on your PR',
  state_change: 'PR state changed',
  assign: 'Assigned to you'
}

function showDesktopNotification(n: PrNotification): void {
  if (!Notification.isSupported()) return
  const note = new Notification({
    title: `${REASON_TEXT[n.reason] ?? 'Update'} · ${n.repo}${n.prNumber ? ` #${n.prNumber}` : ''}`,
    body: n.title
  })
  note.on('click', () => {
    if (!win) return
    win.show()
    win.focus()
    if (n.prNumber) win.webContents.send('open-pr', { repo: n.repo, number: n.prNumber })
  })
  note.show()
}

function startPoller(): void {
  poller?.stop()
  if (!gh) return
  poller = new NotificationPoller(gh, {
    onChange: (items) => win?.webContents.send('notifications', items),
    onNew: (fresh, firstPoll) => {
      if (firstPoll) {
        // On startup, one summary instead of a burst of notifications.
        const requests = fresh.filter((n) => n.reason === 'review_requested').length
        if (requests && Notification.isSupported()) {
          new Notification({ title: 'PRway', body: `${requests} pull request(s) waiting for your review` }).show()
        }
        return
      }
      fresh.forEach(showDesktopNotification)
    }
  })
  poller.start()
}

const updater = new Updater((s) => win?.webContents.send('updates:state', s))

// ---- IPC: every function the UI can call (see PrwayApi in shared/types.ts) ----

function registerIpc(): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) =>
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as A)))

  // UI state: read once, synchronously, before the UI first renders; then written on every change.
  ipcMain.on('state:loadAll', (e) => (e.returnValue = loadUiState()))
  ipcMain.on('state:set', (_e, key: string, value: unknown) => setUiState(key, value))

  handle('updates:state', () => updater.get())
  handle('updates:check', () => updater.check())
  handle('updates:download', () => updater.download())
  handle('updates:install', () => updater.install())

  handle('auth:state', () => authState())
  handle('auth:startDeviceFlow', () => startDeviceFlow())
  handle('auth:waitForDeviceFlow', async () => signIn(await waitForDeviceFlow(), true))
  handle('auth:cancelDeviceFlow', () => cancelDeviceFlow())
  handle('auth:loginWithToken', (token: string) => signIn(token.trim(), true))
  handle('auth:logout', () => signOut())

  handle('repos:list', () => listRepos(requireGh().gh))
  handle('repos:getSelected', () => loadSettings().selectedRepo ?? null)
  handle('repos:setSelected', (fullName: string) => saveSettings({ selectedRepo: fullName }))

  handle('pulls:list', (repo: string) => {
    const { gh, me } = requireGh()
    // Merged PRs you reviewed go into the knowledge base; checked at most every 15 minutes.
    kb.syncInBackground(repo)
    return listPulls(gh, repo, me)
  })
  handle('pulls:get', async (repo: string, number: number) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    return pull
  })
  handle('pulls:submitReview', (repo: string, number: number, event: ReviewEvent, body: string, comments: DraftComment[] = []) =>
    submitReview(requireGh().gh, repo, number, event, body, comments, worktrees.headSha(repo, number))
  )
  handle('pulls:threads', (repo: string, number: number) => listThreads(requireGh().gh, repo, number))
  handle('pulls:reply', (repo: string, number: number, commentId: number, body: string) =>
    replyToComment(requireGh().gh, repo, number, commentId, body)
  )
  handle('pulls:conversation', (repo: string, number: number) => listConversation(requireGh().gh, repo, number))
  handle('pulls:comment', (repo: string, number: number, body: string) => postComment(requireGh().gh, repo, number, body))
  handle('pulls:setResolved', (threadId: string, resolved: boolean) => setThreadResolved(requireGh().gh, threadId, resolved))

  handle('worktree:prepare', (repo: string, number: number) => prepare(repo, number))
  handle('worktree:fileDiff', (repo: string, number: number, file: ChangedFile) => worktrees.fileDiff(repo, number, file))
  handle('worktree:reveal', async (repo: string, number: number) => {
    const err = await shell.openPath(worktrees.worktreeDir(repo, number))
    if (err) throw new Error(err)
  })
  handle('worktree:cleanup', (repo: string, keep?: number[], auto?: boolean) => cleanup.run(repo, keep ?? [], !!auto))
  handle('worktree:remove', (repo: string, number: number) => {
    trees.delete(`${repo}#${number}`)
    return worktrees.remove(repo, number)
  })

  handle('code:definitions', async (repo: string, number: number, word: string, qualifier?: string) => {
    await prepared(repo, number)
    return navigator.definitions(repo, number, word, qualifier)
  })
  handle('code:references', async (repo: string, number: number, word: string) => {
    await prepared(repo, number)
    return navigator.references(repo, number, word)
  })
  handle('code:readFile', async (repo: string, number: number, path: string) => {
    await prepared(repo, number)
    return navigator.readFile(repo, number, path)
  })
  handle('code:listFiles', async (repo: string, number: number) => {
    await prepared(repo, number)
    return navigator.listFiles(repo, number)
  })
  handle('code:commentableLines', async (repo: string, number: number, path: string) => {
    await prepared(repo, number)
    return navigator.commentableLines(repo, number, path)
  })
  handle('code:changedLines', async (repo: string, number: number, path: string) => {
    await prepared(repo, number)
    return navigator.changedLines(repo, number, path)
  })
  handle('context:changedFunctions', async (repo: string, number: number, path: string) => {
    await prepared(repo, number)
    return navigator.changedFunctions(repo, number, path)
  })
  handle('context:forFunction', async (repo: string, number: number, fn: ChangedFunction) => {
    await prepared(repo, number)
    return navigator.forFunction(repo, number, fn)
  })

  handle('feedback:list', async (repo: string) => loadFeedback(repo))
  handle('feedback:rate', async (repo: string, hint: Parameters<typeof rateHint>[1]) => rateHint(repo, hint))
  handle('feedback:remove', async (repo: string, id: string) => removeFeedback(repo, id))

  handle('review:hunks', async (repo: string, number: number) => {
    await prepared(repo, number)
    return walkthroughs.hunksForUi(repo, number)
  })
  handle('review:cachedWalkthrough', async (repo: string, number: number, path: string) => {
    await prepared(repo, number)
    return walkthroughs.cached(repo, number, path)
  })
  handle('review:walkthrough', async (repo: string, number: number, path: string, regenerate?: boolean) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    const tree = await prepared(repo, number)
    return walkthroughs.generate(pull, tree.files, path, regenerate)
  })

  handle('review:prepareAll', async (repo: string, number: number, paths: string[]) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    const tree = await prepared(repo, number)
    return walkthroughs.prepareAll(pull, tree.files, paths)
  })

  handle('chat:send', async (repo: string, number: number, messages: ChatMessage[]) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    const tree = await prepared(repo, number)
    return chat(guideDeps(), pull, tree.files, loadGuide(repo, number, tree.headSha), messages)
  })

  handle('kb:related', async (repo: string, number: number) => {
    const tree = await prepared(repo, number)
    return relatedKnowledge(navigator, kb, repo, number, tree.files.filter((f) => !f.noise))
  })
  handle('kb:sync', (repo: string) => kb.sync(repo))
  handle('kb:status', (repo: string) => kb.status(repo))
  handle('kb:reveal', async (repo: string) => {
    const s = kb.status(repo)
    if (!s.entries) throw new Error('The knowledge base for this repo is empty: it fills up as PRs you reviewed get merged.')
    const err = await shell.openPath(s.folder)
    if (err) throw new Error(err)
  })

  handle('notifications:list', () => poller?.list() ?? [])
  handle('notifications:markRead', (id: string) => poller?.markRead(id))

  // ---- First-run setup ----
  const setupDir = (accountId?: string) => {
    const cfg = aiConfig()
    const acc = cfg.accounts.find((a) => a.id === (accountId ?? cfg.defaultAccount))
    return acc?.provider === 'claude-code' ? acc.claudeConfigDir : null
  }
  handle('setup:check', (accountId?: string) => checkSetup(setupDir(accountId)))
  handle('setup:fixGit', () => fixGit())
  handle('setup:installClaude', async () => {
    await installClaude((line) => win?.webContents.send('setup:progress', line))
    return checkSetup(setupDir())
  })
  handle('setup:openClaudeLogin', (accountId?: string) => openClaudeLogin(setupDir(accountId)))

  handle('ai:config', () => aiConfig())
  handle('ai:saveAccount', (account: Omit<AiAccount, 'hasApiKey'>, apiKey?: string | null) => saveAccount(account, apiKey))
  handle('ai:deleteAccount', (id: string) => deleteAccount(id))
  handle('ai:setDefault', (id: string) => setDefaultAccount(id))
  handle('ai:linkOrg', (org: string, accountId: string | null) => linkOrg(org, accountId))
  handle('ai:inspectClaudeDir', (dir: string | null) => claudeSignIn(dir))
  handle('ai:forRepo', (repo: string) => aiFor(repo))
  handle('ai:test', async (accountId: string) => {
    try {
      return { ok: true, detail: await testProvider(accountId) }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  })

  handle('guide:get', (repo: string, number: number) => {
    const head = worktrees.headSha(repo, number)
    const guide = head ? loadGuide(repo, number, head) : null
    if (!guide?.promptHash) return guide
    // Tell the UI when the repo's instructions changed since this guide was made.
    const current = systemPrompt('guide', repo, worktrees.rulesOrNull(repo, number)).hash
    return { ...guide, instructionsChanged: current !== guide.promptHash }
  })

  handle('prompts:get', (repo: string | null) => promptsView(worktrees, repo))
  handle('prompts:save', (repo: string | null, layer: PromptLayer) => {
    savePrompts(repo, layer)
    return promptsView(worktrees, repo)
  })
  handle('prompts:preview', (repo: string | null, kind: PromptKind) => previewPrompt(worktrees, repo, kind))
  handle('guide:generate', async (repo: string, number: number) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    const tree = await prepare(repo, number)
    return generateGuide(guideDeps(), pull, tree.files, tree.headSha)
  })

  handle('findings:get', async (repo: string, number: number) => {
    const head = worktrees.headSha(repo, number)
    return head ? loadReview(repo, number, head) : null
  })
  // One review per PR at a time (the guide finishing and a click can both start it).
  const reviewing = new Map<string, Promise<PrReview>>()
  handle('findings:generate', (repo: string, number: number, force?: boolean) => {
    const key = `${repo}#${number}`
    const running = reviewing.get(key)
    if (running) return running
    const job = (async () => {
      const { gh, me } = requireGh()
      const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
      const tree = await prepared(repo, number)
      const hunks = await walkthroughs.allHunks(repo, number)
      return generateReview(guideDeps(), pull, tree.files, loadGuide(repo, number, tree.headSha), hunks, tree.headSha, force)
    })().finally(() => reviewing.delete(key))
    reviewing.set(key, job)
    return job
  })

  handle('briefing:get', async (repo: string, number: number) => {
    const head = worktrees.headSha(repo, number)
    return head ? loadBriefing(repo, number, head) : null
  })
  handle('briefing:generate', async (repo: string, number: number) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    const tree = await prepared(repo, number)
    const progress = (step: string) => win?.webContents.send('briefing:progress', { pr: `${repo}#${number}`, step })
    // An empty step says it finished (the PR header's activity strip clears it).
    return generateBriefing({ gh, worktrees, navigator, progress }, pull, tree.files, loadGuide(repo, number, tree.headSha)).finally(() =>
      progress('')
    )
  })
  handle('briefing:saveCard', (repo: string, card: { id: string; key: string; summary: string; rules: string[] }) =>
    new CardStore(repo).put({ id: card.id, key: card.key, summary: card.summary.trim(), rules: card.rules.map((r) => r.trim()).filter(Boolean), source: 'edited' })
  )

  handle('openExternal', (url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened')
    return shell.openExternal(url)
  })
}

// ---- Window ----

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 600,
    title: 'PRway',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.once('ready-to-show', () => win?.show())
  win.on('closed', () => (win = null))

  // Links that try to open a new window go to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  registerIpc()

  const saved = loadToken()
  if (saved) {
    try {
      tokenPersisted = true
      await signIn(saved, false)
    } catch (err) {
      console.warn('Saved GitHub token no longer works:', (err as Error).message)
      signOut()
    }
  }

  createWindow()
  updater.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => flushUiState())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
