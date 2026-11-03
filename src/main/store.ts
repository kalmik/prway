import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AiEffort, AiProviderId } from '../shared/types'

interface Settings {
  selectedRepo?: string
  ai?: { provider: AiProviderId; model: string; effort: AiEffort }
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const secretFile = (name: string) => join(app.getPath('userData'), `${name}.bin`)

/** Where PRway keeps its clones and PR worktrees. Visible on purpose, so you can open them in an IDE. */
export const dataDir = join(homedir(), '.prway')

export function loadSettings(): Settings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as Settings
  } catch {
    return {}
  }
}

export function saveSettings(patch: Partial<Settings>): void {
  const next = { ...loadSettings(), ...patch }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
}

/** Saves a secret encrypted with the OS keyring. Returns false if no keyring is available (then nothing is written). */
export function saveSecret(name: string, value: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(secretFile(name), safeStorage.encryptString(value), { mode: 0o600 })
  return true
}

export function loadSecret(name: string): string | null {
  if (!existsSync(secretFile(name)) || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(readFileSync(secretFile(name)))
  } catch {
    return null
  }
}

export function clearSecret(name: string): void {
  rmSync(secretFile(name), { force: true })
}

export const saveToken = (token: string) => saveSecret('github-token', token)
export const loadToken = () => loadSecret('github-token')
export const clearToken = () => clearSecret('github-token')
