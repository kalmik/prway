// Facts about the code at a commit, found with git only and cached so a second trace is nearly free:
//   file text and outline   by blob id (the same file in another PR is a hit)
//   word search (git grep)  by word + commit; for a new commit, only the files that changed since a cached
//                           commit are searched again
//   past PRs                by number, forever (merged PRs don't change)
//
// On disk: ~/.prway/trace/<owner>/<repo>/facts/...

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CodeSymbol } from '../../shared/types'
import type { GitHub } from '../github/api'
import { catFiles, git } from '../git/worktrees'
import { outline } from '../code/symbols'
import { generatedReason } from '../review/noise'
import { dataDir } from '../store'

export interface Hit {
  path: string
  line: number
  text: string
}

export interface FileFacts {
  blob: string
  lines: string[]
  symbols: CodeSymbol[]
}

export interface PrMeta {
  number: number
  title: string
  url: string
  body: string
}

const MAX_HITS = 2000
/** Above this many changed files, searching the whole tree again is simpler than patching a cached result. */
const MAX_INCREMENTAL_FILES = 400
const MAX_FILE_BYTES = 1024 * 1024

export const hash = (text: string, len = 16) => createHash('sha1').update(text).digest('hex').slice(0, len)

export function traceDir(repo: string): string {
  return join(dataDir, 'trace', repo)
}

export function readJson<T>(p: string): T | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}

export function writeJson(p: string, value: unknown): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(value))
}

/** Facts for one repo. Create one per trace run; the disk cache is shared between runs. */
export class Facts {
  stats = { fromCache: 0, computed: 0 }
  private files = new Map<string, Promise<FileFacts | null>>() // "commit:path"
  private greps = new Map<string, Promise<Hit[]>>() // "commit:word"
  private root: string

  constructor(
    private repo: string,
    /** The bare repo. */
    private dir: string,
    /** A worktree checked out at `fullGrepCommit`: the only commit searched in full (its blobs are local). */
    private worktree: string,
    private fullGrepCommit: string,
    private token?: string
  ) {
    this.root = join(traceDir(repo), 'facts')
  }

  /** Text and outline of a file at a commit, or null when it doesn't exist there (or is binary or huge). */
  file(commit: string, path: string): Promise<FileFacts | null> {
    const key = `${commit}:${path}`
    let p = this.files.get(key)
    if (!p) {
      p = this.loadFile(commit, path)
      this.files.set(key, p)
    }
    return p
  }

  private async loadFile(commit: string, path: string): Promise<FileFacts | null> {
    const spec = `${commit}:${path}`
    const blob = (await git(['rev-parse', '--verify', '--quiet', spec], this.dir).catch(() => '')).trim()
    if (!blob) return null
    const buf = (await catFiles(this.dir, [spec], this.token)).get(spec)
    if (!buf || buf.length > MAX_FILE_BYTES || buf.includes(0)) return null
    const text = buf.toString('utf8')
    return { blob, lines: text.split('\n'), symbols: outline(path, text) }
  }

  /** Lines containing `word` as a whole word at a commit (generated files left out). */
  grep(commit: string, word: string): Promise<Hit[]> {
    const key = `${commit}:${word}`
    let p = this.greps.get(key)
    if (!p) {
      p = this.loadGrep(commit, word)
      this.greps.set(key, p)
    }
    return p
  }

  private async loadGrep(commit: string, word: string): Promise<Hit[]> {
    const dir = join(this.root, 'grep', hash(word))
    const exact = readJson<Hit[]>(join(dir, `${commit}.json`))
    if (exact) {
      this.stats.fromCache++
      return exact
    }
    this.stats.computed++
    const index = readJson<string[]>(join(dir, 'index.json')) ?? []
    let hits: Hit[] | null = null
    // Patch the newest cached commit that is close enough.
    for (const from of index.slice(0, 3)) {
      const changed = await git(['diff', '--name-only', '--no-renames', from, commit], this.dir).catch(() => null)
      if (changed === null) continue
      const paths = changed.split('\n').filter(Boolean)
      if (paths.length > MAX_INCREMENTAL_FILES) continue
      const cached = readJson<Hit[]>(join(dir, `${from}.json`))
      if (!cached) continue
      const touched = new Set(paths)
      const fresh = paths.length ? await this.search(commit, word, paths) : []
      hits = [...cached.filter((h) => !touched.has(h.path)), ...fresh]
      break
    }
    if (!hits) {
      if (commit !== this.fullGrepCommit) {
        // Searching a commit that isn't checked out would download the whole tree: patch from the checked-out one.
        await this.grep(this.fullGrepCommit, word)
        return this.loadGrepAfterBase(commit, word)
      }
      hits = await this.search(commit, word, null)
    }
    hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    writeJson(join(dir, `${commit}.json`), hits)
    writeJson(join(dir, 'index.json'), [commit, ...index.filter((c) => c !== commit)].slice(0, 20))
    return hits
  }

  /** Second try after the checked-out commit was searched (it is now in the index). */
  private async loadGrepAfterBase(commit: string, word: string): Promise<Hit[]> {
    const dir = join(this.root, 'grep', hash(word))
    const changed = await git(['diff', '--name-only', '--no-renames', this.fullGrepCommit, commit], this.dir)
    const paths = changed.split('\n').filter(Boolean)
    const touched = new Set(paths)
    const cached = readJson<Hit[]>(join(dir, `${this.fullGrepCommit}.json`)) ?? []
    const fresh = paths.length ? await this.search(commit, word, paths.slice(0, MAX_INCREMENTAL_FILES)) : []
    const hits = [...cached.filter((h) => !touched.has(h.path)), ...fresh].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
    const index = readJson<string[]>(join(dir, 'index.json')) ?? []
    writeJson(join(dir, `${commit}.json`), hits)
    writeJson(join(dir, 'index.json'), [commit, ...index.filter((c) => c !== commit)].slice(0, 20))
    return hits
  }

  private async search(commit: string, word: string, paths: string[] | null): Promise<Hit[]> {
    if (!word.trim() || word.length > 200) return []
    const out = await git(
      ['grep', '--null', '-n', '-w', '-F', '-I', '--no-color', '-m', '200', '-e', word, commit, '--', ...(paths ?? [])],
      paths ? this.dir : this.worktree,
      this.token
    ).catch(() => '')
    const prefix = `${commit}:`
    const hits: Hit[] = []
    for (const row of out.split('\n')) {
      if (!row || hits.length >= MAX_HITS) continue
      const [pathPart, lineNo, ...rest] = row.split('\0')
      const path = pathPart.startsWith(prefix) ? pathPart.slice(prefix.length) : pathPart
      if (generatedReason(path)) continue
      const text = rest.join('\0')
      hits.push({ path, line: Number(lineNo), text: text.length > 300 ? text.slice(0, 300) + '…' : text })
    }
    return hits
  }

  /** Title, link and description of a PR; merged PRs don't change, so this is cached forever. */
  async pr(gh: GitHub | null, number: number): Promise<PrMeta | null> {
    const p = join(this.root, 'prs', `${number}.json`)
    const cached = readJson<PrMeta>(p)
    if (cached) {
      this.stats.fromCache++
      return cached
    }
    if (!gh) return null
    try {
      const pull = await gh.get<{ title: string; html_url: string; body: string | null; merged_at: string | null }>(
        `/repos/${this.repo}/pulls/${number}`
      )
      this.stats.computed++
      const meta = { number, title: pull.title, url: pull.html_url, body: (pull.body ?? '').slice(0, 6000) }
      if (pull.merged_at) writeJson(p, meta)
      return meta
    } catch {
      return null
    }
  }

  /** A cached value computed once per key (e.g. a function's history at a version). */
  async memo<T>(ns: string, key: string, compute: () => Promise<T>): Promise<T> {
    const p = join(this.root, ns, `${hash(key)}.json`)
    if (existsSync(p)) {
      const v = readJson<{ value: T }>(p)
      if (v) {
        this.stats.fromCache++
        return v.value
      }
    }
    this.stats.computed++
    const value = await compute()
    writeJson(p, { value })
    return value
  }
}
