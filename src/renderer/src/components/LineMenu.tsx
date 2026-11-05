// The menu that opens when you click a line number (or drag over several): comment, ask in chat, copy a reference…

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { monaco } from '../monaco'
import { selectedLines } from './codeNav'

export interface LineMenuItem {
  label: string
  hint?: string
  /** Shown greyed out with this explanation instead of running. */
  disabledReason?: string
  run: () => void
}

export interface LineMenuAt {
  x: number
  y: number
  start: number
  end: number
}

const GUTTER = new Set<number>([
  monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN,
  monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
  monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
])

/**
 * Opens the line menu on a click in the gutter. Dragging over line numbers (or shift-clicking) covers several lines;
 * the lines get selected so it's clear what the menu is about.
 */
export function attachLineMenu(editor: monaco.editor.ICodeEditor, open: (at: LineMenuAt) => void): monaco.IDisposable {
  let down: number | null = null
  const subs = [
    editor.onMouseDown((e) => {
      down = e.event.leftButton && GUTTER.has(e.target.type) && e.target.position ? e.target.position.lineNumber : null
    }),
    editor.onMouseUp((e) => {
      if (down === null) return
      const line = e.target.position?.lineNumber ?? down
      down = null
      const sel = selectedLines(editor)
      const lines = sel && sel.end > sel.start && line >= sel.start && line <= sel.end ? sel : { start: line, end: line }
      const model = editor.getModel()
      if (model) editor.setSelection(new monaco.Range(lines.start, 1, lines.end, model.getLineMaxColumn(lines.end)))
      open({ x: e.event.browserEvent.clientX, y: e.event.browserEvent.clientY, ...lines })
    })
  ]
  return { dispose: () => subs.forEach((d) => d.dispose()) }
}

export function LineMenu({
  at,
  items,
  header,
  onClose
}: {
  at: LineMenuAt
  items: LineMenuItem[]
  /** Shown above the actions (e.g. the guide's focus note on this line, with rating buttons). */
  header?: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x + 6, top: at.y + 6 })
  // Keep it on screen: flip above the click near the bottom, shift left near the right edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(at.x + 6, window.innerWidth - width - 8)),
      top: at.y + 6 + height > window.innerHeight - 8 ? Math.max(8, at.y - height - 6) : at.y + 6
    })
  }, [at])
  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', outside, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('wheel', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', outside, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('wheel', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const lines = at.start === at.end ? `Line ${at.start}` : `Lines ${at.start}–${at.end}`
  return (
    <div className="line-menu" ref={ref} style={pos} role="menu">
      <div className="line-menu-title">{lines}</div>
      {header}
      {items.map((item) => (
        <button
          key={item.label}
          role="menuitem"
          disabled={!!item.disabledReason}
          title={item.disabledReason}
          onClick={() => {
            onClose()
            item.run()
          }}
        >
          <span>{item.label}</span>
          {item.hint && <kbd>{item.hint}</kbd>}
        </button>
      ))}
    </div>
  )
}

/** "path:12" or "path:12-15", for pasting into Slack, an issue… */
export function copyReference(path: string, start: number, end: number): void {
  void navigator.clipboard.writeText(start === end ? `${path}:${start}` : `${path}:${start}-${end}`)
}
