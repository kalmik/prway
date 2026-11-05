// Uses the Claude Code CLI you already have installed and signed in, so requests run on your
// Claude subscription (Pro/Max) instead of an API key. Runs `claude -p` in headless mode with
// every MCP server and user setting turned off. Tools are off too, except read-only Read/Grep/Glob over the
// PR's checkout when the request asks for code access (the chat).

import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { dataDir } from '../store'
import type { ClaudeSignIn } from '../../shared/types'
import type { AiProvider, StructuredRequest } from './provider'

const TIMEOUT_MS = 15 * 60 * 1000

interface CliResult {
  is_error?: boolean
  subtype?: string
  result?: string
  structured_output?: unknown
}

const DEFAULT_DIR = join(homedir(), '.claude')

/** A config folder as Claude Code would use it: `dir` (with ~), else CLAUDE_CONFIG_DIR, else ~/.claude. */
export function resolveClaudeDir(dir: string | null): string {
  const raw = dir?.trim() || process.env.CLAUDE_CONFIG_DIR || DEFAULT_DIR
  return resolve(raw.replace(/^~(?=$|\/)/, homedir()))
}

/** The environment for `claude` with an account's config folder (~/.claude is the default: no variable). */
function claudeEnv(dir: string | null): NodeJS.ProcessEnv {
  const resolved = resolveClaudeDir(dir)
  const env = { ...process.env }
  if (resolved === DEFAULT_DIR) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = resolved
  return env
}

/**
 * Who a config folder is signed in as, from Claude Code's own state file (~/.claude.json for the default folder,
 * <folder>/.claude.json otherwise). Only for display; nothing secret is read.
 */
export function claudeSignIn(dir: string | null): ClaudeSignIn {
  const resolved = resolveClaudeDir(dir)
  const file = resolved === DEFAULT_DIR ? join(homedir(), '.claude.json') : join(resolved, '.claude.json')
  try {
    const account = (JSON.parse(readFileSync(file, 'utf8')) as { oauthAccount?: { emailAddress?: string; organizationName?: string } })
      .oauthAccount
    return { dir: resolved, email: account?.emailAddress ?? null, organization: account?.organizationName ?? null }
  } catch {
    return { dir: resolved, email: null, organization: null }
  }
}

export class ClaudeCodeProvider implements AiProvider {
  readonly id = 'claude-code' as const

  constructor(
    /** The account's config folder (null: Claude Code's default). */
    private configDir: string | null = null,
    private command = process.env.PRWAY_CLAUDE_BIN || 'claude'
  ) {}

  generate<T>(req: StructuredRequest): Promise<T> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(req.schema),
      '--system-prompt', req.system,
      '--model', req.model,
      '--effort', req.effort,
      // Code access: read-only tools, allowed only in the PR's checkout; anything else is denied, not asked.
      ...(req.code
        ? ['--tools', 'Read,Grep,Glob', '--add-dir', req.code.dir, '--permission-mode', 'dontAsk']
        : ['--tools', '']),
      // A session (chat) is kept so follow-ups only send the new question; one-off requests leave nothing behind.
      ...(req.session ? (req.session.resume ? ['--resume', req.session.id] : ['--session-id', req.session.id]) : ['--no-session-persistence']),
      '--setting-sources', '',
      '--strict-mcp-config'
    ]
    // Run from an empty folder so no project CLAUDE.md is picked up and the tools can't read PRway's own data.
    const cwd = join(dataDir, 'claude-cwd')
    mkdirSync(cwd, { recursive: true })

    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.command, args, { cwd, env: claudeEnv(this.configDir), stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new Error('Claude Code took longer than 15 minutes and was stopped.'))
      }, TIMEOUT_MS)

      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer)
        reject(
          new Error(
            err.code === 'ENOENT'
              ? 'The "claude" command was not found. Install Claude Code and sign in, or switch to the API key provider.'
              : `Could not start Claude Code: ${err.message}`
          )
        )
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        let parsed: CliResult
        try {
          parsed = JSON.parse(stdout) as CliResult
        } catch {
          return reject(new Error(`Claude Code failed (exit ${code}): ${(stderr || stdout).trim().slice(0, 500)}`))
        }
        if (parsed.is_error || parsed.structured_output === undefined) {
          return reject(new Error(`Claude Code: ${parsed.result ?? parsed.subtype ?? 'no structured answer'}`))
        }
        resolve(parsed.structured_output as T)
      })

      child.stdin.end(req.session?.resume ? req.prompt : (req.prefix ?? '') + req.prompt)
    })
  }
}
