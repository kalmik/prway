// AI review guide: tells the human reviewer what the PR is for, where to look first and why.
// It does not replace the review; it points attention at business rules, risky code and
// changes the stated intent doesn't explain.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChangedFile, PullDetail, ReviewGuide } from '../../shared/types'
import { accountById, getAiSettings, getProvider } from '../ai/provider'
import type { GitHub } from '../github/api'
import type { WorktreeManager } from '../git/worktrees'
import type { CodeNavigator } from '../code/navigator'
import { kbPromptText, type KnowledgeBase } from '../kb/knowledge'
import { dataDir } from '../store'
import { buildPrompt, GUIDE_SCHEMA, normalizeFiles, type ModelGuide } from './guidePrompt'
import { feedbackPromptText } from './feedback'
import { systemPrompt } from './prompts'

function guidePath(repo: string, number: number, headSha: string): string {
  return join(dataDir, 'guides', repo, `pr-${number}`, `${headSha}.json`)
}

function readGuide(p: string): ReviewGuide | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ReviewGuide
  } catch {
    return null
  }
}

/**
 * The guide for this head commit; else the newest guide saved for the PR (the UI marks it outdated),
 * so new commits don't throw away a guide that is still mostly right.
 */
export function loadGuide(repo: string, number: number, headSha: string): ReviewGuide | null {
  const exact = guidePath(repo, number, headSha)
  if (existsSync(exact)) return readGuide(exact)
  const dir = dirname(exact)
  if (!existsSync(dir)) return null
  return (
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readGuide(join(dir, f)))
      .filter((g): g is ReviewGuide => !!g)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  )
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

export interface GuideDeps {
  gh: GitHub
  worktrees: WorktreeManager
  navigator: CodeNavigator
  kb: KnowledgeBase
}

type Material = { review: ChangedFile[]; prompt: string; truncatedFiles: string[] }

/** PR material per head commit, so chat follow-ups and a guide right after don't redo the git and grep work. */
const materialCache = new Map<string, { at: number; value: Promise<Material> }>()
const MATERIAL_TTL_MS = 30 * 60 * 1000

/** Everything the model gets about a PR: shared by the guide and the chat. Cached per head commit for 30 minutes. */
export function prMaterial(deps: GuideDeps, pull: PullDetail, files: ChangedFile[]): Promise<Material> {
  const head = deps.worktrees.headSha(pull.repo, pull.number) ?? 'unknown'
  // Description edits and noise changes (e.g. a new .prway.json) give a new key too.
  const key = createHash('sha1')
    .update([pull.repo, pull.number, head, pull.title, pull.body ?? '', files.map((f) => `${f.path}:${f.noise?.kind ?? ''}`).join(',')].join('\n'))
    .digest('hex')
  const hit = materialCache.get(key)
  if (hit && Date.now() - hit.at < MATERIAL_TTL_MS) return hit.value
  const value = buildMaterial(deps, pull, files)
  value.catch(() => materialCache.delete(key))
  materialCache.set(key, { at: Date.now(), value })
  for (const [k, v] of materialCache) if (Date.now() - v.at >= MATERIAL_TTL_MS || materialCache.size > 8) materialCache.delete(k)
  return value
}

async function buildMaterial({ gh, worktrees, navigator, kb }: GuideDeps, pull: PullDetail, files: ChangedFile[]): Promise<Material> {
  const review = files.filter((f) => !f.noise)
  const skipped = files.filter((f) => f.noise)
  const [issues, commits, diffs, context, knowledge] = await Promise.all([
    linkedIssues(gh, pull),
    worktrees.commitLog(pull.repo, pull.number),
    Promise.all(review.map((f) => worktrees.unifiedDiff(pull.repo, pull.number, f))),
    navigator.guideContext(pull.repo, pull.number, review).catch((err) => {
      console.warn('[guide] context failed:', (err as Error).message)
      return ''
    }),
    relatedKnowledge(navigator, kb, pull.repo, pull.number, review)
      .then(kbPromptText)
      .catch(() => '')
  ])
  return { review, ...buildPrompt({ pull, issues, commits, review: review.map((file, i) => ({ file, diff: diffs[i] })), skipped, context, knowledge }) }
}

/** Knowledge base entries about the files and functions this PR changes. */
export async function relatedKnowledge(navigator: CodeNavigator, kb: KnowledgeBase, repo: string, number: number, files: ChangedFile[]) {
  const symbols: string[] = []
  for (const f of files.slice(0, 40)) {
    const fns = await navigator.changedFunctions(repo, number, f.path).catch(() => [])
    for (const fn of fns) if (fn.kind !== 'module' && fn.kind !== 'class') symbols.push(`${f.path}#${fn.name}`)
  }
  return kb.related(repo, number, files.map((f) => f.path), symbols)
}

export async function generateGuide(deps: GuideDeps, pull: PullDetail, files: ChangedFile[], headSha: string): Promise<ReviewGuide> {
  const settings = getAiSettings(pull.repo)
  const provider = getProvider(settings)
  const { review, prompt, truncatedFiles } = await prMaterial(deps, pull, files)

  const instructions = systemPrompt('guide', pull.repo, deps.worktrees.rulesOrNull(pull.repo, pull.number))
  // Your ratings of earlier hints: the guide should skip the same kinds of points.
  const feedback = feedbackPromptText(pull.repo)
  const answer = await provider.generate<ModelGuide>({
    system: instructions.system,
    prompt: feedback ? `${prompt}\n\n${feedback}` : prompt,
    schema: GUIDE_SCHEMA as unknown as Record<string, unknown>,
    model: settings.model,
    effort: settings.effort
  })
  const ordered = normalizeFiles(answer.files, review)
  // Seeds must be in the files under review, and their names bare (no module, no arity).
  const reviewPaths = new Set(review.map((f) => f.path))
  const concepts = (answer.concepts ?? [])
    .map((c) => ({
      ...c,
      seeds: c.seeds
        .filter((s) => reviewPaths.has(s.path))
        .map((s) => ({ path: s.path, name: s.name.replace(/\/\d+$/, '').split(/[.#]/).pop()!.replace(/\(.*$/, '').trim() }))
        .filter((s) => s.name)
    }))
    .filter((c) => c.seeds.length)

  const guide: ReviewGuide = {
    ...answer,
    concepts,
    files: ordered,
    headSha,
    provider: settings.provider,
    model: settings.model,
    account: settings.account.name,
    createdAt: new Date().toISOString(),
    truncatedFiles,
    promptHash: instructions.hash
  }
  const p = guidePath(pull.repo, pull.number, headSha)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(guide, null, 2))
  return guide
}

/** A tiny request to check that an AI account and its model work. */
export async function testProvider(accountId: string): Promise<string> {
  const settings = accountById(accountId)
  const answer = await getProvider(settings).generate<{ ok: boolean }>({
    system: 'Answer with the JSON object requested.',
    prompt: 'Return {"ok": true}.',
    schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
    model: settings.model,
    effort: 'low'
  })
  if (!answer.ok) throw new Error('Unexpected answer from the model')
  return `${settings.account.name} works (${settings.provider === 'claude-code' ? 'Claude Code subscription' : 'Anthropic API'}, ${settings.model}).`
}
