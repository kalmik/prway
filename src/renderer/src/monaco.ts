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
