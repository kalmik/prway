// Go to definition / find references on any Monaco editor: F12, Shift+F12, ⌘/Ctrl+click, and the context menu.

import type { ChatCodeRef } from '../../../shared/types'
import { monaco } from '../monaco'

/** Longest code excerpt attached to a chat question. */
const MAX_REF_LINES = 300

export interface NavRequest {
  word: string
  /** Text before a dot, e.g. "Repo" in "Repo.get" (used to rank definitions). */
  qualifier?: string
}

export interface NavHandlers {
  onDefinition: (req: NavRequest) => void
  onReferences: (req: NavRequest) => void
  /** Attaches the selected lines (or the cursor line) to the chat box. */
  onAskChat?: (ref: ChatCodeRef) => void
}

/** Lines of an editor's file as a chat reference. Model paths look like `head/<sha>/<file>`. */
export function linesRef(editor: monaco.editor.ICodeEditor, startLine: number, endLine: number): ChatCodeRef | null {
  const model = editor.getModel()
  if (!model) return null
  const m = /(head|base|code)\/[0-9a-f]+\/(.+)$/.exec(decodeURIComponent(model.uri.path))
  if (!m) return null
  endLine = Math.min(endLine, startLine + MAX_REF_LINES - 1, model.getLineCount())
  const code = model.getValueInRange(new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)))
  return { path: m[2], startLine, endLine, side: m[1] === 'base' ? 'base' : 'head', code }
}

/** The lines a selection covers; one ending at the start of a line doesn't include that line. */
export function selectedLines(editor: monaco.editor.ICodeEditor): { start: number; end: number } | null {
  const sel = editor.getSelection()
  if (!sel) return null
  let end = sel.endLineNumber
  if (end > sel.startLineNumber && sel.endColumn === 1) end--
  return { start: sel.startLineNumber, end }
}

/** The selected lines (or the cursor line) as a chat reference. */
function selectionRef(editor: monaco.editor.ICodeEditor): ChatCodeRef | null {
  const lines = selectedLines(editor)
  return lines && linesRef(editor, lines.start, lines.end)
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
    editor.addAction({
      id: 'prway.askChat',
      label: 'Ask in Chat About These Lines',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL],
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 3,
      run: (ed) => {
        const ref = selectionRef(ed)
        if (ref) handlers().onAskChat?.(ref)
      }
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
