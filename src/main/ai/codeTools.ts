// Read-only tools over a PR's checkout, for providers that don't bring their own (the Anthropic API).
// Every path is resolved inside the checkout; nothing outside it (or in .git) can be read.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const MAX_READ_LINES = 400
const MAX_OUTPUT_CHARS = 40_000
const MAX_GREP_LINES = 200
const MAX_LIST_LINES = 500

export const CODE_TOOLS = [
  {
    name: 'read_file',
    description: `Reads a file of the repository at the PR head, with line numbers. At most ${MAX_READ_LINES} lines per call; pass start_line/end_line for long files.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path relative to the repository root.' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 }
      },
      required: ['path']
    }
  },
  {
    name: 'grep',
    description: `Searches the repository at the PR head with a regular expression (Perl syntax, git grep -P). Returns path:line:text, at most ${MAX_GREP_LINES} lines.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regular expression, e.g. def charge\\b' },
        path: { type: 'string', description: 'Optional folder, file or glob to search in, e.g. "lib/" or "*.ex".' },
        ignore_case: { type: 'boolean' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'list_files',
    description: `Lists the files of the repository at the PR head under a folder (git ls-files), at most ${MAX_LIST_LINES}.`,
    input_schema: {
      type: 'object' as const,
      properties: { path: { type: 'string', description: 'Folder or glob; empty for the whole repository.' } }
    }
  }
]

/** A path inside `dir`, or null when it would leave it or touch .git. */
function inside(dir: string, path: string): string | null {
  const root = realpathSync(dir)
  let full = resolve(root, path.replace(/^\/+/, ''))
  // Follow symlinks, so a link in the repository can't point outside it.
  if (existsSync(full)) full = realpathSync(full)
  const rel = relative(root, full)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) return null
  return full
}

function gitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      // git grep exits with 1 when nothing matches.
      if (err && (err as NodeJS.ErrnoException & { code?: number }).code !== 1) return fail(new Error(stderr.trim() || err.message))
      done(stdout)
    })
  })
}

const cap = (lines: string[], max: number, what: string) =>
  (lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more ${what} not shown; narrow the search.`] : lines)
    .join('\n')
    .slice(0, MAX_OUTPUT_CHARS)

/** Runs one tool call. Errors come back as text, so the model can correct itself. */
export async function runCodeTool(dir: string, name: string, input: Record<string, unknown>): Promise<string> {
  try {
    const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
    switch (name) {
      case 'read_file': {
        const full = inside(dir, str('path'))
        if (!full) return 'Error: that path is outside the repository.'
        if (statSync(full).isDirectory()) return 'Error: that is a folder; use list_files.'
        const lines = readFileSync(full, 'utf8').split('\n')
        const start = Math.max(1, Number(input.start_line) || 1)
        const end = Math.min(lines.length, Number(input.end_line) || start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1)
        const body = lines
          .slice(start - 1, end)
          .map((l, i) => `${String(start + i).padStart(5)} | ${l}`)
          .join('\n')
        const more = end < lines.length ? `\n… file has ${lines.length} lines; read on with start_line=${end + 1}.` : ''
        return (body + more).slice(0, MAX_OUTPUT_CHARS)
      }
      case 'grep': {
        const pattern = str('pattern')
        if (!pattern) return 'Error: give a pattern.'
        const where = str('path')
        if (where && !inside(dir, where.replace(/[*?[].*$/, '') || '.')) return 'Error: that path is outside the repository.'
        const args = (flavor: string) => ['grep', '-n', '-I', flavor, ...(input.ignore_case ? ['-i'] : []), '-e', pattern, '--', where || '.']
        // Perl regexes (\b, \d...) when git has them, else extended regexes.
        const out = (await gitOut(args('-P'), dir).catch(() => gitOut(args('-E'), dir))).split('\n').filter(Boolean)
        return out.length ? cap(out.map((l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l)), MAX_GREP_LINES, 'matches') : 'No matches.'
      }
      case 'list_files': {
        const where = str('path')
        if (where && !inside(dir, where.replace(/[*?[].*$/, '') || '.')) return 'Error: that path is outside the repository.'
        const out = (await gitOut(['ls-files', '--', where || '.'], dir)).split('\n').filter(Boolean)
        return out.length ? cap(out, MAX_LIST_LINES, 'files') : 'No files there.'
      }
      default:
        return `Error: unknown tool ${name}.`
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`
  }
}
