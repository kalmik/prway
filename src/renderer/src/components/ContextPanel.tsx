// Context tab: results of go-to-definition / find-references, and for each function the current file
// changes, its history (with past PRs and their review comments), callers and tests.

import { useEffect, useState } from 'react'
import type { ChangedFunction, CodeLocation, FunctionContext } from '../../../shared/types'
import { errorText, timeAgo } from '../util'
import { Markdown } from './Markdown'

const api = window.prway

export interface NavResults {
  kind: 'def' | 'refs'
  word: string
  locations: CodeLocation[] | null
  truncated?: boolean
  error?: string
}

interface Props {
  repo: string
  number: number
  path: string | null
  /** Bumps when the worktree is refreshed, so cached context is reloaded. */
  headSha: string
  nav: NavResults | null
  onClearNav: () => void
  onOpen: (path: string, line: number) => void
  onOpenUrl: (url: string) => void
}

function Locations({ items, onOpen }: { items: CodeLocation[]; onOpen: Props['onOpen'] }) {
  const byFile = new Map<string, CodeLocation[]>()
  for (const l of items) byFile.set(l.path, [...(byFile.get(l.path) ?? []), l])
  return (
    <ul className="locations">
      {[...byFile].map(([path, locs]) => (
        <li key={path}>
          <div className="loc-file small">{path}</div>
          {locs.map((l) => (
            <button key={l.line} className="loc" onClick={() => onOpen(l.path, l.line)} title={`${l.path}:${l.line}`}>
              <span className="loc-line">{l.line}</span>
              <code className="loc-text">{l.text}</code>
            </button>
          ))}
        </li>
      ))}
    </ul>
  )
}

function FunctionDetails({ repo, number, fn, onOpen, onOpenUrl }: { repo: string; number: number; fn: ChangedFunction } & Pick<Props, 'onOpen' | 'onOpenUrl'>) {
  const [ctx, setCtx] = useState<FunctionContext | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let current = true
    api.context.forFunction(repo, number, fn).then(
      (c) => current && setCtx(c),
      (err) => current && setError(errorText(err))
    )
    return () => {
      current = false
    }
  }, [repo, number, fn])

  if (error) return <p className="small error">{error}</p>
  if (!ctx) return <p className="small muted">Reading history, callers and tests…</p>
  return (
    <div className="fn-details">
      <section>
        <h4>History ({ctx.history.length})</h4>
        {ctx.history.length === 0 && <p className="small muted">No earlier commits touched these lines (new code, or history not available).</p>}
        <ul className="history">
          {ctx.history.map((c) => (
            <li key={c.sha}>
              <div className="small">
                <code>{c.sha.slice(0, 7)}</code> {c.subject}
              </div>
              <div className="small muted">
                {c.author} · {timeAgo(c.date)}
                {c.pr && (
                  <>
                    {' · '}
                    <button className="link" onClick={() => onOpenUrl(c.pr!.url)}>
                      PR #{c.pr.number}
                    </button>
                  </>
                )}
              </div>
              {c.pr && c.pr.comments.length > 0 && (
                <ul className="past-comments">
                  {c.pr.comments.map((pc, i) => (
                    <li key={i}>
                      <span className="small muted">{pc.author}:</span>
                      <Markdown text={pc.body} onLink={onOpenUrl} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4>
          Callers ({ctx.callers.length}
          {ctx.truncated ? '+' : ''})
        </h4>
        {ctx.callers.length === 0 ? <p className="small muted">No callers found outside the function.</p> : <Locations items={ctx.callers} onOpen={onOpen} />}
      </section>
      <section>
        <h4>Tests ({ctx.tests.length})</h4>
        {ctx.tests.length === 0 ? (
          <p className="small warn-text">No test references this function directly.</p>
        ) : (
          <Locations items={ctx.tests} onOpen={onOpen} />
        )}
      </section>
    </div>
  )
}

export function ContextPanel({ repo, number, path, headSha, nav, onClearNav, onOpen, onOpenUrl }: Props) {
  const [fns, setFns] = useState<ChangedFunction[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!path) return
    let current = true
    setFns(null)
    setError(null)
    setOpen(null)
    api.context.changedFunctions(repo, number, path).then(
      (list) => {
        if (!current) return
        setFns(list)
        // Open the first real function right away: that's usually what you want to see.
        const first = list.find((f) => f.kind !== 'module' && f.kind !== 'class')
        if (first) setOpen(`${first.name}:${first.line}`)
      },
      (err) => current && setError(errorText(err))
    )
    return () => {
      current = false
    }
  }, [repo, number, path, headSha])

  return (
    <div className="panel-body context-panel">
      {nav && (
        <section className="nav-results">
          <div className="row">
            <h4 className="spacer">
              {nav.kind === 'def' ? 'Definitions of' : 'References to'} <code>{nav.word}</code>
              {nav.locations && ` (${nav.locations.length}${nav.truncated ? '+' : ''})`}
            </h4>
            <button className="link small" onClick={onClearNav}>
              close
            </button>
          </div>
          {nav.error && <p className="small error">{nav.error}</p>}
          {!nav.locations && !nav.error && <p className="small muted">Searching the PR head…</p>}
          {nav.locations?.length === 0 && <p className="small muted">Nothing found.</p>}
          {nav.locations && nav.locations.length > 0 && <Locations items={nav.locations} onOpen={onOpen} />}
        </section>
      )}

      <section>
        <h4>Changed in this file</h4>
        {!path && <p className="small muted">Open a file to see the functions it changes.</p>}
        {error && <p className="small error">{error}</p>}
        {path && !fns && !error && <p className="small muted">Finding changed functions…</p>}
        {fns?.length === 0 && <p className="small muted">No functions found around the changes (config, data or a language PRway doesn't parse).</p>}
        <ul className="fn-list">
          {fns?.map((fn) => {
            const key = `${fn.name}:${fn.line}`
            return (
              <li key={key} className={open === key ? 'open' : ''}>
                <div className="fn-row">
                  <button className="link fn-name" onClick={() => setOpen(open === key ? null : key)}>
                    {open === key ? '▾' : '▸'} <span className="fn-kind">{fn.kind}</span> <code>{fn.name}</code>
                  </button>
                  <span className="small muted">
                    {fn.changedLines} changed line{fn.changedLines > 1 ? 's' : ''}
                  </span>
                  <button className="link small" onClick={() => onOpen(fn.path, fn.line)}>
                    L{fn.line}
                  </button>
                </div>
                {open === key && <FunctionDetails repo={repo} number={number} fn={fn} onOpen={onOpen} onOpenUrl={onOpenUrl} />}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
