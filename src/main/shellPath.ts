// An app opened from Finder, the Dock or a desktop launcher doesn't get your shell's PATH, so `claude` (and a git from
// Homebrew) wouldn't be found. Take the PATH from your login shell, plus the usual install folders as a fallback.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const COMMON_DIRS = [
  join(homedir(), '.local', 'bin'),
  join(homedir(), '.claude', 'local'),
  join(homedir(), '.npm-global', 'bin'),
  join(homedir(), '.asdf', 'shims'),
  '/opt/homebrew/bin',
  '/usr/local/bin'
]

/** Adds folders that exist to PATH (after an install, so new tools are found without a restart). */
export function addToPath(dirs: string[]): void {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const add = dirs.filter((d) => existsSync(d) && !parts.includes(d))
  if (add.length) process.env.PATH = [...parts, ...add].join(delimiter)
}

export function fixPath(): void {
  if (process.platform === 'win32') {
    // Claude Code's native installer and Git for Windows.
    addToPath([join(homedir(), '.local', 'bin'), 'C:\\Program Files\\Git\\cmd'])
    return
  }
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // -i -l: the same PATH a new terminal gets (nvm, asdf, Homebrew...). Markers keep shell greetings out.
    const out = execFileSync(shell, ['-ilc', 'echo __PRWAY_PATH__"$PATH"__PRWAY_PATH__'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const found = /__PRWAY_PATH__(.*)__PRWAY_PATH__/.exec(out)?.[1]
    if (found) parts.unshift(...found.split(delimiter).filter(Boolean))
  } catch {
    // No usable login shell: the fallback folders below still help.
  }
  parts.push(...COMMON_DIRS.filter((d) => existsSync(d)))
  process.env.PATH = [...new Set(parts)].join(delimiter)
}
