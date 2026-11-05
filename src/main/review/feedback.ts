// Your ratings of AI hints ("Check" items and chunk notes), per repository. The AI gets them back as examples:
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
const PROMPT_USEFUL = 10
const MAX_TEXT = 300

const file = (repo: string) => join(dataDir, 'feedback', `${repo}.json`)

export function loadFeedback(repo: string): HintFeedback[] {
  try {
    return existsSync(file(repo)) ? (JSON.parse(readFileSync(file(repo), 'utf8')) as HintFeedback[]) : []
  } catch {
    return []
  }
}

export function rateHint(repo: string, hint: Omit<HintFeedback, 'id' | 'at' | 'verdict'> & { verdict: HintVerdict | null }): HintFeedback[] {
  const id = `${hint.kind}|${hint.path}|${hint.text}`
  const list = loadFeedback(repo).filter((f) => f.id !== id)
  if (hint.verdict) list.push({ id, kind: hint.kind, pr: hint.pr, path: hint.path, text: hint.text, verdict: hint.verdict, at: new Date().toISOString() })
  const kept = list.slice(-MAX_STORED)
  mkdirSync(dirname(file(repo)), { recursive: true })
  writeFileSync(file(repo), JSON.stringify(kept, null, 2))
  return kept
}

const short = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t).replace(/\s+/g, ' ')

/** The section added to walkthrough and guide prompts; empty when you haven't rated anything. */
export function feedbackPromptText(repo: string): string {
  const all = loadFeedback(repo)
  const noise = all.filter((f) => f.verdict === 'noise').slice(-PROMPT_NOISE)
  const useful = all.filter((f) => f.verdict === 'useful').slice(-PROMPT_USEFUL)
  if (!noise.length && !useful.length) return ''
  const line = (f: HintFeedback) => `- (${f.path}${f.kind === 'focus' ? ', a focus line of the guide' : ''}) ${short(f.text)}`
  return [
    'REVIEWER FEEDBACK on earlier AI hints in this repository (the same reviewer, earlier PRs):',
    noise.length
      ? `Marked NOT USEFUL (noise, too picky, or obvious). Do not raise points of these kinds again. When a hunk's only notes would be like these, leave them out; if nothing else is left and the hunk is low risk, mark it trivial:\n${noise.map(line).join('\n')}`
      : '',
    useful.length ? `Marked USEFUL (keep raising points of these kinds):\n${useful.map(line).join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}
