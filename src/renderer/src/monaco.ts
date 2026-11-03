// Bundle Monaco locally instead of loading it from a CDN (the app works offline and keeps a strict CSP).
// Only syntax highlighting is loaded: language services (TS errors, etc.) make no sense on a PR diff.
import * as monaco from 'monaco-editor/editor/editor.api'
import 'monaco-editor/basic-languages/monaco.contribution'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import { loader } from '@monaco-editor/react'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
loader.config({ monaco })

export { monaco }

/** Picks a Monaco language id from a file path, e.g. "src/a.ts" -> "typescript". */
export function languageFor(path: string): string {
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.filenames?.some((f) => f.toLowerCase() === name)) return lang.id
    if (lang.extensions?.some((ext) => name.endsWith(ext.toLowerCase()))) return lang.id
  }
  return 'plaintext'
}
