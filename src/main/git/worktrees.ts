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
import type { ChangedFile, FileDiff, FileStatus, SideLines, WorktreeInfo } from '../../shared/types'
import { hunkLines } from '../code/symbols'
import {
  canonicalCode,
  classify,
  EMPTY_RULES,
  MOVED_COLOR_CONFIG,
  parseCheckAttr,
  parseMovedDiff,
  parseNumstat,
  parseRepoRules,
  tokenComparable,
  type MovedStat,
  type NoiseInput,
  type RepoRules
} from '../review/noise'
import { dataDir } from '../store'

const MAX_FILE_BYTES = 2 * 1024 * 1024
/** Files bigger than this (changed lines) are not compared token by token. */
const MAX_TOKEN_COMPARE_LINES = 3000

export interface PrRefs {
  headSha: string
  mergeBase: string
  rules: RepoRules
  moved: Map<string, MovedStat>
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

export function git(args: string[], cwd: string, token?: string): Promise<string>
export function git(args: string[], cwd: string, token: string | undefined, raw: true, input?: string): Promise<Buffer>
export function git(args: string[], cwd: string, token?: string, raw?: boolean, input?: string): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { cwd, env: gitEnv(token), maxBuffer: 256 * 1024 * 1024, encoding: raw ? 'buffer' : 'utf8' },
      (err, stdout, stderr) => {
        // `git grep` exits 1 when nothing matches: that's an empty result, not an error.
        if (err && args.includes('grep') && (err as { code?: unknown }).code === 1 && !String(stderr).trim()) {
          return resolve(raw ? Buffer.alloc(0) : '')
        }
        if (err) reject(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? args[0]} failed: ${String(stderr).trim() || err.message}`))
        else resolve(stdout)
      }
    )
    if (input !== undefined) child.stdin?.end(input)
  })
}

/** Reads many blobs in one process. Specs are "rev:path"; missing ones map to null. */
export async function catFiles(dir: string, specs: string[], token?: string): Promise<Map<string, Buffer | null>> {
  const result = new Map<string, Buffer | null>()
  if (!specs.length) return result
  const out = await git(['cat-file', '--batch'], dir, token, true, specs.join('\n') + '\n')
  let pos = 0
  for (const spec of specs) {
    const nl = out.indexOf(10, pos)
    if (nl < 0) break
    const header = out.subarray(pos, nl).toString('utf8')
    pos = nl + 1
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header)
    if (!m) {
      result.set(spec, null) // "<spec> missing" or "ambiguous"
      continue
    }
    const size = Number(m[2])
    result.set(spec, m[1] === 'blob' ? out.subarray(pos, pos + size) : null)
    pos += size + 1
  }
  return result
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
      const [nameStatus, numstat, numstatNoWs, movedOut, rules] = await Promise.all([
        git(['diff', '--name-status', '-z', '-M', ...range], dir, this.token()),
        git(['diff', '--numstat', '-z', '-M', ...range], dir, this.token()),
        git(['diff', '--numstat', '-z', '-M', '-w', '--ignore-blank-lines', ...range], dir, this.token()),
        git(
          [
            ...MOVED_COLOR_CONFIG.flatMap((c) => ['-c', c]),
            'diff', '--color=always', '--color-moved=blocks', '--color-moved-ws=allow-indentation-change', '-M', '-U0', ...range
          ],
          dir,
          this.token()
        ).catch(() => ''),
        this.repoRules(dir, mergeBase)
      ])
      const raw = parseNameStatus(nameStatus)
      // .gitattributes rules are read from the PR worktree.
      const attrs = raw.length
        ? await git(['check-attr', '-z', 'linguist-generated', '--', ...raw.map((f) => f.path)], wt)
        : ''
      const input: NoiseInput = {
        files: raw,
        numstat: parseNumstat(numstat),
        numstatNoWhitespace: parseNumstat(numstatNoWs),
        linguistGenerated: parseCheckAttr(attrs),
        rules,
        moved: parseMovedDiff(movedOut)
      }
      input.sameTokens = await this.sameTokenFiles(dir, mergeBase, headSha, input)
      const files = classify(input)
      this.refs.set(`${repo}#${number}`, { headSha, mergeBase, rules, moved: input.moved! })
      return { path: wt, headSha, mergeBase, files }
    })
  }

  /** .prway.json from the PR base: a PR cannot change the rules that apply to itself. */
  private async repoRules(dir: string, mergeBase: string): Promise<RepoRules> {
    const blob = (await catFiles(dir, [`${mergeBase}:.prway.json`], this.token())).get(`${mergeBase}:.prway.json`)
    if (!blob) return EMPTY_RULES
    try {
      return parseRepoRules(blob.toString('utf8'))
    } catch (err) {
      console.warn('[noise] ignoring invalid .prway.json:', (err as Error).message)
      return EMPTY_RULES
    }
  }

  /** Modified files whose old and new versions have the same code tokens (formatting-only changes). */
  private async sameTokenFiles(dir: string, mergeBase: string, headSha: string, input: NoiseInput): Promise<Set<string>> {
    const candidates = input.files.filter((f) => {
      if ((f.status !== 'M' && f.status !== 'R') || !tokenComparable(f.path)) return false
      const st = input.numstat.get(f.path)
      return !!st && st.additions !== null && (st.additions ?? 0) + (st.deletions ?? 0) <= MAX_TOKEN_COMPARE_LINES
    })
    const specs = candidates.flatMap((f) => [`${mergeBase}:${f.oldPath ?? f.path}`, `${headSha}:${f.path}`])
    const blobs = await catFiles(dir, specs, this.token()).catch(() => new Map<string, Buffer | null>())
    const same = new Set<string>()
    for (const f of candidates) {
      const a = blobs.get(`${mergeBase}:${f.oldPath ?? f.path}`)
      const b = blobs.get(`${headSha}:${f.path}`)
      if (!a || !b || a.length > MAX_FILE_BYTES || b.length > MAX_FILE_BYTES) continue
      if (canonicalCode(a.toString('utf8'), f.path) === canonicalCode(b.toString('utf8'), f.path)) same.add(f.path)
    }
    return same
  }

  /** Refs and rules from the last prepare; throws if the PR was not prepared. */
  prRefs(repo: string, number: number): PrRefs {
    return this.requireRefs(repo, number)
  }

  /** The PR's .prway.json rules from its last prepare, or null when not prepared in this session. */
  rulesOrNull(repo: string, number: number): RepoRules | null {
    return this.refs.get(`${repo}#${number}`)?.rules ?? null
  }

  tokenOrNull(): string | undefined {
    return this.getToken() ?? undefined
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

    const paths = file.oldPath ? [file.oldPath, file.path] : [file.path]
    const [before, after, hunks] = await Promise.all([
      file.status === 'A' ? empty : read(refs.mergeBase, file.oldPath ?? file.path),
      file.status === 'D' ? empty : read(refs.headSha, file.path),
      // GitHub shows 3 lines of context, so those are the lines it accepts comments on.
      git(['diff', '-U3', '-M', refs.mergeBase, refs.headSha, '--', ...paths], dir, this.token()).catch(() => '')
    ])
    const commentable = hunkLines(hunks)
    const mv = refs.moved.get(file.path)
    const moved: SideLines = { left: mv?.left ?? [], right: mv?.right ?? [] }
    const skipped = before.skipped ?? after.skipped
    return skipped
      ? { original: '', modified: '', skipped, commentable, moved }
      : { original: before.text, modified: after.text, commentable, moved }
  }

  /** Downloads, in one request, the file contents a partial clone is missing for `path`'s recent history. */
  async prefetchHistory(repo: string, rev: string, path: string, commits = 80): Promise<void> {
    const dir = this.repoDir(repo)
    const listing = await git(['rev-list', '--objects', '--missing=print', `--max-count=${commits}`, rev, '--', path], dir)
    const missing = listing
      .split('\n')
      .filter((l) => l.startsWith('?'))
      .map((l) => l.slice(1).trim())
    if (!missing.length) return
    await this.withLock(repo, () =>
      git(
        ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'],
        dir,
        this.token(),
        true,
        missing.join('\n') + '\n'
      )
    )
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

  /** True when the worktree has changes you made (modified, staged or untracked files that aren't ignored). */
  async isDirty(repo: string, number: number): Promise<boolean> {
    const wt = this.worktreeDir(repo, number)
    if (!existsSync(wt)) return false
    return (await git(['status', '--porcelain', '--untracked-files=normal'], wt)).trim().length > 0
  }

  /** Removes a closed PR's worktree and its ref, so git can reclaim the space later. */
  async removeClosed(repo: string, number: number): Promise<void> {
    await this.remove(repo, number)
    await this.withLock(repo, async () => {
      const dir = this.repoDir(repo)
      await git(['update-ref', '-d', `refs/prway/pr/${number}`], dir).catch(() => undefined)
      await git(['worktree', 'prune'], dir).catch(() => undefined)
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
