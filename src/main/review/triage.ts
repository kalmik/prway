// Pre-approval rules: hunks whose changed lines cannot change behaviour, so the reviewer can skip them.
// Pure (no Electron, no AI): imports/aliases, comments, blank lines, formatting, moved code.
// Conservative on purpose: a hunk qualifies only when EVERY changed line falls into a safe class.

import type { HunkAuto } from '../../shared/types'
import { langOf } from '../code/symbols'
import { canonicalCode, tokenComparable } from './noise'

export interface ChangedLine {
  sign: '+' | '-'
  text: string
  /** Line number in the new file (+) or the old file (-). */
  line: number
}

type Lang = ReturnType<typeof langOf>

const IMPORT: Partial<Record<Lang, RegExp>> = {
  elixir: /^\s*(alias|import|require|use)\s+[A-Z:]/,
  ts: /^\s*(import\s|import\(|export\s+\*\s+from\s|export\s*\{[^}]*\}\s*from\s|\}\s*from\s+['"])/,
  python: /^\s*(import\s+\w|from\s+[\w.]+\s+import\s)/,
  go: /^\s*(import\s*(\(|"|\w+\s+")|"[\w./-]+"\s*$|\w+\s+"[\w./-]+"\s*$|\)\s*$)/,
  ruby: /^\s*(require|require_relative|include|extend)\s/,
  rust: /^\s*(pub(\([^)]*\))?\s+)?(use|extern\s+crate)\s/,
  jvm: /^\s*import\s/
}

/** Continuation lines of a multi-line import/alias, accepted only when the hunk also has an import line. */
const IMPORT_CONTINUATION: Partial<Record<Lang, RegExp>> = {
  elixir: /^\s*([A-Z][\w.]*,?|\}|[A-Z][\w.]*\.\{[\w, ]*\}?,?)\s*$/,
  ts: /^\s*((type\s+)?[\w$]+(\s+as\s+[\w$]+)?,?|\}\s*from\s+['"][^'"]+['"];?)\s*$/,
  python: /^\s*([\w]+(\s+as\s+\w+)?,?|\))\s*$/,
  rust: /^\s*([\w:]+(::\{)?,?|\};?)\s*$/
}

const LINE_COMMENT: Partial<Record<Lang, RegExp>> = {
  elixir: /^\s*#/,
  python: /^\s*#/,
  ruby: /^\s*#/,
  ts: /^\s*(\/\/|\/\*|\*|\*\/)/,
  go: /^\s*(\/\/|\/\*|\*|\*\/)/,
  rust: /^\s*(\/\/|\/\*|\*|\*\/)/,
  jvm: /^\s*(\/\/|\/\*|\*|\*\/)/,
  sql: /^\s*--/
}
const OTHER_COMMENT = /^\s*(#|\/\/|--|\/\*|\*)/

function classify(path: string, lines: ChangedLine[]): { blank: number; imports: number; comments: number } | null {
  const lang = langOf(path)
  const imp = IMPORT[lang]
  const cont = IMPORT_CONTINUATION[lang]
  const comment = LINE_COMMENT[lang] ?? (lang === 'other' ? OTHER_COMMENT : undefined)
  const hasImport = !!imp && lines.some((l) => imp.test(l.text))
  let blank = 0
  let imports = 0
  let comments = 0
  for (const l of lines) {
    if (!l.text.trim()) blank++
    else if (imp?.test(l.text) || (hasImport && cont?.test(l.text))) imports++
    else if (comment?.test(l.text)) comments++
    else return null
  }
  return { blank, imports, comments }
}

/**
 * Why a hunk is safe to pre-approve, or null. `moved` holds the moved line numbers of the file
 * (from `git diff --color-moved`), per side.
 */
export function triageHunk(path: string, lines: ChangedLine[], moved?: { left: Set<number>; right: Set<number> }): HunkAuto | null {
  if (!lines.length) return null

  const kinds = classify(path, lines)
  if (kinds) {
    if (kinds.imports && !kinds.comments) return { kind: 'imports', reason: 'Only imports or aliases changed' }
    if (kinds.comments && !kinds.imports) return { kind: 'comments', reason: 'Only comments changed' }
    if (kinds.imports && kinds.comments) return { kind: 'imports', reason: 'Only imports, aliases and comments changed' }
    return { kind: 'blank', reason: 'Only blank lines changed' }
  }

  if (moved) {
    const allMoved = lines.every((l) => !l.text.trim() || (l.sign === '+' ? moved.right.has(l.line) : moved.left.has(l.line)))
    if (allMoved) return { kind: 'moved', reason: 'Moved code: the same lines exist elsewhere in the PR' }
  }

  if (tokenComparable(path)) {
    const removed = lines.filter((l) => l.sign === '-').map((l) => l.text).join('\n')
    const added = lines.filter((l) => l.sign === '+').map((l) => l.text).join('\n')
    if (removed.trim() && added.trim() && canonicalCode(removed, path) === canonicalCode(added, path)) {
      return { kind: 'formatting', reason: 'Formatting only: same code tokens before and after' }
    }
  }
  return null
}
