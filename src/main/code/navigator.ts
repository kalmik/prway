// Code navigation and per-function context inside a PR worktree, using git only:
//   definitions / references   `git grep -w` at the PR head, filtered by language patterns
//   changed functions          diff lines mapped onto a regex outline of the new file
//   history                    `git log -L` on the function's lines (missing blobs fetched in one batch)
//   past PRs                   PR number from the commit message, else GitHub's commit -> PRs API

import type { ChangedFile, ChangedFunction, CodeLocation, FileDiff, FunctionContext, HistoryCommit, PastPr } from '../../shared/types'
import type { GitHub } from '../github/api'
import { listReviewComments, pullsForCommit } from '../github/pulls'
import { catFiles, git, type WorktreeManager } from '../git/worktrees'
import { generatedReason } from '../review/noise'
import { changedNewLines, hunkLines, definitionKind, isTestPath, langOf, outline, qualifierMatchesPath, symbolAt } from './symbols'

const MAX_GREP_HITS = 3000
const MAX_REFERENCES = 300
const MAX_CALLERS = 100
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LINE_HISTORY_RANGE = 400

interface Hit extends CodeLocation {}

export class CodeNavigator {
  private pastPrCache = new Map<string, PastPr | null>() // "repo#n:path"
  private commitPrCache = new Map<string, number | null>() // "repo@sha"

  constructor(
    private worktrees: WorktreeManager,
    private getGh: () => GitHub | null
  ) {}

  /** Lines containing `word` as a whole word at the PR head. Generated files are left out. */
  private async grep(repo: string, number: number, word: string): Promise<{ hits: Hit[]; truncated: boolean }> {
    if (!word.trim() || word.length > 200) return { hits: [], truncated: false }
    const { headSha } = this.worktrees.prRefs(repo, number)
    const out = await git(
      ['grep', '--null', '-n', '-w', '-F', '-I', '--no-color', '-m', '200', '-e', word, headSha, '--'],
      this.worktrees.worktreeDir(repo, number)
    )
    const hits: Hit[] = []
    const prefix = `${headSha}:`
    let truncated = false
    for (const row of out.split('\n')) {
      if (!row) continue
      if (hits.length >= MAX_GREP_HITS) {
        truncated = true
        break
      }
      const [pathPart, lineNo, ...rest] = row.split('\0')
      const path = pathPart.startsWith(prefix) ? pathPart.slice(prefix.length) : pathPart
      if (generatedReason(path)) continue
      const text = rest.join('\0')
      hits.push({ path, line: Number(lineNo), text: text.length > 300 ? text.slice(0, 300) + '…' : text })
    }
    return { hits, truncated }
  }

  async definitions(repo: string, number: number, word: string, qualifier?: string): Promise<CodeLocation[]> {
    const { hits } = await this.grep(repo, number, word)
    const defs = hits.flatMap((h) => {
      const kind = definitionKind(h.path, h.text, word)
      return kind ? [{ ...h, text: h.text.trim(), kind }] : []
    })
    const score = (d: CodeLocation) =>
      (qualifier && qualifierMatchesPath(qualifier, d.path) ? 0 : 10) + (isTestPath(d.path) ? 5 : 0)
    return defs.sort((a, b) => score(a) - score(b) || a.path.localeCompare(b.path) || a.line - b.line).slice(0, 50)
  }

  async references(repo: string, number: number, word: string): Promise<{ locations: CodeLocation[]; truncated: boolean }> {
    const { hits, truncated } = await this.grep(repo, number, word)
    const refs = hits
      .filter((h) => !definitionKind(h.path, h.text, word))
      .map((h) => ({ ...h, text: h.text.trim() }))
      .sort((a, b) => Number(isTestPath(a.path)) - Number(isTestPath(b.path)) || a.path.localeCompare(b.path) || a.line - b.line)
    return { locations: refs.slice(0, MAX_REFERENCES), truncated: truncated || refs.length > MAX_REFERENCES }
  }

  async readFile(repo: string, number: number, path: string): Promise<{ text: string; skipped?: FileDiff['skipped'] }> {
    const { headSha } = this.worktrees.prRefs(repo, number)
    const blob = (await catFiles(this.worktrees.repoDir(repo), [`${headSha}:${path}`], this.worktrees.tokenOrNull())).get(
      `${headSha}:${path}`
    )
    if (!blob) throw new Error(`${path} does not exist at the PR head`)
    if (blob.length > MAX_FILE_BYTES) return { text: '', skipped: 'too-large' }
    if (blob.subarray(0, 8000).includes(0)) return { text: '', skipped: 'binary' }
    return { text: blob.toString('utf8') }
  }

  /** Every file path at the PR head. Only trees are read, so nothing is downloaded in a partial clone. */
  async listFiles(repo: string, number: number): Promise<string[]> {
    const { headSha } = this.worktrees.prRefs(repo, number)
    const out = await git(['ls-tree', '-r', '-z', '--name-only', headSha], this.worktrees.repoDir(repo), this.worktrees.tokenOrNull())
    return out.split('\0').filter(Boolean)
  }

  /** Lines of `path` at the PR head that the PR added or changed. */
  async changedLines(repo: string, number: number, path: string): Promise<number[]> {
    const { headSha, mergeBase } = this.worktrees.prRefs(repo, number)
    const diff = await git(['diff', '-U0', '-M', mergeBase, headSha, '--', path], this.worktrees.repoDir(repo), this.worktrees.tokenOrNull())
    return [...changedNewLines(diff)]
  }

  async commentableLines(repo: string, number: number, path: string): Promise<number[]> {
    const { headSha, mergeBase } = this.worktrees.prRefs(repo, number)
    const diff = await git(['diff', '-U3', '-M', mergeBase, headSha, '--', path], this.worktrees.repoDir(repo), this.worktrees.tokenOrNull())
    return hunkLines(diff).right
  }

  /** Functions (or modules, for top-level changes) that contain changed lines of `path`. */
  async changedFunctions(repo: string, number: number, path: string): Promise<ChangedFunction[]> {
    const { headSha, mergeBase } = this.worktrees.prRefs(repo, number)
    const dir = this.worktrees.repoDir(repo)
    let text: string
    try {
      const file = await this.readFile(repo, number, path)
      if (file.skipped) return []
      text = file.text
    } catch {
      return [] // deleted file
    }
    const diff = await git(['diff', '-U0', '-M', mergeBase, headSha, '--', path], dir, this.worktrees.tokenOrNull())
    const symbols = outline(path, text)
    const byKey = new Map<string, ChangedFunction>()
    for (const line of changedNewLines(diff)) {
      const s = symbolAt(symbols, line)
      if (!s) continue
      // Elixir and others define one function in several clauses: group them by name.
      const key = `${s.container ?? ''}.${s.name}.${s.kind}`
      const cur = byKey.get(key)
      if (cur) {
        cur.changedLines++
        cur.line = Math.min(cur.line, s.line)
        cur.endLine = Math.max(cur.endLine, s.endLine)
      } else byKey.set(key, { ...s, path, changedLines: 1 })
    }
    return [...byKey.values()].sort((a, b) => a.line - b.line)
  }

  async forFunction(repo: string, number: number, fn: ChangedFunction): Promise<FunctionContext> {
    const [history, usage] = await Promise.all([
      this.history(repo, number, fn).catch((err) => {
        console.warn('[context] history failed:', (err as Error).message)
        return [] as HistoryCommit[]
      }),
      this.callers(repo, number, fn)
    ])
    return { fn, history, ...usage }
  }

  private async callers(repo: string, number: number, fn: ChangedFunction) {
    const { hits, truncated } = await this.grep(repo, number, fn.name)
    const lang = langOf(fn.path)
    const lastSeg = fn.container?.split('.').pop()
    const esc = fn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const isPrivate = lang === 'elixir' && /^\s*defp\b/.test((await this.lineAt(repo, number, fn.path, fn.line)) ?? '')
    const callers = hits.filter((h) => {
      if (h.path === fn.path && h.line >= fn.line && h.line <= fn.endLine) return false
      if (definitionKind(h.path, h.text, fn.name)) return false
      // Comments, docs and type specs mention a function without calling it.
      if (/^\s*(#|\/\/|\*|\/\*|@spec\b|@doc\b|@callback\b)/.test(h.text)) return false
      if (lang === 'elixir' && h.path !== fn.path) {
        if (isPrivate) return false
        // Elixir calls go through the module: Receiving.create(...), or describe "create/2" in tests.
        const qualified = lastSeg && new RegExp(`\\b${lastSeg}\\.${esc}(?![\\w?!])`).test(h.text)
        const describe = isTestPath(h.path) && new RegExp(`describe\\s+"${esc}/\\d`).test(h.text)
        return !!(qualified || describe)
      }
      return true
    })
    const shown = callers.slice(0, MAX_CALLERS).map((h) => ({ ...h, text: h.text.trim() }))
    return {
      callers: shown.filter((h) => !isTestPath(h.path)),
      tests: shown.filter((h) => isTestPath(h.path)),
      truncated: truncated || callers.length > MAX_CALLERS
    }
  }

  private async lineAt(repo: string, number: number, path: string, line: number): Promise<string | null> {
    try {
      return (await this.readFile(repo, number, path)).text.split('\n')[line - 1] ?? null
    } catch {
      return null
    }
  }

  /** Earlier commits that touched the function's lines, newest first, with the PR they came from. */
  async history(repo: string, number: number, fn: ChangedFunction): Promise<HistoryCommit[]> {
    const { headSha, mergeBase } = this.worktrees.prRefs(repo, number)
    const dir = this.worktrees.repoDir(repo)
    // `git log -L` needs old versions of the file; a partial clone downloads them one by one otherwise.
    if (fn.endLine - fn.line <= MAX_LINE_HISTORY_RANGE) await this.worktrees.prefetchHistory(repo, mergeBase, fn.path).catch((err) => {
      console.warn('[context] prefetch failed:', (err as Error).message)
    })
    const own = new Set((await git(['rev-list', `${mergeBase}..${headSha}`], dir)).split('\n').filter(Boolean))
    // Line history (`-L`) for functions; for big ranges (a whole module) the file history is enough and far faster.
    const range = fn.endLine - fn.line <= MAX_LINE_HISTORY_RANGE
    const out = await git(
      range
        ? ['log', '-s', '--max-count=30', '--format=%H%x1f%aI%x1f%an%x1f%s', `-L${fn.line},${fn.endLine}:${fn.path}`, headSha]
        : ['log', '--max-count=30', '--format=%H%x1f%aI%x1f%an%x1f%s', headSha, '--', fn.path],
      dir,
      this.worktrees.tokenOrNull()
    )
    const commits = out
      .split('\n')
      .filter((l) => l.includes('\x1f'))
      .map((l) => {
        const [sha, date, author, subject] = l.split('\x1f')
        return { sha, date, author, subject }
      })
      .filter((c) => !own.has(c.sha))
      .slice(0, 10)

    const gh = this.getGh()
    let apiLookups = 0
    let prLookups = 0
    const result: HistoryCommit[] = []
    for (const c of commits) {
      let prNumber = /\(#(\d+)\)\s*$/.exec(c.subject)?.[1] ?? /^Merge pull request #(\d+)/.exec(c.subject)?.[1] ?? null
      if (!prNumber && gh && apiLookups < 5) {
        const key = `${repo}@${c.sha}`
        if (!this.commitPrCache.has(key)) {
          apiLookups++
          const prs = await pullsForCommit(gh, repo, c.sha).catch(() => [])
          this.commitPrCache.set(key, prs[0]?.number ?? null)
        }
        const n = this.commitPrCache.get(key)
        prNumber = n ? String(n) : null
      }
      let pr: PastPr | undefined
      if (prNumber && gh && Number(prNumber) !== number && prLookups < 4) {
        prLookups++
        pr = (await this.pastPr(gh, repo, Number(prNumber), fn.path)) ?? undefined
      }
      result.push({ ...c, pr })
    }
    return result
  }

  private async pastPr(gh: GitHub, repo: string, number: number, path: string): Promise<PastPr | null> {
    const key = `${repo}#${number}:${path}`
    if (this.pastPrCache.has(key)) return this.pastPrCache.get(key)!
    try {
      const [pull, comments] = await Promise.all([
        gh.get<{ title: string; html_url: string }>(`/repos/${repo}/pulls/${number}`),
        listReviewComments(gh, repo, number)
      ])
      const pr: PastPr = {
        number,
        title: pull.title,
        url: pull.html_url,
        comments: comments
          .filter((c) => c.path === path)
          .slice(0, 6)
          .map((c) => ({ author: c.author, body: c.body.length > 600 ? c.body.slice(0, 600) + '…' : c.body, url: c.url }))
      }
      this.pastPrCache.set(key, pr)
      return pr
    } catch {
      this.pastPrCache.set(key, null)
      return null
    }
  }

  /**
   * Repository context for the AI guide, local git only (no GitHub calls, so it stays fast):
   * changed functions with their callers and tests, and recent commits per file.
   */
  async guideContext(repo: string, number: number, files: ChangedFile[]): Promise<string> {
    const { mergeBase } = this.worktrees.prRefs(repo, number)
    const dir = this.worktrees.repoDir(repo)
    const sections: string[] = []
    let fnBudget = 40
    for (const f of files.slice(0, 25)) {
      const lines: string[] = []
      if (f.status !== 'A') {
        const log = await git(['log', '-n', '3', '--format=%as %s', mergeBase, '--', f.oldPath ?? f.path], dir).catch(() => '')
        if (log.trim()) lines.push(`recent commits: ${log.trim().split('\n').join(' | ')}`)
      }
      const fns = (await this.changedFunctions(repo, number, f.path).catch(() => [])).filter((x) => x.kind !== 'module')
      for (const fn of fns.slice(0, 6)) {
        if (fnBudget-- <= 0) break
        const { callers, tests, truncated } = await this.callers(repo, number, fn)
        const callerFiles = [...new Set(callers.map((c) => c.path))]
        const testFiles = [...new Set(tests.map((c) => c.path))]
        lines.push(
          `${fn.kind} ${fn.container ? fn.container + '.' : ''}${fn.name} (lines ${fn.line}-${fn.endLine}): ` +
            `${callers.length}${truncated ? '+' : ''} call sites in ${callerFiles.length} files` +
            (callerFiles.length ? ` (${callerFiles.slice(0, 3).join(', ')}${callerFiles.length > 3 ? ', …' : ''})` : '') +
            `; tests: ${testFiles.length ? testFiles.slice(0, 3).join(', ') : 'none found'}`
        )
      }
      if (lines.length) sections.push(`${f.path}\n${lines.map((l) => `- ${l}`).join('\n')}`)
    }
    return sections.join('\n\n')
  }
}
