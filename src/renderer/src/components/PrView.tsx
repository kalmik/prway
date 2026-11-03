import { DiffEditor } from '@monaco-editor/react'
import { useEffect, useMemo, useState } from 'react'
import type { ChangedFile, FileDiff, PullDetail, WorktreeInfo } from '../../../shared/types'
import { languageFor } from '../monaco'
import { errorText, storage } from '../util'
import { ReviewBox } from './ReviewBox'

const api = window.diffscope

const STATUS_LABEL: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' }

function usePrefersDark(): boolean {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const m = window.matchMedia(query)
    const onChange = () => setDark(m.matches)
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function PrView({ repo, number }: { repo: string; number: number }) {
  const [pull, setPull] = useState<PullDetail | null>(null)
  const [tree, setTree] = useState<WorktreeInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<ChangedFile | null>(null)
  const [diff, setDiff] = useState<FileDiff | null>(null)
  const [sideBySide, setSideBySide] = useState(() => storage.get('ui.sideBySide', true))
  const [hideWhitespace, setHideWhitespace] = useState(() => storage.get('ui.hideWhitespace', true))
  const dark = usePrefersDark()

  // "Viewed" marks are tied to the PR head commit: new commits reset them.
  const viewedKey = tree ? `viewed:${repo}#${number}@${tree.headSha}` : null
  const [viewed, setViewed] = useState<Set<string>>(new Set())

  useEffect(() => {
    api.pulls.get(repo, number).then(setPull, (err) => setError(errorText(err)))
    api.worktree.prepare(repo, number).then(
      (t) => {
        setTree(t)
        setFile(t.files[0] ?? null)
      },
      (err) => setError(errorText(err))
    )
  }, [repo, number])

  useEffect(() => {
    if (viewedKey) setViewed(new Set(storage.get<string[]>(viewedKey, [])))
  }, [viewedKey])

  useEffect(() => {
    if (!file) return
    let current = true
    setDiff(null)
    api.worktree.fileDiff(repo, number, file).then(
      (d) => current && setDiff(d),
      (err) => current && setError(errorText(err))
    )
    return () => {
      current = false
    }
  }, [repo, number, file])

  function toggleViewed(path: string) {
    const next = new Set(viewed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setViewed(next)
    if (viewedKey) storage.set(viewedKey, [...next])
  }

  const language = useMemo(() => (file ? languageFor(file.path) : 'plaintext'), [file])

  return (
    <div className="pr-view">
      <div className="pr-header">
        <div>
          <h2>
            {pull?.title ?? 'Loading…'} <span className="muted">#{number}</span>
          </h2>
          {pull && (
            <p className="small muted">
              {pull.author} wants to merge <code>{pull.headRef}</code> into <code>{pull.baseRef}</code> ·{' '}
              <span className="add">+{pull.additions}</span> <span className="del">−{pull.deletions}</span> ·{' '}
              {pull.changedFiles} files
            </p>
          )}
        </div>
        <div className="row">
          {pull && <button onClick={() => api.openExternal(pull.url)}>Open on GitHub</button>}
          <button disabled={!tree} onClick={() => api.worktree.reveal(repo, number).catch((e) => setError(errorText(e)))}>
            Open worktree folder
          </button>
        </div>
      </div>

      {error && (
        <p className="error pad">
          {error} <button className="link" onClick={() => setError(null)}>dismiss</button>
        </p>
      )}

      {!tree && !error && (
        <div className="center muted">Preparing worktree… (the first PR of a repo needs a clone, which can take a while)</div>
      )}

      {tree && (
        <div className="review-area">
          <div className="files">
            <div className="files-header small muted">
              {viewed.size}/{tree.files.length} viewed
              <div className="progress">
                <div style={{ width: `${tree.files.length ? (viewed.size / tree.files.length) * 100 : 0}%` }} />
              </div>
            </div>
            <ul>
              {tree.files.map((f) => (
                <li key={f.path} className={f === file ? 'active' : ''}>
                  <input
                    type="checkbox"
                    title="Mark as viewed"
                    checked={viewed.has(f.path)}
                    onChange={() => toggleViewed(f.path)}
                  />
                  <button className={`file ${viewed.has(f.path) ? 'viewed' : ''}`} onClick={() => setFile(f)} title={f.path}>
                    <span className={`status s-${f.status}`} title={STATUS_LABEL[f.status]}>
                      {f.status}
                    </span>
                    <span className="file-name">{f.path.split('/').pop()}</span>
                    <span className="file-dir">{f.path.split('/').slice(0, -1).join('/')}</span>
                  </button>
                </li>
              ))}
            </ul>
            {pull && <ReviewBox repo={repo} number={number} />}
          </div>

          <div className="diff">
            <div className="diff-toolbar small">
              <span className="file-path">
                {file?.oldPath ? `${file.oldPath} → ` : ''}
                {file?.path}
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={sideBySide}
                  onChange={(e) => {
                    setSideBySide(e.target.checked)
                    storage.set('ui.sideBySide', e.target.checked)
                  }}
                />{' '}
                Side by side
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={hideWhitespace}
                  onChange={(e) => {
                    setHideWhitespace(e.target.checked)
                    storage.set('ui.hideWhitespace', e.target.checked)
                  }}
                />{' '}
                Hide whitespace changes
              </label>
            </div>
            {!file && <div className="center muted">This PR has no file changes.</div>}
            {file && !diff && <div className="center muted">Loading file…</div>}
            {diff?.skipped && (
              <div className="center muted">{diff.skipped === 'binary' ? 'Binary file, not shown.' : 'File is too large to show.'}</div>
            )}
            {file && diff && !diff.skipped && (
              <DiffEditor
                original={diff.original}
                modified={diff.modified}
                language={language}
                originalModelPath={`base/${tree.mergeBase}/${file.oldPath ?? file.path}`}
                modifiedModelPath={`head/${tree.headSha}/${file.path}`}
                theme={dark ? 'vs-dark' : 'vs'}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: sideBySide,
                  ignoreTrimWhitespace: hideWhitespace,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  renderOverviewRuler: true,
                  // Fold long runs of unchanged lines so the focus stays on what changed.
                  hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 }
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
