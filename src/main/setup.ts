// First-run setup: checks what PRway needs outside itself (git, and Claude Code for subscription accounts) and fixes
// what it can with the user's click. Nothing is installed without one: every fix says what it runs.

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SetupCheck, SetupTool } from '../shared/types'
import { claudeSignIn, resolveClaudeDir } from './ai/claudeCode'
import { addToPath } from './shellPath'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

/** Anthropic's official native installers (per user, into ~/.local/bin). */
export const CLAUDE_INSTALL = isWin
  ? 'irm https://claude.ai/install.ps1 | iex'
  : 'curl -fsSL https://claude.ai/install.sh | bash'

/** Where the native installer puts `claude` (all platforms). */
const CLAUDE_BIN_DIR = join(homedir(), '.local', 'bin')

function version(cmd: string, args: string[]): Promise<SetupTool> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err) resolve({ ok: false, version: null })
      else resolve({ ok: true, version: stdout.trim().split('\n')[0] || 'installed' })
    })
  })
}

/** The command that installs git here, for the user to run (Linux) or for PRway to start (macOS, Windows). */
function gitFix(): string {
  if (isMac) return 'xcode-select --install'
  if (isWin) return 'winget install --id Git.Git -e --source winget'
  if (existsSync('/usr/bin/apt-get')) return 'sudo apt-get install -y git'
  if (existsSync('/usr/bin/dnf')) return 'sudo dnf install -y git'
  if (existsSync('/usr/bin/pacman')) return 'sudo pacman -S --needed git'
  if (existsSync('/usr/bin/zypper')) return 'sudo zypper install -y git'
  return 'install git with your package manager'
}

export async function checkSetup(claudeConfigDir: string | null): Promise<SetupCheck> {
  addToPath([CLAUDE_BIN_DIR])
  // The same binary AI requests use (PRWAY_CLAUDE_BIN overrides it).
  const claudeBin = process.env.PRWAY_CLAUDE_BIN || 'claude'
  const [git, claude] = await Promise.all([version('git', ['--version']), version(claudeBin, ['--version'])])
  return {
    platform: process.platform,
    git,
    gitFix: gitFix(),
    // Linux installs need sudo: PRway shows the command instead of asking for a password.
    gitAutoFix: isMac || isWin,
    claude,
    claudeInstall: CLAUDE_INSTALL,
    signIn: claude.ok ? claudeSignIn(claudeConfigDir) : null
  }
}

/** macOS: Apple's "install command line tools" dialog. Windows: winget (Windows asks for permission). */
export function fixGit(): Promise<string> {
  if (isMac) {
    return new Promise((resolve, reject) =>
      execFile('xcode-select', ['--install'], (err, _out, stderr) => {
        // "already installed" comes back as an error; that's fine.
        if (err && !/already installed/i.test(stderr)) return reject(new Error(stderr.trim() || err.message))
        resolve('Apple’s installer is open: click Install, wait for it to finish, then press Check again.')
      })
    )
  }
  if (isWin) {
    return run('winget', ['install', '--id', 'Git.Git', '-e', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements'], () => undefined).then(() => {
      addToPath(['C:\\Program Files\\Git\\cmd'])
      return 'Git is installed.'
    })
  }
  return Promise.reject(new Error(`Run this in a terminal, then press Check again: ${gitFix()}`))
}

/** Runs a command, reporting each output line; rejects with the last lines on failure. */
function run(cmd: string, args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    // No stdin: an installer that asks something fails instead of waiting forever.
    const child = spawn(cmd, args, { windowsHide: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const tail: string[] = []
    const take = (d: Buffer) => {
      for (const raw of d.toString().split(/\r?\n|\r/)) {
        // Strip colours and cursor codes the installers print.
        const line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim()
        if (!line) continue
        tail.push(line)
        if (tail.length > 8) tail.shift()
        onLine(line)
      }
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    child.on('error', (err) => reject(new Error(`Could not run ${cmd}: ${err.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(tail.join('\n') || `${cmd} exited with ${code}`))))
  })
}

/** Runs Anthropic's installer for Claude Code (per user, no admin rights), reporting progress. */
export async function installClaude(onLine: (line: string) => void): Promise<void> {
  if (isWin) {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', CLAUDE_INSTALL], onLine)
  } else {
    await run('/bin/bash', ['-c', `set -o pipefail; ${CLAUDE_INSTALL}`], onLine)
  }
  addToPath([CLAUDE_BIN_DIR])
}

/**
 * Opens a terminal running `claude` (for the account's config folder), where you type /login; Claude Code continues
 * in the browser. PRway notices the sign-in on the next check.
 */
export function openClaudeLogin(claudeConfigDir: string | null): void {
  const dir = resolveClaudeDir(claudeConfigDir)
  const isDefault = dir === join(homedir(), '.claude') && !process.env.CLAUDE_CONFIG_DIR
  if (isMac) {
    // A tiny .command script: Terminal opens it and runs claude with the right folder.
    const script = join(mkdtempSync(join(tmpdir(), 'prway-')), 'claude-login.command')
    const env = isDefault ? 'unset CLAUDE_CONFIG_DIR' : `export CLAUDE_CONFIG_DIR=${JSON.stringify(dir)}`
    writeFileSync(script, `#!/bin/bash\n${env}\nexport PATH=${JSON.stringify(process.env.PATH ?? '')}\necho "Type /login to sign in to Claude, then come back to PRway."\nclaude\n`, { mode: 0o755 })
    spawn('open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  const env = { ...process.env }
  if (isDefault) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = dir
  if (isWin) {
    spawn('cmd.exe', ['/c', 'start', '"Claude login"', 'cmd', '/k', 'claude'], { detached: true, stdio: 'ignore', env, windowsHide: false }).unref()
    return
  }
  // Linux: the first terminal that exists.
  const terms: [string, string[]][] = [
    ['x-terminal-emulator', ['-e', 'claude']],
    ['gnome-terminal', ['--', 'claude']],
    ['konsole', ['-e', 'claude']],
    ['xfce4-terminal', ['-e', 'claude']],
    ['xterm', ['-e', 'claude']]
  ]
  const found = terms.find(([t]) => (process.env.PATH ?? '').split(':').some((p) => existsSync(join(p, t))))
  if (!found) throw new Error('No terminal found: open one and run "claude", then type /login.')
  spawn(found[0], found[1], { detached: true, stdio: 'ignore', env }).unref()
}
