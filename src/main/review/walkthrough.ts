// File-by-file review walkthrough: for one file, a summary, hints, related code and a note per hunk.
// Made on demand (the UI asks for the file you are on, and prepares the next one), saved per head commit.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChangedFile, FileWalkthrough, Hunk, PullDetail } from '../../shared/types'
import { getAiSettings, getProvider } from '../ai/provider'
import type { CodeNavigator } from '../code/navigator'
import { outline, symbolAt } from '../code/symbols'
import { catFiles, git, type WorktreeManager } from '../git/worktrees'
import { dataDir } from '../store'
import { loadGuide } from './guide'
import { triageHunk } from './triage'
import {
  buildWalkthroughPrompt,
  normalizeHunks,
  parseHunks,
  WALKTHROUGH_SCHEMA,
  WALKTHROUGH_SYSTEM,
  type HunkWithText,
  type ModelWalkthrough
} from './walkthroughPrompt'

const EFFORT_CAP = { low: 'low', medium: 'medium', high: 'medium', xhigh: 'medium', max: 'medium' } as const

function cachePath(repo: string, number: number, headSha: string, path: string): string {
  const id = createHash('sha1').update(path).digest('hex').slice(0, 16)
  // "v2": behaviour-only explanations with trivial verdicts; older, wordier walkthroughs are not reused.
  return join(dataDir, 'guides', repo, `pr-${number}`, 'files-v2', headSha, `${id}.json`)
}

export class Walkthroughs {
  /** Same file requested twice (prefetch + click): one model call. */
  private inFlight = new Map<string, Promise<FileWalkthrough>>()

  constructor(
    private worktrees: WorktreeManager,
    private navigator: CodeNavigator
  ) {}

  /** Hunks of every file, from one `git diff` (3 lines of context, like GitHub). */
  async allHunks(repo: string, number: number): Promise<Map<string, HunkWithText[]>> {
    const { mergeBase, headSha } = this.worktrees.prRefs(repo, number)
    const dir = this.worktrees.repoDir(repo)
    const out = await git(['-c', 'core.quotePath=false', 'diff', '-U3', '-M', mergeBase, headSha], dir, this.worktrees.tokenOrNull())
    const files = parseHunks(out)
    // Pre-approval rules (imports, comments, formatting, moved code) on every hunk.
    const { moved } = this.worktrees.prRefs(repo, number)
    for (const [p, hs] of files) {
      const mv = moved.get(p)
      const sets = mv ? { left: new Set(mv.left), right: new Set(mv.right) } : undefined
      for (const h of hs) {
        const auto = triageHunk(p, h.changes, sets)
        if (auto) h.auto = auto
      }
    }
    // git's hunk header is often the enclosing module; name the hunk after the function it changes instead.
    const paths = [...files.keys()]
    const blobs = await catFiles(dir, paths.map((p) => `${headSha}:${p}`), this.worktrees.tokenOrNull()).catch(() => new Map<string, Buffer | null>())
    for (const p of paths) {
      const blob = blobs.get(`${headSha}:${p}`)
      if (!blob || blob.length > 2 * 1024 * 1024) continue
      const symbols = outline(p, blob.toString('utf8'))
      for (const h of files.get(p)!) {
        const firstChange = h.newLines ? Math.min(h.newStart + 3, h.newStart + h.newLines - 1) : h.newStart
        const s = symbolAt(symbols, firstChange)
        if (s && s.kind !== 'module' && s.kind !== 'class') h.header = `${s.kind} ${s.name}`
      }
    }
    return files
  }

  async hunksForUi(repo: string, number: number): Promise<Record<string, Hunk[]>> {
    const all = await this.allHunks(repo, number)
    return Object.fromEntries([...all].map(([p, hs]) => [p, hs.map(({ text: _t, changes: _c, ...h }) => h)]))
  }

  /** Makes the missing walkthroughs, two at a time. Returns how many were made. */
  async prepareAll(pull: PullDetail, files: ChangedFile[], paths: string[]): Promise<number> {
    const todo = paths.filter((p) => !this.cached(pull.repo, pull.number, p))
    let made = 0
    const worker = async () => {
      for (let p = todo.shift(); p; p = todo.shift()) {
        try {
          await this.generate(pull, files, p)
          made++
        } catch (err) {
          console.warn(`[walkthrough] ${p}:`, (err as Error).message)
        }
      }
    }
    await Promise.all([worker(), worker()])
    return made
  }

  cached(repo: string, number: number, path: string): FileWalkthrough | null {
    const { headSha } = this.worktrees.prRefs(repo, number)
    const p = cachePath(repo, number, headSha, path)
    if (!existsSync(p)) return null
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as FileWalkthrough
    } catch {
      return null
    }
  }

  generate(pull: PullDetail, files: ChangedFile[], path: string, regenerate = false): Promise<FileWalkthrough> {
    const key = `${pull.repo}#${pull.number}:${path}`
    if (!regenerate) {
      const saved = this.cached(pull.repo, pull.number, path)
      if (saved) return Promise.resolve(saved)
      const running = this.inFlight.get(key)
      if (running) return running
    }
    const p = this.make(pull, files, path).finally(() => this.inFlight.delete(key))
    this.inFlight.set(key, p)
    return p
  }

  private async make(pull: PullDetail, files: ChangedFile[], path: string): Promise<FileWalkthrough> {
    const { repo, number } = pull
    const { headSha } = this.worktrees.prRefs(repo, number)
    const file = files.find((f) => f.path === path)
    if (!file) throw new Error(`${path} is not part of this PR`)
    const hunks = (await this.allHunks(repo, number)).get(path) ?? []
    if (!hunks.length) throw new Error('This file has no text changes to walk through (binary, or only renamed).')

    const guide = loadGuide(repo, number, headSha)
    const context = await this.navigator.guideContext(repo, number, [file]).catch(() => '')
    const settings = getAiSettings()
    const answer = await getProvider(settings.provider).generate<ModelWalkthrough>({
      system: WALKTHROUGH_SYSTEM,
      prompt: buildWalkthroughPrompt({
        title: pull.title,
        intent: guide?.intent ?? null,
        path,
        status: file.status,
        guideFile: guide?.files.find((g) => g.path === path),
        hunks,
        context,
        otherFiles: files.filter((f) => f.path !== path && !f.noise).map((f) => f.path)
      }),
      schema: WALKTHROUGH_SCHEMA as unknown as Record<string, unknown>,
      model: settings.model,
      // One file at a time should feel quick; the guide is where the deep pass happens.
      effort: EFFORT_CAP[settings.effort]
    })

    const walkthrough: FileWalkthrough = {
      path,
      headSha,
      summary: answer.summary,
      hints: answer.hints.slice(0, 4),
      refs: await this.existingRefs(repo, headSha, answer.refs.slice(0, 6)),
      hunks: normalizeHunks(answer.hunks, hunks),
      model: settings.model,
      createdAt: new Date().toISOString()
    }
    const out = cachePath(repo, number, headSha, path)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(walkthrough, null, 2))
    return walkthrough
  }

  /** Drops references to files that don't exist at the PR head (the model can misremember a path). */
  private async existingRefs(repo: string, headSha: string, refs: FileWalkthrough['refs']): Promise<FileWalkthrough['refs']> {
    if (!refs.length) return refs
    const specs = refs.map((r) => `${headSha}:${r.path.replace(/^\.?\//, '')}`)
    const found = await catFiles(this.worktrees.repoDir(repo), specs, this.worktrees.tokenOrNull()).catch(() => null)
    if (!found) return refs
    return refs.filter((_r, i) => found.get(specs[i]) !== null).map((r) => ({ ...r, path: r.path.replace(/^\.?\//, '') }))
  }
}
