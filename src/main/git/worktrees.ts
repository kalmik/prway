// One git worktree per pull request, so several PRs can be reviewed at once
// without switching branches.
//
// Layout under ~/.prway:
//   repos/<owner>/<name>.git          bare, partial clone (file contents are downloaded on demand)
//   worktrees/<owner>/<name>/pr-<n>   checkout of the PR head, open it in any IDE
//
// PR refs are fetched into refs/prway/* so they never clash with real branches.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangedFile, FileDiff, FileStatus, WorktreeInfo } from '../../shared/types'
import { classify, parseCheckAttr, parseNumstat, type NoiseInput } from '../review/noise'
import { dataDir } from '../store'

const MAX_FILE_BYTES = 2 * 1024 * 1024

interface PrRefs {
  headSha: string
  mergeBase: string
}

/** The token goes through environment variables, not the command line, so it does not show in `ps`. */
function gitEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  if (token) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
  }
  return env
}

function git(args: string[], cwd: string, token?: string): Promise<string>
function git(args: string[], cwd: string, token: string | undefined, raw: true): Promise<Buffer>
function git(args: string[], cwd: string, token?: string, raw?: boolean): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: gitEnv(token), maxBuffer: 256 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${String(stderr).trim() || err.message}`))
        else resolve(stdout)
      }
    )
  })
}

export class WorktreeManager {
  private refs = new Map<string, PrRefs>() // "owner/name#n" -> refs from the last prepare
  private locks = new Map<string, Promise<unknown>>() // one git operation at a time per repo

  constructor(private getToken: () => string | null) {}

  repoDir(repo: string): string {
    return join(dataDir, 'repos', `${repo}.git`)
  }

  worktreeDir(repo: string, number: number): string {
    return join(dataDir, 'worktrees', repo, `pr-${number}`)
  }

  /** Runs `fn` after any other git work on the same repo has finished. */
  private withLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    this.locks.set(repo, next)
    return next
  }

  private async ensureClone(repo: string): Promise<string> {
    const dir = this.repoDir(repo)
    if (!existsSync(dir)) {
      mkdirSync(join(dir, '..'), { recursive: true })
      await git(
        ['clone', '--bare', '--filter=blob:none', `https://github.com/${repo}.git`, dir],
        dataDir,
        this.token()
      )
    }
    return dir
  }

  private token(): string {
    const t = this.getToken()
    if (!t) throw new Error('Not signed in')
    return t
  }

  /** Fetches the PR, creates or updates its worktree and lists the changed files. */
  prepare(repo: string, number: number, baseRef: string): Promise<WorktreeInfo> {
    return this.withLock(repo, async () => {
      const dir = await this.ensureClone(repo)
      const prRef = `refs/prway/pr/${number}`
      const baseLocal = `refs/prway/base/${baseRef}`

      await git(
        ['fetch', '--force', '--no-tags', 'origin', `+refs/pull/${number}/head:${prRef}`, `+refs/heads/${baseRef}:${baseLocal}`],
        dir,
        this.token()
      )
      const headSha = (await git(['rev-parse', prRef], dir)).trim()
      // Same comparison GitHub shows: from where the PR branched off, to the PR head.
      const mergeBase = (await git(['merge-base', baseLocal, headSha], dir)).trim()

      const wt = this.worktreeDir(repo, number)
      if (!existsSync(wt)) {
        mkdirSync(join(wt, '..'), { recursive: true })
        await git(['worktree', 'add', '--detach', wt, headSha], dir, this.token())
      } else {
        // Fails on purpose if you edited files in the worktree that clash with new PR commits.
        await git(['checkout', '--detach', headSha], wt, this.token())
      }

      const range = [mergeBase, headSha]
      const [nameStatus, numstat, numstatNoWs] = await Promise.all([
        git(['diff', '--name-status', '-z', '-M', ...range], dir, this.token()),
        git(['diff', '--numstat', '-z', '-M', ...range], dir, this.token()),
        git(['diff', '--numstat', '-z', '-M', '-w', '--ignore-blank-lines', ...range], dir, this.token())
      ])
      const raw = parseNameStatus(nameStatus)
      // .gitattributes rules are read from the PR worktree.
      const attrs = raw.length
        ? await git(['check-attr', '-z', 'linguist-generated', '--', ...raw.map((f) => f.path)], wt)
        : ''
      const files = classify({
        files: raw,
        numstat: parseNumstat(numstat),
        numstatNoWhitespace: parseNumstat(numstatNoWs),
        linguistGenerated: parseCheckAttr(attrs)
      })
      this.refs.set(`${repo}#${number}`, { headSha, mergeBase })
      return { path: wt, headSha, mergeBase, files }
    })
  }

  async fileDiff(repo: string, number: number, file: ChangedFile): Promise<FileDiff> {
    const refs = this.requireRefs(repo, number)
    const dir = this.repoDir(repo)

    type Side = { text: string; skipped?: FileDiff['skipped'] }
    const empty: Side = { text: '' }
    const read = async (rev: string, path: string): Promise<Side> => {
      const buf = await git(['show', `${rev}:${path}`], dir, this.token(), true)
      if (buf.length > MAX_FILE_BYTES) return { text: '', skipped: 'too-large' }
      if (buf.subarray(0, 8000).includes(0)) return { text: '', skipped: 'binary' }
      return { text: buf.toString('utf8') }
    }

    const [before, after] = await Promise.all([
      file.status === 'A' ? empty : read(refs.mergeBase, file.oldPath ?? file.path),
      file.status === 'D' ? empty : read(refs.headSha, file.path)
    ])
    const skipped = before.skipped ?? after.skipped
    return skipped ? { original: '', modified: '', skipped } : { original: before.text, modified: after.text }
  }

  private requireRefs(repo: string, number: number): PrRefs {
    const refs = this.refs.get(`${repo}#${number}`)
    if (!refs) throw new Error('Prepare the PR worktree first')
    return refs
  }

  /** Unified diff of one file, mergeBase -> head. */
  async unifiedDiff(repo: string, number: number, file: ChangedFile, context = 5): Promise<string> {
    const { mergeBase, headSha } = this.requireRefs(repo, number)
    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
    return git(['diff', `-U${context}`, '-M', mergeBase, headSha, '--', ...paths], this.repoDir(repo), this.token())
  }

  /** Commit messages of the PR, oldest first. */
  async commitLog(repo: string, number: number, max = 50): Promise<string> {
    const { mergeBase, headSha } = this.requireRefs(repo, number)
    return git(
      ['log', '--reverse', `--max-count=${max}`, '--format=- %s%n%b', `${mergeBase}..${headSha}`],
      this.repoDir(repo)
    )
  }

  headSha(repo: string, number: number): string | null {
    return this.refs.get(`${repo}#${number}`)?.headSha ?? null
  }

  remove(repo: string, number: number): Promise<void> {
    return this.withLock(repo, async () => {
      const wt = this.worktreeDir(repo, number)
      if (existsSync(wt)) await git(['worktree', 'remove', '--force', wt], this.repoDir(repo))
      this.refs.delete(`${repo}#${number}`)
    })
  }
}

/** Parses `git diff --name-status -z` output. Renames and copies carry two paths and a similarity score (R100 = identical). */
function parseNameStatus(out: string): NoiseInput['files'] {
  const parts = out.split('\0').filter(Boolean)
  const files: NoiseInput['files'] = []
  for (let i = 0; i < parts.length; ) {
    const code = parts[i++]
    const status = code[0] as FileStatus
    if (status === 'R' || status === 'C') {
      const oldPath = parts[i++]
      files.push({ status, oldPath, path: parts[i++], similarity: Number(code.slice(1)) || undefined })
    } else {
      files.push({ status, path: parts[i++] })
    }
  }
  return files
}
