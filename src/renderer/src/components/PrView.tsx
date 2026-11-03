import { DiffEditor, type DiffOnMount } from '@monaco-editor/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangedFile, FileDiff, GuideFile, PullDetail, ReviewGuide, WorktreeInfo } from '../../../shared/types'
import { languageFor, monaco } from '../monaco'
import { errorText, storage } from '../util'
import { FileList } from './FileList'
import { GuidePanel } from './GuidePanel'
import { ReviewBox } from './ReviewBox'

const api = window.prway

type DiffEditorInstance = Parameters<DiffOnMount>[0]

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
  const [guide, setGuide] = useState<ReviewGuide | null>(null)
  const [guideBusy, setGuideBusy] = useState(false)
  const [guideError, setGuideError] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(() => storage.get('ui.guideOpen', true))
  const [sideBySide, setSideBySide] = useState(() => storage.get('ui.sideBySide', true))
  const [hideWhitespace, setHideWhitespace] = useState(() => storage.get('ui.hideWhitespace', true))
  const [editor, setEditor] = useState<DiffEditorInstance | null>(null)
  const pendingReveal = useRef<number | null>(null)
  const dark = usePrefersDark()

  // "Viewed" marks are tied to the PR head commit: new commits reset them.
  const viewedKey = tree ? `viewed:${repo}#${number}@${tree.headSha}` : null
  const [viewed, setViewed] = useState<Set<string>>(new Set())

  useEffect(() => {
    api.pulls.get(repo, number).then(setPull, (err) => setError(errorText(err)))
    api.worktree.prepare(repo, number).then(
      async (t) => {
        setTree(t)
        const saved = await api.guide.get(repo, number)
        setGuide(saved)
        // Start with the first file of the reading order, else the first file that isn't noise.
        const first = saved?.files[0]?.path
        setFile(t.files.find((f) => f.path === first) ?? t.files.find((f) => !f.noise) ?? t.files[0] ?? null)
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

  const guideFile: GuideFile | undefined = useMemo(
    () => guide?.files.find((g) => g.path === file?.path),
    [guide, file]
  )

  // Highlight the guide's focus lines in the new version of the file.
  useEffect(() => {
    if (!editor || !diff || diff.skipped) return
    const modified = editor.getModifiedEditor()
    const collection = modified.createDecorationsCollection(
      (guideFile?.focus ?? []).map((f) => ({
        range: new monaco.Range(f.line, 1, f.line, 1),
        options: {
          isWholeLine: true,
          className: 'focus-line',
          glyphMarginClassName: 'focus-glyph',
          hoverMessage: { value: `**Focus:** ${f.note}` }
        }
      }))
    )
    if (pendingReveal.current) {
      const line = pendingReveal.current
      pendingReveal.current = null
      // Wait one frame so the new model is laid out before scrolling.
      requestAnimationFrame(() => {
        modified.revealLineInCenter(line)
        modified.setPosition({ lineNumber: line, column: 1 })
      })
    }
    return () => collection.clear()
  }, [editor, diff, guideFile])

  function toggleViewed(path: string) {
    const next = new Set(viewed)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setViewed(next)
    if (viewedKey) storage.set(viewedKey, [...next])
  }

  /** Opens a file and scrolls to a line once its diff has loaded. */
  function goTo(path: string, line: number | null) {
    const target = tree?.files.find((f) => f.path === path)
    if (!target) return
    if (target.path === file?.path && line && editor) {
      const modified = editor.getModifiedEditor()
      modified.revealLineInCenter(line)
      modified.setPosition({ lineNumber: line, column: 1 })
      return
    }
    pendingReveal.current = line
    setFile(target)
  }

  async function generateGuide() {
    setGuideBusy(true)
    setGuideError(null)
    try {
      const g = await api.guide.generate(repo, number)
      setGuide(g)
      // The worktree was refreshed; pick up new commits if any.
      if (tree && g.headSha !== tree.headSha) setTree(await api.worktree.prepare(repo, number))
    } catch (err) {
      setGuideError(errorText(err))
    } finally {
      setGuideBusy(false)
    }
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
          <button
            className={guideOpen ? 'active-toggle' : ''}
            onClick={() => {
              setGuideOpen(!guideOpen)
              storage.set('ui.guideOpen', !guideOpen)
            }}
          >
            Guide {guideOpen ? '▸' : '◂'}
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
            <FileList
              files={tree.files}
              guide={guide}
              selected={file}
              viewed={viewed}
              onSelect={setFile}
              onToggleViewed={toggleViewed}
            />
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

            {file?.noise && <div className="file-note noise-note small">Skippable: {file.noise.reason}</div>}
            {guideFile && (
              <div className={`file-note small risk-${guideFile.risk}`}>
                <strong>{guideFile.risk} risk</strong> · {guideFile.role} — {guideFile.why}
                {guideFile.focus.length > 0 && (
                  <span className="focus-links">
                    {guideFile.focus.map((f) => (
                      <button key={f.line} className="link" title={f.note} onClick={() => goTo(guideFile.path, f.line)}>
                        L{f.line}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            )}

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
                onMount={(ed) => setEditor(ed)}
                options={{
                  readOnly: true,
                  originalEditable: false,
                  renderSideBySide: sideBySide,
                  ignoreTrimWhitespace: hideWhitespace,
                  automaticLayout: true,
                  minimap: { enabled: false },
                  glyphMargin: true,
                  scrollBeyondLastLine: false,
                  renderOverviewRuler: true,
                  // Fold long runs of unchanged lines so the focus stays on what changed.
                  hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 5 }
                }}
              />
            )}
          </div>

          {guideOpen && (
            <GuidePanel
              guide={guide}
              stale={!!guide && guide.headSha !== tree.headSha}
              busy={guideBusy}
              error={guideError}
              onGenerate={generateGuide}
              onGoTo={goTo}
            />
          )}
        </div>
      )}
    </div>
  )
}
