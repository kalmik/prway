// A read-only view of a file the PR did not change, opened by "go to definition" or a reference.

import { Editor } from '@monaco-editor/react'
import { useEffect, useRef, useState } from 'react'
import { languageFor, monaco, MONO_FONT } from '../monaco'
import { errorText } from '../util'
import { attachCodeNav, type NavHandlers } from './codeNav'
import { Loading } from './Loading'

const api = window.prway

export function FileViewer({
  repo,
  number,
  headSha,
  path,
  line,
  dark,
  nav
}: {
  repo: string
  number: number
  headSha: string
  path: string
  line: number
  dark: boolean
  nav: NavHandlers
}) {
  const [text, setText] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [editor, setEditor] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    let current = true
    setText(null)
    setNote(null)
    api.code.readFile(repo, number, path).then(
      (f) => {
        if (!current) return
        if (f.skipped) setNote(f.skipped === 'binary' ? 'Binary file, not shown.' : 'File is too large to show.')
        else setText(f.text)
      },
      (err) => current && setNote(errorText(err))
    )
    return () => {
      current = false
    }
  }, [repo, number, path])

  useEffect(() => {
    if (!editor) return
    const d = attachCodeNav(editor, () => navRef.current)
    return () => d.dispose()
  }, [editor])

  useEffect(() => {
    if (!editor || text === null) return
    const id = requestAnimationFrame(() => {
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
      const deco = editor.createDecorationsCollection([
        { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'nav-target-line' } }
      ])
      setTimeout(() => deco.clear(), 1500)
    })
    return () => cancelAnimationFrame(id)
  }, [editor, text, line])

  if (note) return <div className="center muted">{note}</div>
  if (text === null) return <div className="center">
        <Loading>Loading {path}…</Loading>
      </div>
  return (
    <div className="editor-host">
      <Editor
        value={text}
        language={languageFor(path)}
        path={`head/${headSha}/${path}`}
        theme={dark ? 'prway-dark' : 'prway-light'}
        onMount={(ed) => setEditor(ed)}
        options={{
          readOnly: true,
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontFamily: MONO_FONT,
          fontSize: 12.5,
          lineHeight: 19,
          fontLigatures: false
        }}
      />
    </div>
  )
}
