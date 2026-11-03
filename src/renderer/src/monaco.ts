// Bundle Monaco locally instead of loading it from a CDN (the app works offline and keeps a strict CSP).
// Only syntax highlighting is loaded: language services (TS errors, etc.) make no sense on a PR diff.
// The core API ships without editor features, so the ones a review needs are imported one by one.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import 'monaco-editor/features/codicon/register' // icon font: diff +/- markers, folded-region icons
import 'monaco-editor/features/hover/register' // notes on focus lines and comments
import 'monaco-editor/features/find/register'
import 'monaco-editor/features/contextmenu/register'
import 'monaco-editor/features/clipboard/register'
import 'monaco-editor/features/wordHighlighter/register'
import 'monaco-editor/features/bracketMatching/register'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

export { monaco }

/** Same monospace stack everywhere, so Monaco measures the font it actually draws with. */
export const MONO_FONT = "'SF Mono', ui-monospace, Menlo, Monaco, 'Cascadia Mono', Consolas, 'DejaVu Sans Mono', monospace"

// Diff colours with good text contrast (GitHub-like): a soft tint for the line, a slightly stronger one for
// the changed characters. Monaco paints both on fully added/removed lines, so together they must stay light.
// Monaco's defaults are much brighter and wash out the code on top of them.
monaco.editor.defineTheme('prway-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#0d1117',
    'editorGutter.background': '#0d1117',
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': '#c9d1d9',
    'editor.lineHighlightBackground': '#ffffff08',
    'diffEditor.insertedLineBackground': '#2ea0431a',
    'diffEditor.insertedTextBackground': '#2ea04333',
    'diffEditor.removedLineBackground': '#f851491a',
    'diffEditor.removedTextBackground': '#f8514933',
    'diffEditorGutter.insertedLineBackground': '#2ea0434d',
    'diffEditorGutter.removedLineBackground': '#f851494d',
    'diffEditorOverview.insertedForeground': '#2ea04399',
    'diffEditorOverview.removedForeground': '#f8514999',
    'diffEditor.diagonalFill': '#30363d99',
    'diffEditor.unchangedRegionBackground': '#161b22',
    'diffEditor.unchangedRegionForeground': '#8b949e'
  }
})
monaco.editor.defineTheme('prway-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editorLineNumber.foreground': '#8c959f',
    'diffEditor.insertedLineBackground': '#e6ffec',
    'diffEditor.insertedTextBackground': '#c6f6d0',
    'diffEditor.removedLineBackground': '#ffebe9',
    'diffEditor.removedTextBackground': '#ffdcd9',
    'diffEditorGutter.insertedLineBackground': '#ccffd8',
    'diffEditorGutter.removedLineBackground': '#ffd7d5',
    'diffEditor.diagonalFill': '#d0d7de99',
    'diffEditor.unchangedRegionBackground': '#f6f8fa',
    'diffEditor.unchangedRegionForeground': '#57606a'
  }
})

// Monaco measures character widths once; if a font loads later, cursors and selections drift.
void document.fonts?.ready.then(() => monaco.editor.remeasureFonts())

/** Picks a Monaco language id from a file path, e.g. "src/a.ts" -> "typescript". */
export function languageFor(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
    if (lang.extensions?.some((ext) => name.endsWith(ext.toLowerCase()))) return lang.id
  }
  return 'plaintext'
}
