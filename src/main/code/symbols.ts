// Pure, regex-based code understanding: file outlines, definition lines, changed lines from a diff.
// No parser or language server: fast, works for any repo, and good enough to navigate a review.
// tree-sitter and language servers can replace this later behind the same functions.

import type { CodeSymbol } from '../../shared/types'

type Lang = 'elixir' | 'ts' | 'python' | 'go' | 'ruby' | 'rust' | 'jvm' | 'sql' | 'other'

export function langOf(path: string): Lang {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (['ex', 'exs', 'heex'].includes(ext)) return 'elixir'
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'].includes(ext)) return 'ts'
  if (['py', 'pyi'].includes(ext)) return 'python'
  if (ext === 'go') return 'go'
  if (['rb', 'rake'].includes(ext)) return 'ruby'
  if (ext === 'rs') return 'rust'
  if (['java', 'kt', 'kts', 'scala', 'cs', 'swift', 'dart'].includes(ext)) return 'jvm'
  if (ext === 'sql') return 'sql'
  return 'other'
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Outline rules: [regex, kind, name group]. Order matters: the first match wins for a line.
type Rule = [RegExp, string, number]
const CONTROL = /^(if|for|while|switch|catch|return|function|else|do|try|new|await|typeof|case)$/

const OUTLINE: Record<Lang, Rule[]> = {
  elixir: [
    [/^\s*defmodule\s+([\w.]+)/, 'module', 1],
    [/^\s*(?:defprotocol|defimpl)\s+([\w.]+)/, 'module', 1],
    [/^\s*(?:def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate|defn|defnp)\s+([a-z_][\w]*[?!]?)/, 'function', 1],
    [/^\s*(?:test|describe)\s+"([^"]+)"/, 'test', 1]
  ],
  ts: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, 'class', 1],
    [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|enum|namespace)\s+([\w$]+)/, 'type', 1],
    [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([\w$]+)\s*(?:<[^=]*>)?\s*=/, 'type', 1],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)/, 'function', 1],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>/, 'function', 1],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::[^=]+)?=\s*(?:async\s+)?function/, 'function', 1],
    [/^\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*([\w$]+)\s*(?:<[^>]*>)?\([^;]*\)\s*(?::\s*[^={;]+)?\{\s*$/, 'method', 1],
    [/^\s*(?:describe|it|test)\(\s*['"`]([^'"`]+)/, 'test', 1]
  ],
  python: [
    [/^\s*class\s+(\w+)/, 'class', 1],
    [/^\s*(?:async\s+)?def\s+(\w+)/, 'function', 1]
  ],
  go: [
    [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, 'function', 1],
    [/^type\s+(\w+)/, 'type', 1]
  ],
  ruby: [
    [/^\s*(?:class|module)\s+([\w:]+)/, 'module', 1],
    [/^\s*def\s+(?:self\.)?([\w?!=]+)/, 'function', 1]
  ],
  rust: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type)\s+(\w+)/, 'type', 1],
    [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([\w:]+)/, 'class', 1],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)/, 'module', 1],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(\w+)/, 'function', 1]
  ],
  jvm: [
    [/^\s*(?:[\w@]+\s+)*(?:class|interface|enum|record|object|struct|protocol|extension)\s+(\w+)/, 'class', 1],
    [/^\s*(?:[\w@]+\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/, 'function', 1],
    [/^\s*(?:func)\s+(\w+)/, 'function', 1],
    [/^\s+(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized)\s+)+[\w<>[\],.? ]+\s+(\w+)\s*\(/, 'method', 1]
  ],
  sql: [[/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|procedure|index|type|trigger)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i, 'object', 1]],
  other: [[/^\s*(?:def|fn|func|function|class|interface|struct|module)\s+([\w.]+)/, 'symbol', 1]]
}

const CONTAINER_KINDS = new Set(['module', 'class', 'type'])

const indentOf = (line: string) => line.length - line.trimStart().length

/** Symbols defined in a file, with an estimated end line (by indentation). */
export function outline(path: string, text: string): CodeSymbol[] {
  const rules = OUTLINE[langOf(path)]
  const lines = text.split('\n')
  const found: (CodeSymbol & { indent: number })[] = []
  lines.forEach((line, i) => {
    if (line.length > 400) return
    for (const [re, kind, group] of rules) {
      const m = re.exec(line)
      if (m && !CONTROL.test(m[group])) {
        found.push({ name: m[group], kind, line: i + 1, endLine: i + 1, indent: indentOf(line) })
        break
      }
    }
  })
  // A symbol ends right before the next non-blank line indented at its level or less
  // (closing "end" / "}" lines at the same level belong to it).
  for (const s of found) {
    let end = lines.length
    for (let j = s.line; j < lines.length; j++) {
      const l = lines[j]
      if (!l.trim()) continue
      if (indentOf(l) <= s.indent) {
        if (/^\s*(end\b|[}\])]|\)?;?$)/.test(l) && indentOf(l) === s.indent) {
          end = j + 1
        } else end = j
        break
      }
    }
    while (end > s.line && !lines[end - 1]?.trim()) end--
    s.endLine = Math.max(s.line, end)
  }
  // Container: the innermost module/class that encloses the symbol.
  const containers = found.filter((s) => CONTAINER_KINDS.has(s.kind))
  return found.map(({ indent: _indent, ...s }) => {
    const parent = containers
      .filter((c) => c !== s && c.line < s.line && c.endLine >= s.endLine)
      .sort((a, b) => b.line - a.line)[0]
    return parent ? { ...s, container: parent.name } : s
  })
}

/** The innermost function-like symbol around a line; falls back to the innermost container. */
export function symbolAt(symbols: CodeSymbol[], line: number): CodeSymbol | null {
  const around = symbols.filter((s) => s.line <= line && s.endLine >= line)
  const pick = (list: CodeSymbol[]) => list.sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0] ?? null
  return pick(around.filter((s) => !CONTAINER_KINDS.has(s.kind))) ?? pick(around)
}

/** True when `line` (from `path`) defines `word`. Returns the kind of definition, or null. */
export function definitionKind(path: string, line: string, word: string): string | null {
  const w = esc(word)
  const after = '(?![\\w?!])'
  const lang = langOf(path)
  const table: Record<Lang, [RegExp, string][]> = {
    elixir: [
      [new RegExp(`^\\s*(defmodule|defprotocol|defimpl)\\s+([\\w.]+\\.)?${w}(?![\\w?!.])`), 'module'], // name must end with the word
      [new RegExp(`^\\s*(def|defp|defmacro|defmacrop|defguard|defguardp|defdelegate|defn|defnp)\\s+${w}${after}`), 'function'],
      [new RegExp(`^\\s*@(type|typep|opaque|callback|macrocallback)\\s+${w}${after}`), 'type']
    ],
    ts: [
      [new RegExp(`\\b(class|interface|enum|namespace)\\s+${w}\\b`), 'class'],
      [new RegExp(`\\btype\\s+${w}\\s*(<[^=]*>)?\\s*=`), 'type'],
      [new RegExp(`\\bfunction\\*?\\s+${w}\\b`), 'function'],
      [new RegExp(`\\b(const|let|var)\\s+${w}\\s*(:[^=]+)?=`), 'variable'],
      [new RegExp(`^\\s+((public|private|protected|static|async|readonly|override|abstract|get|set)\\s+)*${w}\\s*(<[^>]*>)?\\([^;]*\\)\\s*(:\\s*[^={;]+)?\\{\\s*$`), 'method'],
      [new RegExp(`^\\s*(readonly\\s+)?${w}\\??\\s*:\\s*`), 'property']
    ],
    python: [
      [new RegExp(`^\\s*(async\\s+)?def\\s+${w}\\b`), 'function'],
      [new RegExp(`^\\s*class\\s+${w}\\b`), 'class'],
      [new RegExp(`^${w}\\s*(:[^=]+)?=[^=]`), 'variable']
    ],
    go: [
      [new RegExp(`^func\\s+(\\([^)]*\\)\\s*)?${w}\\b`), 'function'],
      [new RegExp(`^\\s*(type\\s+)?${w}\\s+(struct|interface)\\b`), 'type'],
      [new RegExp(`^type\\s+${w}\\b`), 'type'],
      [new RegExp(`^\\s*(var|const)\\s+${w}\\b`), 'variable']
    ],
    ruby: [
      [new RegExp(`^\\s*def\\s+(self\\.)?${w}${after}`), 'function'],
      [new RegExp(`^\\s*(class|module)\\s+([\\w:]+::)?${w}\\b`), 'module']
    ],
    rust: [[new RegExp(`\\b(fn|struct|enum|trait|type|mod|union|const|static|macro_rules!)\\s+${w}\\b`), 'definition']],
    jvm: [
      [new RegExp(`\\b(class|interface|enum|record|object|struct|protocol|fun|func)\\s+${w}\\b`), 'definition'],
      [new RegExp(`^\\s+((public|private|protected|internal|static|final|abstract|override|virtual|async)\\s+)+[\\w<>\\[\\],.? ]+\\s+${w}\\s*\\(`), 'method']
    ],
    sql: [[new RegExp(`create\\s+(or\\s+replace\\s+)?(table|view|function|procedure|index|type|trigger)\\s+(if\\s+not\\s+exists\\s+)?([\\w."]+\\.)?"?${w}\\b`, 'i'), 'object']],
    other: [[new RegExp(`\\b(def|fn|func|function|class|interface|struct|type|module)\\s+${w}\\b`), 'definition']]
  }
  const tests = table[lang]
  for (const [re, kind] of tests) if (re.test(line)) return kind
  return null
}

const TEST_PATH = /(^|\/)(test|tests|spec|specs|__tests__|e2e)\/|[._-](test|spec)\.[\w]+$|_test\.(go|exs|py)$|^test_[^/]*\.py$|\/test_[^/]*\.py$/

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

/** Lines changed on the new side of a unified diff (any context size). Pure deletions mark the lines around them. */
export function changedNewLines(diff: string): Set<number> {
  const changed = new Set<number>()
  let newLine = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('+')) changed.add(newLine++)
    else if (line.startsWith('-')) {
      changed.add(Math.max(1, newLine - 1))
      changed.add(newLine)
    } else if (line.startsWith(' ')) newLine++
    else if (line.startsWith('diff ')) inHunk = false
  }
  return changed
}

/** Lines inside diff hunks, per side: where GitHub accepts review comments. */
export function hunkLines(diff: string): { left: number[]; right: number[] } {
  const left: number[] = []
  const right: number[] = []
  let o = 0
  let n = 0
  let inHunk = false
  for (const line of diff.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      o = Number(hunk[1])
      n = Number(hunk[2])
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('+')) right.push(n++)
    else if (line.startsWith('-')) left.push(o++)
    else if (line.startsWith(' ')) {
      left.push(o++)
      right.push(n++)
    } else if (line.startsWith('diff ')) inHunk = false
  }
  return { left, right }
}

/** "lib/app/inbound/receiving.ex" -> "Receiving" style hints are language specific; this returns the last
 * dotted segment of an Elixir module or the file stem, used to rank qualified matches. */
export function qualifierMatchesPath(qualifier: string, path: string): boolean {
  const last = qualifier.split('.').pop() ?? qualifier
  const snake = last.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  const lower = path.toLowerCase()
  return lower.includes(`/${snake}.`) || lower.includes(`/${snake}/`) || lower.includes(`/${last.toLowerCase()}.`)
}
