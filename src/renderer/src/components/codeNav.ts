// Go to definition / find references on any Monaco editor: F12, Shift+F12, ⌘/Ctrl+click, and the context menu.

import { monaco } from '../monaco'

export interface NavRequest {
  word: string
  /** Text before a dot, e.g. "Repo" in "Repo.get" (used to rank definitions). */
  qualifier?: string
}

export interface NavHandlers {
  onDefinition: (req: NavRequest) => void
  onReferences: (req: NavRequest) => void
}

/** The identifier under the cursor, including Elixir/Ruby "?" and "!" suffixes and a dotted qualifier. */
export function wordAt(model: monaco.editor.ITextModel, pos: monaco.IPosition): NavRequest | null {
  const w = model.getWordAtPosition(pos)
  if (!w) return null
  const line = model.getLineContent(pos.lineNumber)
  let word = w.word
  const next = line[w.endColumn - 1]
  if ((next === '?' || next === '!') && /^[a-z_]/.test(word)) word += next
  const before = line.slice(0, w.startColumn - 1)
  const qualifier = /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\.$/.exec(before)?.[1]
  return /^[\w$]+[?!]?$/.test(word) ? { word, qualifier } : null
}

/** Adds the navigation actions to an editor. Returns a disposer. */
export function attachCodeNav(editor: monaco.editor.IStandaloneCodeEditor, handlers: () => NavHandlers): monaco.IDisposable {
  const run = (kind: 'def' | 'refs') => (ed: monaco.editor.IStandaloneCodeEditor) => {
    const model = ed.getModel()
    const pos = ed.getPosition()
    if (!model || !pos) return
    const req = wordAt(model, pos)
    if (!req) return
    if (kind === 'def') handlers().onDefinition(req)
    else handlers().onReferences(req)
  }
  const disposables = [
    editor.addAction({
      id: 'prway.goToDefinition',
      label: 'Go to Definition',
      keybindings: [monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 1,
      run: run('def')
    }),
    editor.addAction({
      id: 'prway.findReferences',
      label: 'Find References',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F12],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2,
      run: run('refs')
    }),
    editor.onMouseDown((e) => {
      if (!(e.event.metaKey || e.event.ctrlKey) || e.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return
      const model = editor.getModel()
      const pos = e.target.position
      if (!model || !pos) return
      const req = wordAt(model, pos)
      if (req) {
        e.event.preventDefault()
        handlers().onDefinition(req)
      }
    })
  ]
  return { dispose: () => disposables.forEach((d) => d.dispose()) }
}
