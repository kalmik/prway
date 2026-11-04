import { Fragment, useEffect, useMemo, useState } from 'react'
import type { ChangedFile, ReviewGuide } from '../../../shared/types'
import { buildTree, compact, type Dir } from '../fileTree'
import { storage, useStored } from '../util'

const STATUS_LABEL: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' }

interface Props {
  files: ChangedFile[]
  guide: ReviewGuide | null
  selected: ChangedFile | null
  viewed: Set<string>
  /** Open threads plus pending drafts, per file. */
  commentCounts: Map<string, number>
  onSelect: (f: ChangedFile) => void
  onToggleViewed: (path: string) => void
}

export function FileList({ files, guide, selected, viewed, commentCounts, onSelect, onToggleViewed }: Props) {
  const [showSkipped, setShowSkipped] = useState(() => storage.get('ui.showSkipped', false))
  const [layout, setLayout] = useStored<'tree' | 'order'>('ui.files.layout', 'tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toReview = files.filter((f) => !f.noise)
  const skipped = files.filter((f) => f.noise)

  // Follow the guide's reading order when there is one.
  const order = new Map(guide?.files.map((g, i) => [g.path, i]) ?? [])
  const ordered = [...toReview].sort((a, b) => (order.get(a.path) ?? 1e6) - (order.get(b.path) ?? 1e6))
  const risk = new Map(guide?.files.map((g) => [g.path, g.risk]) ?? [])
  const reviewedCount = toReview.filter((f) => viewed.has(f.path)).length
  const position = new Map(ordered.map((f, i) => [f.path, i]))
  const byPath = new Map(toReview.map((f) => [f.path, f]))
  const tree = useMemo(() => buildTree(toReview.map((f) => f.path)), [toReview.map((f) => f.path).join('\n')])

  // The selected file's folders stay open.
  useEffect(() => {
    if (!selected) return
    setCollapsed((c) => {
      const open = [...c].filter((d) => selected.path.startsWith(d + '/'))
      if (!open.length) return c
      const next = new Set(c)
      open.forEach((d) => next.delete(d))
      return next
    })
  }, [selected?.path])

  const row = (f: ChangedFile, index?: number, depth?: number) => (
    <li key={f.path} className={f.path === selected?.path ? 'active' : ''} style={depth !== undefined ? { paddingLeft: 8 + depth * 12 } : undefined}>
      <input type="checkbox" title="Mark as viewed" checked={viewed.has(f.path)} onChange={() => onToggleViewed(f.path)} />
      <button className={`file ${viewed.has(f.path) ? 'viewed' : ''}`} onClick={() => onSelect(f)} title={f.path}>
        {index !== undefined && guide && <span className="order">{index + 1}</span>}
        {risk.has(f.path) && <span className={`risk-dot risk-${risk.get(f.path)}`} title={`${risk.get(f.path)} risk`} />}
        <span className={`status s-${f.status}`} title={STATUS_LABEL[f.status]}>
          {f.status}
        </span>
        <span className="file-name">{f.path.split('/').pop()}</span>
        {depth === undefined && <span className="file-dir">{f.path.split('/').slice(0, -1).join('/')}</span>}
        {!!commentCounts.get(f.path) && (
          <span className="comment-count" title="Open comments and pending drafts">
            {commentCounts.get(f.path)}
          </span>
        )}
        {f.additions !== null && (
          <span className="file-stat">
            <span className="add">+{f.additions}</span> <span className="del">−{f.deletions}</span>
          </span>
        )}
      </button>
    </li>
  )

  /** Folders first, then files; each folder shows how many of its files you viewed. */
  function dirRows(dir: Dir, depth: number): React.ReactNode {
    return (
      <>
        {dir.dirs.map((d) => {
          const sub = compact(d)
          const paths = filesUnder(sub)
          const seen = paths.filter((p) => viewed.has(p)).length
          const open = !collapsed.has(sub.path)
          return (
            <Fragment key={sub.path}>
              <li className="dir-row" style={{ paddingLeft: 8 + depth * 12 }}>
                <button
                  className="file"
                  title={sub.path}
                  onClick={() =>
                    setCollapsed((c) => {
                      const next = new Set(c)
                      if (open) next.add(sub.path)
                      else next.delete(sub.path)
                      return next
                    })
                  }
                >
                  <span className="tree-twisty">{open ? '▾' : '▸'}</span>
                  <span className="file-name dir-name">{sub.name}</span>
                  <span className={`dir-count ${seen === paths.length ? 'done' : ''}`}>
                    {seen}/{paths.length}
                  </span>
                </button>
              </li>
              {open && dirRows(sub, depth + 1)}
            </Fragment>
          )
        })}
        {dir.files.map((p) => row(byPath.get(p)!, position.get(p), depth))}
      </>
    )
  }

  return (
    <div className="file-list">
      <div className="files-header small muted">
        <div className="row">
          <span className="spacer">
            To review: {reviewedCount}/{toReview.length} viewed
          </span>
          <span className="seg small" role="group" aria-label="File layout">
            <button className={layout === 'tree' ? 'on' : ''} onClick={() => setLayout('tree')} title="Folders">
              Tree
            </button>
            <button
              className={layout === 'order' ? 'on' : ''}
              onClick={() => setLayout('order')}
              title={guide ? "The guide's reading order" : 'A flat list'}
            >
              {guide ? 'Order' : 'List'}
            </button>
          </span>
        </div>
        <div className="progress">
          <div style={{ width: `${toReview.length ? (reviewedCount / toReview.length) * 100 : 0}%` }} />
        </div>
      </div>
      {layout === 'tree' ? <ul className="file-tree">{dirRows(tree, 0)}</ul> : <ul>{ordered.map((f, i) => row(f, i))}</ul>}

      {skipped.length > 0 && (
        <>
          <button
            className="group-toggle small muted"
            onClick={() => {
              setShowSkipped(!showSkipped)
              storage.set('ui.showSkipped', !showSkipped)
            }}
          >
            {showSkipped ? '▾' : '▸'} Skip — {skipped.length} file{skipped.length > 1 ? 's' : ''} (
            {skipped.reduce((n, f) => n + (f.additions ?? 0) + (f.deletions ?? 0), 0)} lines of noise)
          </button>
          {showSkipped && (
            <ul className="skipped">
              {skipped.map((f) => (
                <li key={f.path} className={f.path === selected?.path ? 'active' : ''} title={f.noise!.reason}>
                  <span className="noise-tag">{f.noise!.kind}</span>
                  <button className="file" onClick={() => onSelect(f)} title={`${f.path}\n${f.noise!.reason}`}>
                    <span className="file-name">{f.path.split('/').pop()}</span>
                    <span className="file-dir">{f.path.split('/').slice(0, -1).join('/')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function filesUnder(d: Dir): string[] {
  return [...d.files, ...d.dirs.flatMap(filesUnder)]
}
