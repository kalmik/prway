import { app, BrowserWindow, ipcMain, Notification, shell } from 'electron'
import { join } from 'node:path'
import type { AiSettings, AuthState, ChangedFile, GhUser, PrNotification, ReviewEvent } from '../shared/types'
import { GitHub } from './github/api'
import { cancelDeviceFlow, CLIENT_ID, startDeviceFlow, waitForDeviceFlow } from './github/auth'
import { NotificationPoller } from './github/notifications'
import { getPull, getViewer, listPulls, listRepos, submitReview } from './github/pulls'
import { WorktreeManager } from './git/worktrees'
import { API_KEY_SECRET, getAiSettings, saveAiSettings } from './ai/provider'
import { generateGuide, loadGuide, testProvider } from './review/guide'
import { clearSecret, clearToken, loadSettings, loadToken, saveSecret, saveSettings, saveToken } from './store'

// ---- Session state (one signed-in GitHub account) ----

let win: BrowserWindow | null = null
let gh: GitHub | null = null
let viewer: GhUser | null = null
let tokenPersisted = false
let poller: NotificationPoller | null = null
const worktrees = new WorktreeManager(() => gh?.token ?? null)

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
          new Notification({ title: 'Diffscope', body: `${requests} pull request(s) waiting for your review` }).show()
        }
        return
      }
      fresh.forEach(showDesktopNotification)
    }
  })
  poller.start()
}

// ---- IPC: every function the UI can call (see DiffscopeApi in shared/types.ts) ----

function registerIpc(): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) =>
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as A)))

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
    return listPulls(gh, repo, me)
  })
  handle('pulls:get', async (repo: string, number: number) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    return pull
  })
  handle('pulls:submitReview', (repo: string, number: number, event: ReviewEvent, body: string) =>
    submitReview(requireGh().gh, repo, number, event, body)
  )

  handle('worktree:prepare', async (repo: string, number: number) => {
    const { gh, me } = requireGh()
    const pull = await getPull(gh, repo, number, me)
    return worktrees.prepare(repo, number, pull.baseRef)
  })
  handle('worktree:fileDiff', (repo: string, number: number, file: ChangedFile) => worktrees.fileDiff(repo, number, file))
  handle('worktree:reveal', async (repo: string, number: number) => {
    const err = await shell.openPath(worktrees.worktreeDir(repo, number))
    if (err) throw new Error(err)
  })
  handle('worktree:remove', (repo: string, number: number) => worktrees.remove(repo, number))

  handle('notifications:list', () => poller?.list() ?? [])
  handle('notifications:markRead', (id: string) => poller?.markRead(id))

  handle('ai:getSettings', () => getAiSettings())
  handle('ai:saveSettings', (settings: Omit<AiSettings, 'hasApiKey'>, apiKey?: string | null) => {
    saveAiSettings(settings)
    if (apiKey === null) clearSecret(API_KEY_SECRET)
    else if (typeof apiKey === 'string' && apiKey.trim()) {
      if (!saveSecret(API_KEY_SECRET, apiKey.trim())) throw new Error('No system keyring available to store the API key safely.')
    }
    return getAiSettings()
  })
  handle('ai:test', async () => {
    try {
      return { ok: true, detail: await testProvider() }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  })

  handle('guide:get', (repo: string, number: number) => {
    const head = worktrees.headSha(repo, number)
    return head ? loadGuide(repo, number, head) : null
  })
  handle('guide:generate', async (repo: string, number: number) => {
    const { gh, me } = requireGh()
    const { baseSha: _baseSha, ...pull } = await getPull(gh, repo, number, me)
    const tree = await worktrees.prepare(repo, number, pull.baseRef)
    return generateGuide(gh, worktrees, pull, tree.files, tree.headSha)
  })

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
    title: 'Diffscope',
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
