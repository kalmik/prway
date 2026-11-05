// The core of a PR, as line spans: the guide's business rule lines, and from the Background briefing every traced
// function (core, callers, callees, data), the tests that call them and the watch-out lines. Used to keep
// pre-approval away from what matters, and to pre-approve low-risk chunks that are outside all of it.

import type { Briefing, Hunk, ReviewGuide } from '../../shared/types'

export interface CoreSpan {
  path: string
  side: 'base' | 'head'
  start: number
  end: number
  why: string
}

const WHOLE_FILE = 1e9

/** Spans of the core change; `fresh` says whether a briefing for this head commit was used. */
export function coreSpans(briefing: Briefing | null, guide: ReviewGuide | null, headSha: string): { spans: CoreSpan[]; fresh: boolean } {
  const spans: CoreSpan[] = []
  for (const r of guide?.businessRules ?? []) {
    spans.push({ path: r.path, side: 'head', start: r.line ? r.line - 2 : 1, end: r.line ? r.line + 2 : WHOLE_FILE, why: 'business rule' })
  }
  const fresh = !!briefing && briefing.headSha === headSha
  if (fresh) {
    for (const c of briefing!.concepts) {
      for (const [side, nodes] of [['head', c.trace.head], ['base', c.trace.base]] as const) {
        for (const n of nodes) {
          if (n.role === 'test') spans.push({ path: n.path, side, start: 1, end: WHOLE_FILE, why: `tests of ${c.name}` })
          else spans.push({ path: n.path, side, start: n.line, end: n.endLine, why: n.role === 'seed' ? `core of ${c.name}` : `${n.role} in ${c.name}` })
        }
      }
      for (const w of c.watchOut) {
        for (const ct of w.cites) {
          if (ct.kind === 'code' && ct.path && ct.line) spans.push({ path: ct.path, side: ct.side ?? 'head', start: ct.line - 2, end: ct.line + 2, why: `watch out in ${c.name}` })
        }
      }
    }
  }
  return { spans, fresh }
}

/** Why a chunk is part of the core change, or null when it is outside it. */
export function coreHit(spans: CoreSpan[], path: string, h: Hunk, oldPath?: string): string | null {
  const head = [h.newStart, h.newStart + Math.max(h.newLines, 1) - 1]
  const base = [h.oldStart, h.oldStart + Math.max(h.oldLines, 1) - 1]
  for (const s of spans) {
    const [a, b] = s.side === 'head' ? head : base
    if (s.path !== path && s.path !== oldPath) continue
    if (a <= s.end && b >= s.start) return s.why
  }
  return null
}
