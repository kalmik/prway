// Knowledge base: what merged PRs changed and what reviewers decided, so later reviews of the
// same code can see it.
//
// Layout (a local git repo, so every change is versioned and can be reviewed with git log/diff):
//   ~/.prway/kb/<owner>/<repo>/entries/pr-<n>.json   one entry per merged PR (source of truth)
//   ~/.prway/kb/<owner>/<repo>/<domain>.md           readable notes per domain, rebuilt from the entries
//
// Entries come from PRs you opened in PRway (guide or worktree), once GitHub says they merged.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KbEntry, KbMatch, KbStatus, ReviewGuide } from '../../shared/types'
import type { GitHub } from '../github/api'
import { getMergeInfo, listPrFiles, listReviews, listThreads } from '../github/pulls'
import { catFiles, git, type WorktreeManager } from '../git/worktrees'
import { changedNewLines, outline, symbolAt } from '../code/symbols'
import { EMPTY_RULES, generatedReason, matchGlob, type RepoRules } from '../review/noise'
import { dataDir } from '../store'

const SYNC_EVERY_MS = 15 * 60 * 1000
const ROOT_DIRS = new Set(['src', 'lib', 'app', 'apps', 'packages', 'internal', 'pkg', 'cmd', 'test', 'tests', 'spec', 'priv', 'source'])

export function kbDir(repo: string): string {
  return join(dataDir, 'kb', repo)
}

/** Groups a path into a domain: .prway.json "domains" first, else the first two folders below src/lib/app/test... */
export function domainFor(path: string, rules: RepoRules = EMPTY_RULES): string {
  const rule = rules.domains.find((d) => matchGlob(path, d.path))
  if (rule) return rule.domain
  const parts = path.split('/')
  const dirs = parts.slice(0, -1)
  while (dirs.length && ROOT_DIRS.has(dirs[0])) dirs.shift()
  // apps/<name>/lib/<name>/... and packages/<name>/src/...: drop the inner root and repeated names.
  const clean = dirs.filter((d, i) => !(i > 0 && (ROOT_DIRS.has(d) || d === dirs[i - 1] || d === dirs[i - 2])))
  // Shallow paths: the file name (without test suffixes) is the next level, so code and its tests group together.
  if (clean.length < 2 && clean.length > 0) {
    const stem = parts.at(-1)!.replace(/\.[^.]+$/, '').replace(/([._-](test|spec))$/i, '').replace(/^test_/, '')
    clean.push(stem)
  }
  const name = clean.slice(0, 2).join('-')
  return (name || 'root').replace(/[^\w.-]+/g, '_').toLowerCase()
}

/** GitHub text without HTML, HTML comments and markdown noise, on one line. */
export function cleanText(text: string, max = 500): string {
  const t = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/<[^>]*$/, ' ') // a tag cut off by an earlier truncation
    .replace(/^\s*[-*] \[[ x]\].*$/gim, ' ') // checklists
    .replace(/[#*_`>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** The first paragraph of a PR description that says something (not a heading, template or checklist). */
export function descriptionIntent(body: string | null, title: string): string {
  const paragraphs = (body ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#{1,6}\s/.test(p) && !/^\s*[-*] \[[ x]\]/m.test(p) && cleanText(p).length > 30)
  return paragraphs[0] ? cleanText(paragraphs[0], 500) : title
}

const isBot = (login: string) => /\[bot\]$|-bot$|^dependabot|^renovate/i.test(login)

/** Applies today's cleaning to entries saved by older versions. */
function normalizeEntry(e: KbEntry): KbEntry {
  const intent = /^#{1,6}\s/.test(e.intent.trim()) || cleanText(e.intent).length < 10 ? e.title : cleanText(e.intent, 600)
  return {
    ...e,
    intent,
    decisions: e.decisions
      .map((d) => ({ ...d, body: cleanText(d.body, 400) }))
      .filter((d) => !(isBot(d.reviewer) && (d.state === 'COMMENTED' || !d.body))),
    discussions: e.discussions.map((d) => ({ ...d, body: cleanText(d.body, 300) })).filter((d) => d.body)
  }
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** pr-<n> folder names under a directory. */
export function prNumbersIn(dir: string): number[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((d) => /^pr-(\d+)$/.exec(d)?.[1])
    .filter((n): n is string => !!n)
    .map(Number)
}

export class KnowledgeBase {
  private lastSync = new Map<string, { at: number; added: number }>()
  private rebuiltOnce = new Set<string>()
  private syncing = new Map<string, Promise<KbStatus>>()
  /** PRs already checked and found not merged, with when, so they are not re-checked too often. */
  private openChecked = new Map<string, number>()

  constructor(
    private worktrees: WorktreeManager,
    private getGh: () => GitHub | null
  ) {}

  entries(repo: string): KbEntry[] {
    const dir = join(kbDir(repo), 'entries')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<KbEntry>(join(dir, f)))
      .filter((e): e is KbEntry => !!e)
      .map(normalizeEntry)
  }

  status(repo: string): KbStatus {
    const last = this.lastSync.get(repo)
    return {
      entries: this.entries(repo).length,
      folder: kbDir(repo),
      lastSync: last ? new Date(last.at).toISOString() : null,
      added: last?.added ?? 0
    }
  }

  /** Starts a sync if the last one is old enough; never throws. */
  syncInBackground(repo: string): void {
    const last = this.lastSync.get(repo)
    if (last && Date.now() - last.at < SYNC_EVERY_MS) return
    this.sync(repo).catch((err) => console.warn('[kb] sync failed:', (err as Error).message))
  }

  sync(repo: string): Promise<KbStatus> {
    const running = this.syncing.get(repo)
    if (running) return running
    const p = this.doSync(repo).finally(() => this.syncing.delete(repo))
    this.syncing.set(repo, p)
    return p
  }

  private async doSync(repo: string): Promise<KbStatus> {
    const gh = this.getGh()
    if (!gh) throw new Error('Not signed in')
    const known = new Set(this.entries(repo).map((e) => e.number))
    const candidates = [
      ...new Set([...prNumbersIn(join(dataDir, 'guides', repo)), ...prNumbersIn(join(dataDir, 'worktrees', repo))])
    ].filter((n) => !known.has(n))

    const added: KbEntry[] = []
    for (const n of candidates.slice(0, 30)) {
      const checked = this.openChecked.get(`${repo}#${n}`)
      if (checked && Date.now() - checked < SYNC_EVERY_MS) continue
      try {
        const info = await getMergeInfo(gh, repo, n)
        if (!info.merged) {
          this.openChecked.set(`${repo}#${n}`, Date.now())
          continue
        }
        added.push(await this.buildEntry(gh, repo, n, info))
      } catch (err) {
        console.warn(`[kb] skipping #${n}:`, (err as Error).message)
      }
    }
    if (added.length) this.write(repo, added)
    else if (!this.rebuiltOnce.has(repo)) {
      // Once per run: apply the current format to notes written by older versions.
      this.rebuiltOnce.add(repo)
      this.rebuild(repo)
    }
    this.lastSync.set(repo, { at: Date.now(), added: added.length })
    return this.status(repo)
  }

  private latestGuide(repo: string, number: number, headSha: string): ReviewGuide | null {
    const dir = join(dataDir, 'guides', repo, `pr-${number}`)
    if (!existsSync(dir)) return null
    const exact = readJson<ReviewGuide>(join(dir, `${headSha}.json`))
    if (exact) return exact
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0]
    return newest ? readJson<ReviewGuide>(join(dir, newest)) : null
  }

  private async buildEntry(gh: GitHub, repo: string, number: number, info: Awaited<ReturnType<typeof getMergeInfo>>): Promise<KbEntry> {
    const guide = this.latestGuide(repo, number, info.headSha)
    const [files, reviews, threads] = await Promise.all([
      listPrFiles(gh, repo, number),
      listReviews(gh, repo, number).catch(() => []),
      listThreads(gh, repo, number).catch(() => [])
    ])
    const reviewable = files.filter((f) => !generatedReason(f.path))
    const symbols = await this.symbolsFromPatches(repo, info.headSha, reviewable)
    const rules = this.rulesFor(repo, number)

    return {
      repo,
      number,
      title: info.title,
      url: info.url,
      author: info.author,
      mergedAt: info.mergedAt ?? new Date().toISOString(),
      intent: guide?.intent ?? descriptionIntent(info.body, info.title),
      rules: guide?.businessRules ?? [],
      decisions: reviews
        .filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED' || r.body.trim())
        .map((r) => ({ reviewer: r.reviewer, state: r.state, body: r.body.trim().slice(0, 800) })),
      discussions: threads.slice(0, 20).map((t) => ({
        path: t.path,
        line: t.line,
        resolved: t.resolved,
        author: t.comments[0]?.author ?? 'ghost',
        body: (t.comments[0]?.body ?? '').slice(0, 500)
      })),
      files: reviewable.map((f) => f.path),
      symbols,
      domains: [...new Set(reviewable.map((f) => domainFor(f.path, rules)))]
    }
  }

  /** .prway.json rules from the last prepare of this PR, when PRway still has them in memory. */
  private rulesFor(repo: string, number: number): RepoRules {
    try {
      return this.worktrees.prRefs(repo, number).rules
    } catch {
      return EMPTY_RULES
    }
  }

  /** "path#name" for each function the PR changed, from GitHub's patches and the head file contents. */
  private async symbolsFromPatches(repo: string, headSha: string, files: { path: string; patch: string }[]): Promise<string[]> {
    const withPatch = files.filter((f) => f.patch).slice(0, 60)
    const specs = withPatch.map((f) => `${headSha}:${f.path}`)
    const blobs = await catFiles(this.worktrees.repoDir(repo), specs, this.worktrees.tokenOrNull()).catch(
      () => new Map<string, Buffer | null>()
    )
    const out = new Set<string>()
    for (const f of withPatch) {
      const blob = blobs.get(`${headSha}:${f.path}`)
      if (!blob || blob.length > 2 * 1024 * 1024) continue
      const syms = outline(f.path, blob.toString('utf8'))
      for (const line of changedNewLines(f.patch)) {
        const s = symbolAt(syms, line)
        if (s && s.kind !== 'module' && s.kind !== 'class') out.add(`${f.path}#${s.name}`)
      }
    }
    return [...out]
  }

  /** Rebuilds the markdown files from the entries (e.g. after a format change). */
  rebuild(repo: string): void {
    if (this.entries(repo).length) this.write(repo, [])
  }

  private write(repo: string, added: KbEntry[]): void {
    const root = kbDir(repo)
    mkdirSync(join(root, 'entries'), { recursive: true })
    for (const e of added) writeFileSync(join(root, 'entries', `pr-${e.number}.json`), JSON.stringify(e, null, 2) + '\n')

    const all = this.entries(repo).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    const touched = new Set(all.flatMap((e) => e.domains))
    for (const domain of touched) {
      const md = renderDomain(repo, domain, all.filter((e) => e.domains.includes(domain)))
      writeFileSync(join(root, `${domain}.md`), md)
    }
    void this.commit(root, added).catch((err) => console.warn('[kb] git commit failed:', (err as Error).message))
  }

  private async commit(root: string, added: KbEntry[]): Promise<void> {
    if (!existsSync(join(root, '.git'))) await git(['init', '-q'], root)
    await git(['add', '-A'], root)
    // Nothing changed (e.g. notes rebuilt to the same text): no commit.
    if (!(await git(['status', '--porcelain'], root)).trim()) return
    const msg = !added.length
      ? 'Rebuild notes'
      : added.length === 1
        ? `Add #${added[0].number}: ${added[0].title}`
        : `Add ${added.length} merged PRs`
    await git(['-c', 'user.name=PRway', '-c', 'user.email=prway@localhost', 'commit', '-q', '-m', msg], root)
  }

  /** Entries about the same files or functions as `files` / `symbols`, best matches first. */
  related(repo: string, number: number, files: string[], symbols: string[]): KbMatch[] {
    const fileSet = new Set(files)
    const symSet = new Set(symbols)
    return this.entries(repo)
      .filter((e) => e.number !== number)
      .map((entry) => ({
        entry,
        files: entry.files.filter((f) => fileSet.has(f)),
        symbols: entry.symbols.filter((s) => symSet.has(s))
      }))
      .filter((m) => m.files.length || m.symbols.length)
      .sort(
        (a, b) =>
          b.symbols.length * 3 + b.files.length - (a.symbols.length * 3 + a.files.length) ||
          b.entry.mergedAt.localeCompare(a.entry.mergedAt)
      )
      .slice(0, 10)
  }
}

const STATE_TEXT: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'commented',
  DISMISSED: 'review dismissed'
}

const quote = (s: string) => s.replace(/\s+/g, ' ').trim()

export function renderEntry(e: KbEntry): string {
  const out = [
    `## #${e.number} ${e.title}`,
    '',
    `Merged ${e.mergedAt.slice(0, 10)} · author ${e.author} · [PR](${e.url})`,
    '',
    `**Intent:** ${quote(e.intent)}`
  ]
  if (e.rules.length) {
    out.push('', '**Business rules**')
    for (const r of e.rules) out.push(`- \`${r.path}${r.line ? `:${r.line}` : ''}\` ${quote(r.rule)} — ${quote(r.change)}`)
  }
  if (e.decisions.length || e.discussions.length) {
    out.push('', '**Review decisions**')
    for (const d of e.decisions) out.push(`- ${d.reviewer} ${STATE_TEXT[d.state] ?? d.state.toLowerCase()}${d.body ? `: "${quote(d.body)}"` : ''}`)
    for (const t of e.discussions) {
      out.push(`- On \`${t.path}${t.line ? `:${t.line}` : ''}\` (${t.resolved ? 'resolved' : 'open'}), ${t.author}: "${quote(t.body)}"`)
    }
  }
  const shown = e.files.slice(0, 15).map((f) => `\`${f}\``)
  if (e.files.length > 15) shown.push(`and ${e.files.length - 15} more`)
  out.push('', `**Files:** ${shown.join(', ') || '—'}`)
  if (e.symbols.length) out.push(`**Functions:** ${[...new Set(e.symbols.map((s) => s.split('#')[1]))].map((n) => `\`${n}\``).join(', ')}`)
  return out.join('\n')
}

function renderDomain(repo: string, domain: string, entries: KbEntry[]): string {
  return [
    `# ${domain}`,
    '',
    `_Knowledge base for ${repo}, built by PRway from merged pull requests (newest first). Edit the JSON in entries/, not this file._`,
    '',
    entries.map(renderEntry).join('\n\n---\n\n'),
    ''
  ].join('\n')
}

/** Short text for the AI guide prompt. */
export function kbPromptText(matches: KbMatch[]): string {
  return matches
    .slice(0, 5)
    .map(({ entry: e, files, symbols }) => {
      const rules = e.rules.slice(0, 4).map((r) => `  rule: ${quote(r.rule)} (${quote(r.change)})`)
      const decisions = e.discussions
        .slice(0, 3)
        .map((d) => `  review note on ${d.path}: ${quote(d.body).slice(0, 200)}`)
      return [
        `- #${e.number} ${e.title} (merged ${e.mergedAt.slice(0, 10)}), touched ${symbols.length ? [...new Set(symbols.map((s) => s.split('#')[1]))].join(', ') : files.join(', ')}`,
        `  intent: ${quote(e.intent).slice(0, 300)}`,
        ...rules,
        ...decisions
      ].join('\n')
    })
    .join('\n')
}
