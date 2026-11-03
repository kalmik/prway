// AI review guide: tells the human reviewer what the PR is for, where to look first and why.
// It does not replace the review; it points attention at business rules, risky code and
// changes the stated intent doesn't explain.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChangedFile, PullDetail, ReviewGuide } from '../../shared/types'
import { getAiSettings, getProvider } from '../ai/provider'
import type { GitHub } from '../github/api'
import type { WorktreeManager } from '../git/worktrees'
import { dataDir } from '../store'
import { buildPrompt, GUIDE_SCHEMA, normalizeFiles, SYSTEM_PROMPT, type ModelGuide } from './guidePrompt'

function guidePath(repo: string, number: number, headSha: string): string {
  return join(dataDir, 'guides', repo, `pr-${number}`, `${headSha}.json`)
}

export function loadGuide(repo: string, number: number, headSha: string): ReviewGuide | null {
  const p = guidePath(repo, number, headSha)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ReviewGuide
  } catch {
    return null
  }
}

/** Issue numbers mentioned in the PR description ("fixes #12", "#34"), same repo only. */
function linkedIssueNumbers(body: string | null, own: number): number[] {
  const nums = [...(body ?? '').matchAll(/(?:^|[\s(])#(\d+)\b/g)].map((m) => Number(m[1]))
  return [...new Set(nums)].filter((n) => n !== own).slice(0, 3)
}

async function linkedIssues(gh: GitHub, pull: PullDetail): Promise<string> {
  const parts: string[] = []
  for (const n of linkedIssueNumbers(pull.body, pull.number)) {
    try {
      const issue = await gh.get<{ title: string; body: string | null; pull_request?: unknown }>(
        `/repos/${pull.repo}/issues/${n}`
      )
      const kind = issue.pull_request ? 'PR' : 'Issue'
      parts.push(`${kind} #${n}: ${issue.title}\n${(issue.body ?? '').slice(0, 4000)}`)
    } catch {
      /* deleted or inaccessible: skip */
    }
  }
  return parts.join('\n\n')
}

export async function generateGuide(
  gh: GitHub,
  worktrees: WorktreeManager,
  pull: PullDetail,
  files: ChangedFile[],
  headSha: string
): Promise<ReviewGuide> {
  const settings = getAiSettings()
  const provider = getProvider(settings.provider)

  const review = files.filter((f) => !f.noise)
  const skipped = files.filter((f) => f.noise)
  const [issues, commits, diffs] = await Promise.all([
    linkedIssues(gh, pull),
    worktrees.commitLog(pull.repo, pull.number),
    Promise.all(review.map((f) => worktrees.unifiedDiff(pull.repo, pull.number, f)))
  ])
  const { prompt, truncatedFiles } = buildPrompt({
    pull,
    issues,
    commits,
    review: review.map((file, i) => ({ file, diff: diffs[i] })),
    skipped
  })

  const answer = await provider.generate<ModelGuide>({
    system: SYSTEM_PROMPT,
    prompt,
    schema: GUIDE_SCHEMA as unknown as Record<string, unknown>,
    model: settings.model,
    effort: settings.effort
  })
  const ordered = normalizeFiles(answer.files, review)

  const guide: ReviewGuide = {
    ...answer,
    files: ordered,
    headSha,
    provider: settings.provider,
    model: settings.model,
    createdAt: new Date().toISOString(),
    truncatedFiles
  }
  const p = guidePath(pull.repo, pull.number, headSha)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(guide, null, 2))
  return guide
}

/** A tiny request to check that the selected provider and model work. */
export async function testProvider(): Promise<string> {
  const settings = getAiSettings()
  const answer = await getProvider(settings.provider).generate<{ ok: boolean }>({
    system: 'Answer with the JSON object requested.',
    prompt: 'Return {"ok": true}.',
    schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
    model: settings.model,
    effort: 'low'
  })
  if (!answer.ok) throw new Error('Unexpected answer from the model')
  return `${settings.provider === 'claude-code' ? 'Claude Code (subscription)' : 'Anthropic API'} works with ${settings.model}.`
}
