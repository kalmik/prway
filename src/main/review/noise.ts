// Noise filter: marks files that don't need a careful read, without any AI.
//   generated       lockfiles, build output, minified files, snapshots, and files the repo marks
//                   with `linguist-generated` in .gitattributes
//   rename-only     moved or renamed with no content change (or only whitespace changes)
//   formatting-only the diff disappears when whitespace and blank lines are ignored

import type { ChangedFile, NoiseKind } from '../../shared/types'

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'Cargo.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'packages.lock.json',
  'Podfile.lock',
  'pubspec.lock',
  'mix.lock',
  'flake.lock'
])

const GENERATED_DIRS = ['dist/', 'build/', 'vendor/', 'node_modules/', '__snapshots__/', '__generated__/', 'generated/']

const GENERATED_SUFFIXES = [
  '.min.js',
  '.min.css',
  '.map',
  '.snap',
  '.pb.go',
  '_pb2.py',
  '_pb2_grpc.py',
  '.g.dart',
  '.freezed.dart',
  '.designer.cs',
  '.generated.ts',
  '.generated.cs'
]

/** Returns why a path looks generated, or null. */
export function generatedReason(path: string): string | null {
  const name = path.split('/').pop() ?? path
  if (LOCKFILES.has(name)) return 'Lockfile'
  const lower = path.toLowerCase()
  const dir = GENERATED_DIRS.find((d) => lower.startsWith(d) || lower.includes(`/${d}`))
  if (dir) return `Inside ${dir.slice(0, -1)}/`
  const suffix = GENERATED_SUFFIXES.find((s) => lower.endsWith(s))
  if (suffix) return `Generated file (${suffix})`
  return null
}

export interface NumstatEntry {
  path: string
  additions: number | null
  deletions: number | null
}

/** Parses `git diff --numstat -z -M`. Renames come as "a\td\t\0old\0new\0". */
export function parseNumstat(out: string): Map<string, NumstatEntry> {
  const parts = out.split('\0')
  const result = new Map<string, NumstatEntry>()
  for (let i = 0; i < parts.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(parts[i])
    if (!m) continue
    let path = m[3]
    if (path === '') {
      i += 2 // skip old path, take new path
      path = parts[i]
    }
    const num = (s: string) => (s === '-' ? null : Number(s))
    result.set(path, { path, additions: num(m[1]), deletions: num(m[2]) })
  }
  return result
}

/** Parses `git check-attr -z linguist-generated` output: "path\0attr\0value\0" triples. */
export function parseCheckAttr(out: string): Set<string> {
  const parts = out.split('\0')
  const generated = new Set<string>()
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === 'true' || parts[i + 2] === 'set') generated.add(parts[i])
  }
  return generated
}

export interface NoiseInput {
  files: (Omit<ChangedFile, 'additions' | 'deletions' | 'noise'> & { similarity?: number })[]
  numstat: Map<string, NumstatEntry>
  /** numstat with whitespace and blank lines ignored; files that only changed whitespace are absent. */
  numstatNoWhitespace: Map<string, NumstatEntry>
  linguistGenerated: Set<string>
}

export function classify(input: NoiseInput): ChangedFile[] {
  return input.files.map(({ similarity, ...f }) => {
    const stat = input.numstat.get(f.path)
    const file: ChangedFile = { ...f, additions: stat?.additions ?? null, deletions: stat?.deletions ?? null }
    const noise = (kind: NoiseKind, reason: string): ChangedFile => ({ ...file, noise: { kind, reason } })

    if (input.linguistGenerated.has(f.path)) return noise('generated', 'Marked as generated in .gitattributes')
    const gen = generatedReason(f.path)
    if (gen) return noise('generated', gen)

    const binary = stat?.additions === null
    const ws = input.numstatNoWhitespace.get(f.path)
    const changedIgnoringWs = ws ? (ws.additions ?? 1) + (ws.deletions ?? 1) > 0 : false

    if (f.status === 'R') {
      if (similarity === 100) return noise('rename-only', `Renamed from ${f.oldPath}, no content changes`)
      if (!binary && !changedIgnoringWs) return noise('rename-only', `Renamed from ${f.oldPath}, only whitespace changed`)
    }
    if (f.status === 'M' && !binary && !changedIgnoringWs) {
      return noise('formatting-only', 'Only whitespace or blank lines changed')
    }
    return file
  })
}
