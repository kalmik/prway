// Hints you marked as not useful ("Check" items, chunk notes, focus lines), with your reason when you give one, per
// repository. The AI gets them back as examples of what to leave out, and your reasons as rules:
// points like the ones you marked as noise are left out, and chunks with nothing else to say are marked trivial
// (so they can be pre-approved).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { HintFeedback, HintVerdict } from '../../shared/types'
import { dataDir } from '../store'

/** Ratings kept per repository (the oldest go first). */
const MAX_STORED = 500
/** Examples sent to the model: noise matters most (it is what makes the hints picky). */
const PROMPT_NOISE = 30
const MAX_TEXT = 300
const MAX_COMMENT = 500

const file = (repo: string) => join(dataDir, 'feedback', `${repo}.json`)

export function loadFeedback(repo: string): HintFeedback[] {
  try {
    const all = existsSync(file(repo)) ? (JSON.parse(readFileSync(file(repo), 'utf8')) as HintFeedback[]) : []
    // Older versions also stored 👍 ratings; only "not useful" teaches anything (useful hints keep coming anyway).
    return all.filter((f) => f.verdict === 'noise')
  } catch {
    return []
  }
}

export function rateHint(
  repo: string,
  hint: Omit<HintFeedback, 'id' | 'at' | 'verdict' | 'comment'> & { verdict: HintVerdict | null; comment?: string | null }
): HintFeedback[] {
  const id = `${hint.kind}|${hint.path}|${hint.text}`
  const all = loadFeedback(repo)
  const old = all.find((f) => f.id === id)
  const list = all.filter((f) => f.id !== id)
  if (hint.verdict) {
    // Marking again keeps your earlier reason unless a new one comes along.
    const comment =
      hint.comment === null ? undefined : (hint.comment?.trim() || undefined) ?? (old?.verdict === hint.verdict ? old.comment : undefined)
    list.push({
      id,
      kind: hint.kind,
      pr: hint.pr,
      path: hint.path,
      text: hint.text,
      verdict: hint.verdict,
      ...(comment ? { comment: comment.slice(0, MAX_COMMENT) } : {}),
      at: new Date().toISOString()
    })
  }
  return save(repo, list)
}

export function removeFeedback(repo: string, id: string): HintFeedback[] {
  return save(repo, loadFeedback(repo).filter((f) => f.id !== id))
}

function save(repo: string, list: HintFeedback[]): HintFeedback[] {
  const kept = list.slice(-MAX_STORED)
  mkdirSync(dirname(file(repo)), { recursive: true })
  writeFileSync(file(repo), JSON.stringify(kept, null, 2))
  return kept
}

const short = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t).replace(/\s+/g, ' ')

/** The latest `max` ratings, those with your reason first (they teach the most). */
function pick(list: HintFeedback[], max: number): HintFeedback[] {
  const explained = list.filter((f) => f.comment).slice(-max)
  const room = max - explained.length
  const rest = room > 0 ? list.filter((f) => !f.comment).slice(-room) : []
  return [...explained, ...rest]
}

/** The section added to walkthrough and guide prompts; empty when you haven't marked anything. */
export function feedbackPromptText(repo: string): string {
  const noise = pick(loadFeedback(repo), PROMPT_NOISE)
  if (!noise.length) return ''
  const line = (f: HintFeedback) =>
    `- (${f.path}${f.kind === 'focus' ? ', a focus line of the guide' : ''}) ${short(f.text)}${f.comment ? `\n  REVIEWER'S REASON: ${short(f.comment)}` : ''}`
  return [
    'REVIEWER FEEDBACK on earlier AI hints in this repository (the same reviewer, earlier PRs).',
    "Where a REVIEWER'S REASON is given, treat it as a rule for this repository: apply it to any similar code, not only to that exact hint.",
    `Marked NOT USEFUL (noise, too picky, wrong for this codebase, or obvious). Do not raise points of these kinds again. When a hunk's only notes would be like these, leave them out; if nothing else is left and the hunk is low risk, mark it trivial:\n${noise.map(line).join('\n')}`
  ].join('\n')
}
