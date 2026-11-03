// Runs before the UI loads. Exposes a small, typed API as `window.diffscope`.
// The UI never gets direct access to Node, git or the GitHub token.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DiffscopeApi, OpenPrRequest, PrNotification } from '../shared/types'

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args)

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DiffscopeApi = {
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
    submitReview: call('pulls:submitReview')
  },
  worktree: {
    prepare: call('worktree:prepare'),
    fileDiff: call('worktree:fileDiff'),
    reveal: call('worktree:reveal'),
    remove: call('worktree:remove')
  },
  notifications: {
    list: call('notifications:list'),
    markRead: call('notifications:markRead')
  },
  openExternal: call('openExternal'),
  onNotifications: (cb) => subscribe<PrNotification[]>('notifications', cb),
  onOpenPr: (cb) => subscribe<OpenPrRequest>('open-pr', cb)
}

contextBridge.exposeInMainWorld('diffscope', api)
