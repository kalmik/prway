import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface Settings {
  selectedRepo?: string
}

const settingsFile = () => join(app.getPath('userData'), 'settings.json')
const tokenFile = () => join(app.getPath('userData'), 'github-token.bin')

/** Where Diffscope keeps its clones and PR worktrees. Visible on purpose, so you can open them in an IDE. */
export const dataDir = join(homedir(), '.diffscope')

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

/** Saves the token encrypted with the OS keyring. Returns false if no keyring is available (token stays in memory only). */
export function saveToken(token: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 })
  return true
}

export function loadToken(): string | null {
  if (!existsSync(tokenFile()) || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(readFileSync(tokenFile()))
  } catch {
    return null
  }
}

export function clearToken(): void {
  rmSync(tokenFile(), { force: true })
}
