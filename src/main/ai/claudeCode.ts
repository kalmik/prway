// Uses the Claude Code CLI you already have installed and signed in, so requests run on your
// Claude subscription (Pro/Max) instead of an API key. Runs `claude -p` in headless mode with
// every tool, MCP server and user setting turned off: it only reads the prompt and answers.

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dataDir } from '../store'
import type { AiProvider, StructuredRequest } from './provider'

const TIMEOUT_MS = 15 * 60 * 1000

interface CliResult {
  is_error?: boolean
  subtype?: string
  result?: string
  structured_output?: unknown
}

export class ClaudeCodeProvider implements AiProvider {
  readonly id = 'claude-code' as const

  constructor(private command = process.env.DIFFSCOPE_CLAUDE_BIN || 'claude') {}

  generate<T>(req: StructuredRequest): Promise<T> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--json-schema', JSON.stringify(req.schema),
      '--system-prompt', req.system,
      '--model', req.model,
      '--effort', req.effort,
      '--tools', '',
      '--no-session-persistence',
      '--setting-sources', '',
      '--strict-mcp-config'
    ]
    mkdirSync(dataDir, { recursive: true })

    return new Promise<T>((resolve, reject) => {
      // Run from Diffscope's data folder so no project CLAUDE.md is picked up.
      const child = spawn(this.command, args, { cwd: dataDir, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
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

      child.stdin.end(req.prompt)
    })
  }
}
