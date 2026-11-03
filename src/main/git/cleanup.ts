// Removes worktrees of PRs that are no longer open (merged or closed), so ~/.prway doesn't grow forever.
// Merged PRs go into the knowledge base first: it finds them through their worktree folders.

import { join } from 'node:path'
import type { CleanupReport } from '../../shared/types'
import type { GitHub } from '../github/api'
import { getMergeInfo } from '../github/pulls'
import { prNumbersIn, type KnowledgeBase } from '../kb/knowledge'
import { dataDir } from '../store'
import type { WorktreeManager } from './worktrees'

const AUTO_EVERY_MS = 30 * 60 * 1000

export class WorktreeCleanup {
  private lastRun = new Map<string, number>()
  private running = new Map<string, Promise<CleanupReport>>()

  constructor(
    private worktrees: WorktreeManager,
    private kb: KnowledgeBase,
    private getGh: () => GitHub | null
  ) {}

  run(repo: string, keep: number[], auto = false): Promise<CleanupReport> {
    if (auto && Date.now() - (this.lastRun.get(repo) ?? 0) < AUTO_EVERY_MS) {
      return Promise.resolve({ removed: [], dirty: [], skipped: true })
    }
    const busy = this.running.get(repo)
    if (busy) return busy
    const p = this.doRun(repo, new Set(keep)).finally(() => this.running.delete(repo))
    this.running.set(repo, p)
    return p
  }

  private async doRun(repo: string, keep: Set<number>): Promise<CleanupReport> {
    const gh = this.getGh()
    if (!gh) throw new Error('Not signed in')
    this.lastRun.set(repo, Date.now())

    // Ask GitHub about each PR that has a worktree; a PR missing from the list may still be open (long lists).
    const closed: number[] = []
    for (const n of prNumbersIn(join(dataDir, 'worktrees', repo))) {
      if (keep.has(n)) continue
      try {
        if (!(await getMergeInfo(gh, repo, n)).open) closed.push(n)
      } catch (err) {
        console.warn(`[cleanup] #${n}:`, (err as Error).message) // deleted repo/PR or no access: leave it
      }
    }
    if (!closed.length) return { removed: [], dirty: [] }

    // Save merged PRs to the knowledge base before their worktree (how it finds them) disappears.
    await this.kb.sync(repo).catch((err) => console.warn('[cleanup] knowledge base sync failed:', (err as Error).message))

    const report: CleanupReport = { removed: [], dirty: [] }
    for (const n of closed) {
      try {
        if (await this.worktrees.isDirty(repo, n)) {
          report.dirty.push(n)
          continue
        }
        await this.worktrees.removeClosed(repo, n)
        report.removed.push(n)
      } catch (err) {
        console.warn(`[cleanup] could not remove #${n}:`, (err as Error).message)
      }
    }
    return report
  }
}
