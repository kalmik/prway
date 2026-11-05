// Runs before the UI loads. Exposes a small, typed API as `window.prway`.
// The UI never gets direct access to Node, git or the GitHub token.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { PrwayApi, OpenPrRequest, PrNotification } from '../shared/types'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: PrwayApi = {
  auth: {
    state: call('auth:state'),
    startDeviceFlow: call('auth:startDeviceFlow'),
    waitForDeviceFlow: call('auth:waitForDeviceFlow'),
    cancelDeviceFlow: call('auth:cancelDeviceFlow'),
    loginWithToken: call('auth:loginWithToken'),
    logout: call('auth:logout')
  },
  repos: {
    list: call('repos:list'),
    getSelected: call('repos:getSelected'),
    setSelected: call('repos:setSelected')
  },
  pulls: {
    list: call('pulls:list'),
    get: call('pulls:get'),
    submitReview: call('pulls:submitReview'),
    threads: call('pulls:threads'),
    reply: call('pulls:reply'),
    setResolved: call('pulls:setResolved'),
    conversation: call('pulls:conversation'),
    comment: call('pulls:comment')
  },
  worktree: {
    prepare: call('worktree:prepare'),
    fileDiff: call('worktree:fileDiff'),
    reveal: call('worktree:reveal'),
    remove: call('worktree:remove'),
    cleanup: call('worktree:cleanup')
  },
  code: {
    definitions: call('code:definitions'),
    references: call('code:references'),
    readFile: call('code:readFile'),
    listFiles: call('code:listFiles'),
    changedLines: call('code:changedLines')
  },
  context: {
    changedFunctions: call('context:changedFunctions'),
    forFunction: call('context:forFunction')
  },
  review: {
    hunks: call('review:hunks'),
    cachedWalkthrough: call('review:cachedWalkthrough'),
    walkthrough: call('review:walkthrough'),
    prepareAll: call('review:prepareAll')
  },
  feedback: {
    list: call('feedback:list'),
    rate: call('feedback:rate')
  },
  chat: {
    send: call('chat:send')
  },
  briefing: {
    get: call('briefing:get'),
    generate: call('briefing:generate'),
    saveCard: call('briefing:saveCard')
  },
  kb: {
    related: call('kb:related'),
    sync: call('kb:sync'),
    status: call('kb:status'),
    reveal: call('kb:reveal')
  },
  notifications: {
    list: call('notifications:list'),
    markRead: call('notifications:markRead')
  },
  ai: {
    config: call('ai:config'),
    saveAccount: call('ai:saveAccount'),
    deleteAccount: call('ai:deleteAccount'),
    setDefault: call('ai:setDefault'),
    linkOrg: call('ai:linkOrg'),
    inspectClaudeDir: call('ai:inspectClaudeDir'),
    test: call('ai:test'),
    forRepo: call('ai:forRepo')
  },
  guide: {
    get: call('guide:get'),
    generate: call('guide:generate')
  },
  state: {
    loadAll: () => ipcRenderer.sendSync('state:loadAll') as Record<string, unknown>,
    set: (key, value) => ipcRenderer.send('state:set', key, value)
  },
  prompts: {
    get: call('prompts:get'),
    save: call('prompts:save'),
    preview: call('prompts:preview')
  },
  openExternal: call('openExternal'),
  onNotifications: (cb) => subscribe<PrNotification[]>('notifications', cb),
  onOpenPr: (cb) => subscribe<OpenPrRequest>('open-pr', cb),
  onBriefingProgress: (cb) => subscribe<{ pr: string; step: string }>('briefing:progress', cb)
}

contextBridge.exposeInMainWorld('prway', api)
