// Traces a concept (a feature or business rule the guide found) through the code, without reading the codebase:
// from its seed functions up to who calls them (until an entry point: controller, worker, consumer…), down to
// what they call, to the data structures they build, and to the tests that state their rules. Run once at the
// merge base (before the PR) and once at the head.

import type { ChangedFile, GuideConcept, TraceNode, TraceRole } from '../../shared/types'
import { definitionKind, isTestPath, langOf, qualifierMatchesPath, symbolAt } from '../code/symbols'
import { matchGlob, type RepoRules } from '../review/noise'
import { hash, type Facts, type FileFacts, type Hit } from './facts'

const MAX_NODES = 20
const MAX_CALLER_DEPTH = 2
const CALLERS_PER_NODE = 3
const CALLEES_PER_SEED = 4
const DATA_PER_SEED = 3
const FUNCTION_KINDS = new Set(['function', 'method', 'symbol'])

const DEFAULT_ENTRY =
  /(^|\/)(controllers?|workers?|consumers?|jobs?|handlers?|resolvers?|routes?|router|api|pages|cli|tasks|channels|live|listeners?|subscribers?|schedulers?|endpoints?)(\/|\.|$)|_(controller|worker|consumer|job|handler|resolver|live|channel|listener|subscriber|scheduler|task|router|endpoint)\.\w+$/i

/** Code shown to the model for one node, with line numbers. */
export interface Excerpt {
  cardKey: string
  path: string
  side: 'base' | 'head'
  text: string
}

export interface SideTrace {
  nodes: TraceNode[]
  excerpts: Excerpt[]
}

export interface TraceInput {
  facts: Facts
  concept: GuideConcept
  files: ChangedFile[]
  rules: RepoRules | null
}

const numbered = (lines: string[], from: number, to: number) =>
  lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}| ${l.length > 220 ? l.slice(0, 220) + '…' : l}`)
    .join('\n')

/** The card key of a function: same path, name and code → same key, in any PR. */
export const cardKeyOf = (path: string, name: string, lines: string[], start: number, end: number) =>
  hash(`${path}#${name}\n${lines.slice(start - 1, end).join('\n')}`)

export function isEntryPoint(path: string, rules: RepoRules | null): boolean {
  return DEFAULT_ENTRY.test(path) || !!rules?.entryPoints?.some((g) => matchGlob(path, g))
}

const IGNORED_QUALIFIERS = new Set([
  'Enum', 'Map', 'List', 'String', 'Kernel', 'Keyword', 'Logger', 'Repo', 'Ecto', 'Multi', 'DateTime', 'Date', 'NaiveDateTime',
  'Jason', 'Integer', 'Float', 'Tuple', 'MapSet', 'Stream', 'Task', 'Process', 'GenServer', 'Agent', 'Application', 'Decimal',
  'Changeset', 'Query', 'Atom', 'IO', 'File', 'Path', 'System', 'Access', 'Base', 'URI', 'Regex', 'Timex',
  'Math', 'Object', 'Array', 'JSON', 'Promise', 'console', 'Number', 'Boolean', 'Symbol', 'Reflect', 'Intl'
])

export async function traceSide(input: TraceInput, side: 'base' | 'head', commit: string): Promise<SideTrace> {
  const { facts, concept, files, rules } = input
  const nodes = new Map<string, TraceNode>()
  const excerpts = new Map<string, Excerpt>()
  const changed = new Map(files.map((f) => [f.path, f]))

  const add = (node: Omit<TraceNode, 'id'>, excerpt: string | null): TraceNode | null => {
    const id = `${node.path}#${node.name}`
    if (nodes.has(id) || nodes.size >= MAX_NODES) return null
    const full = { ...node, id }
    nodes.set(id, full)
    if (excerpt && node.cardKey && !excerpts.has(node.cardKey)) excerpts.set(node.cardKey, { cardKey: node.cardKey, path: node.path, side, text: excerpt })
    return full
  }

  const fnNode = (f: FileFacts, path: string, symbol: { name: string; kind: string; line: number; endLine: number; container?: string }, role: TraceRole, depth: number, via?: string, maxLines = 40, focus?: number) => {
    const sym = withClauses(f, symbol)
    const length = sym.endLine - sym.line + 1
    let text: string
    if (length <= maxLines) text = numbered(f.lines, sym.line, sym.endLine)
    else if (focus) {
      // Long function: its first lines and the lines around the call.
      const from = Math.max(sym.line + 3, focus - 6)
      text = `${numbered(f.lines, sym.line, sym.line + 2)}\n   …\n${numbered(f.lines, from, Math.min(sym.endLine, focus + 6))}\n   …`
    } else text = `${numbered(f.lines, sym.line, sym.line + maxLines - 1)}\n   … (${length - maxLines} more lines)`
    return add(
      {
        path,
        name: sym.name,
        kind: sym.kind,
        container: sym.container,
        line: sym.line,
        endLine: sym.endLine,
        role,
        depth,
        via,
        cardKey: cardKeyOf(path, sym.name, f.lines, sym.line, sym.endLine)
      },
      text
    )
  }

  // ---- Seeds ----
  const seeds: TraceNode[] = []
  for (const seed of concept.seeds) {
    const file = changed.get(seed.path)
    const path = side === 'base' ? (file?.oldPath ?? seed.path) : seed.path
    if (side === 'base' && file?.status === 'A') continue
    const f = await facts.file(commit, path)
    if (!f) continue
    const sym =
      f.symbols.find((s) => s.name === seed.name && FUNCTION_KINDS.has(s.kind)) ?? f.symbols.find((s) => s.name === seed.name && s.kind !== 'test')
    if (!sym) continue // a new function (head only) or a removed one (base only)
    const node = fnNode(f, path, sym, 'seed', 0, undefined, 150)
    if (node) seeds.push(node)
  }

  // ---- Up: callers, until an entry point ----
  const tests = new Map<string, Set<string>>()
  // Hops to another file count towards the depth; helper chains inside one file don't.
  const hops = new Map<string, number>(seeds.map((n) => [n.id, 0]))
  let frontier = seeds
  for (let depth = 1; depth <= MAX_CALLER_DEPTH + 3 && frontier.length; depth++) {
    const next: TraceNode[] = []
    for (const target of frontier) {
      if (target.role === 'entry' || (hops.get(target.id) ?? 0) >= MAX_CALLER_DEPTH) continue
      const hits = await callers(facts, commit, target)
      let taken = 0
      for (const h of hits) {
        if (taken >= CALLERS_PER_NODE) break
        const f = await facts.file(commit, h.path)
        if (!f) continue
        const around = symbolAt(f.symbols, h.line)
        if (isTestPath(h.path)) {
          const names = tests.get(h.path) ?? new Set<string>()
          const test = f.symbols.filter((s) => s.kind === 'test' && s.line <= h.line && s.endLine >= h.line).map((s) => s.name)
          for (const t of test.length ? test : f.symbols.filter((s) => s.kind === 'test').map((s) => s.name)) names.add(t)
          tests.set(h.path, names)
          continue
        }
        if (!around || around.kind === 'test') continue
        const role: TraceRole = isEntryPoint(h.path, rules) ? 'entry' : 'caller'
        const node = fnNode(f, h.path, around, role, depth, target.id, 30, h.line)
        if (node) {
          taken++
          hops.set(node.id, (hops.get(target.id) ?? 0) + (h.path === target.path ? 0 : 1))
          next.push(node)
        }
      }
    }
    frontier = next.slice(0, 6)
  }
  for (const [path, names] of [...tests].slice(0, 4)) {
    add({ path, name: 'tests', kind: 'tests', line: 1, endLine: 1, role: 'test', depth: 1, cardKey: '', tests: [...names].slice(0, 15) }, null)
  }

  // ---- Down: what the seeds call, and the data they build ----
  for (const seed of seeds) {
    const f = await facts.file(commit, seed.path)
    if (!f) continue
    const body = f.lines.slice(seed.line, seed.endLine).join('\n')
    const own = new Set(f.symbols.map((s) => s.name))
    const calls = new Map<string, string | undefined>() // name -> qualifier
    for (const m of body.matchAll(/\b([A-Z][\w]*(?:\.[A-Z][\w]*)*)\.([a-z_][\w]*[?!]?)\s*\(/g)) {
      if (!IGNORED_QUALIFIERS.has(m[1].split('.').pop()!) && !calls.has(m[2])) calls.set(m[2], m[1])
    }
    for (const m of body.matchAll(/(?<![.\w])([a-z_][\w]*[?!]?)\s*\(/g)) {
      if (own.has(m[1]) && m[1] !== seed.name && !calls.has(m[1])) calls.set(m[1], undefined)
    }
    let taken = 0
    for (const [name, qualifier] of calls) {
      if (taken >= CALLEES_PER_SEED) break
      if (!qualifier) {
        const sym = f.symbols.find((s) => s.name === name && FUNCTION_KINDS.has(s.kind))
        if (sym && fnNode(f, seed.path, sym, 'callee', 1, seed.id)) taken++
        continue
      }
      const def = (await facts.grep(commit, name)).find(
        (h) => !isTestPath(h.path) && definitionKind(h.path, h.text, name) && qualifierMatchesPath(qualifier, h.path)
      )
      if (!def) continue
      const df = await facts.file(commit, def.path)
      const sym = df && symbolAt(df.symbols, def.line)
      if (df && sym && fnNode(df, def.path, sym, 'callee', 1, seed.id)) taken++
    }

    // Structs the seed builds or matches on (Elixir %Mod{}), and their schema.
    if (langOf(seed.path) !== 'elixir') continue
    const structs = [...new Set([...body.matchAll(/%([A-Z][\w.]*)\{/g)].map((m) => m[1]))].slice(0, DATA_PER_SEED)
    for (const mod of structs) {
      const last = mod.split('.').pop()!
      const full = resolveAlias(f, mod) ?? (mod.includes('.') ? mod : null)
      // Searching the full name keeps the result small (a common short name can hit thousands of lines).
      const defs = (await facts.grep(commit, full ?? last)).filter((h) => new RegExp(`^\\s*defmodule\\s+([\\w.]+\\.)?${last}\\b`).test(h.text))
      // With the full name, that exact module; without it, only when the name is unambiguous.
      const def = full ? defs.find((h) => new RegExp(`^\\s*defmodule\\s+${full.replace(/\./g, '\\.')}\\b`).test(h.text)) : defs.length === 1 ? defs[0] : undefined
      if (!def) continue
      const df = await facts.file(commit, def.path)
      const sym = df?.symbols.find((s) => s.kind === 'module' && s.line === def.line)
      if (!df || !sym) continue
      // The schema block or defstruct, not the whole module.
      const start = df.lines.findIndex((l, i) => i >= sym.line - 1 && /^\s*(schema|embedded_schema|defstruct)\b/.test(l))
      const from = start >= 0 ? start + 1 : sym.line
      add(
        {
          path: def.path,
          name: sym.name,
          kind: 'schema',
          line: from,
          endLine: Math.min(sym.endLine, from + 39),
          role: 'data',
          depth: 1,
          via: seed.id,
          cardKey: cardKeyOf(def.path, sym.name, df.lines, sym.line, sym.endLine)
        },
        numbered(df.lines, from, Math.min(sym.endLine, from + 39))
      )
    }
  }

  return { nodes: [...nodes.values()], excerpts: [...excerpts.values()] }
}

/** A function with all its clauses (Elixir and others define one function in several consecutive clauses). */
function withClauses(f: FileFacts, sym: { name: string; kind: string; line: number; endLine: number; container?: string }) {
  const same = f.symbols.filter((s) => s.name === sym.name && s.kind === sym.kind && s.container === sym.container)
  const i = same.findIndex((s) => s.line === sym.line)
  if (i < 0) return sym
  let start = i
  let end = i
  // Consecutive clauses: only blank lines, comments, @doc/@spec/@impl and closing lines between them.
  const gap = (a: number, b: number) => f.lines.slice(a, b - 1).every((l) => !l.trim() || /^\s*(#|@(doc|spec|impl|deprecated)\b|"""|end\b)/.test(l))
  while (start > 0 && gap(same[start - 1].endLine, same[start].line)) start--
  while (end < same.length - 1 && gap(same[end].endLine, same[end + 1].line)) end++
  return { ...sym, line: same[start].line, endLine: same[end].endLine }
}

/** The full module an alias stands for in a file: "Outbound" → "Warehouse.Order.Schemas.Outbound". */
function resolveAlias(f: FileFacts, name: string): string | null {
  const head = name.split('.')[0]
  const rest = name.slice(head.length)
  for (const line of f.lines) {
    const single = /^\s*alias\s+([\w.]+)(?:\s*,\s*as:\s*(\w+))?\s*$/.exec(line)
    if (single && (single[2] ?? single[1].split('.').pop()) === head) return single[1] + rest
  }
  // alias Parent.{A, B} (also over several lines)
  for (const m of f.lines.join('\n').matchAll(/^\s*alias\s+([\w.]+)\.\{([^}]*)\}/gm)) {
    if (m[2].split(',').map((x) => x.trim()).includes(head)) return `${m[1]}.${head}${rest}`
  }
  return null
}

/** Places that call a function (not its definition, comments or docs). */
async function callers(facts: Facts, commit: string, fn: TraceNode): Promise<Hit[]> {
  const hits = await facts.grep(commit, fn.name)
  const lang = langOf(fn.path)
  const lastSeg = fn.container?.split('.').pop()
  const esc = fn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const f = await facts.file(commit, fn.path)
  const isPrivate = lang === 'elixir' && /^\s*defp\b/.test(f?.lines[fn.line - 1] ?? '')
  const found = hits.filter((h) => {
    if (h.path === fn.path && h.line >= fn.line && h.line <= fn.endLine) return false
    if (definitionKind(h.path, h.text, fn.name)) return false
    if (/^\s*(#|\/\/|\*|\/\*|@spec\b|@doc\b|@callback\b)/.test(h.text)) return false
    if (lang === 'elixir' && h.path !== fn.path) {
      if (isPrivate) return false
      const qualified = lastSeg && new RegExp(`\\b${lastSeg}\\.${esc}(?![\\w?!])`).test(h.text)
      const describe = isTestPath(h.path) && new RegExp(`describe\\s+"${esc}/\\d`).test(h.text)
      return !!(qualified || describe)
    }
    return true
  })
  // Callers in other files first (more telling than recursion inside the same module), tests last.
  return found.sort((a, b) => Number(a.path === fn.path) - Number(b.path === fn.path) || Number(isTestPath(a.path)) - Number(isTestPath(b.path)))
}
