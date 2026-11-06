// Inline review comments inside the Monaco diff: GitHub threads, your pending drafts, and the box
// to write a new one. Each group is shown in a Monaco "view zone" under its line.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { DraftComment, ReviewThread } from '../../../shared/types'
import type { monaco } from '../monaco'
import { errorText, timeAgo } from '../util'
import { Markdown, plainPreview } from './Markdown'
import { BusyButton } from './Loading'

type CodeEditor = monaco.editor.IStandaloneCodeEditor

export interface ZoneSpec {
  key: string
  /** The zone is shown under this line. */
  line: number
  node: ReactNode
  /** As wide as the visible code (comment boxes stop at a readable width). */
  wide?: boolean
}

interface LiveZone {
  wide: boolean
  id: string
  line: number
  zone: monaco.editor.IViewZone
  root: Root
  observer: ResizeObserver
}

// Monaco handles keys and clicks on its whole DOM; stop them at the zone so text boxes work normally.
const STOPPED_EVENTS = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'dblclick', 'keydown', 'keyup', 'keypress', 'contextmenu']

/** Renders React content in Monaco view zones, one per spec, sized to their content. */
export function useViewZones(editor: CodeEditor | null, specs: ZoneSpec[]): void {
  const zones = useRef(new Map<string, LiveZone>())

  useEffect(() => {
    if (!editor) return
    const live = zones.current
    const wanted = new Map(specs.map((s) => [s.key, s]))
    editor.changeViewZones((acc) => {
      for (const [key, z] of live) {
        const spec = wanted.get(key)
        if (spec && spec.line === z.line) continue
        acc.removeZone(z.id)
        z.observer.disconnect()
        setTimeout(() => z.root.unmount()) // React can't unmount a root while it renders
        live.delete(key)
      }
      for (const spec of specs) {
        if (live.has(spec.key)) continue
        const domNode = document.createElement('div')
        domNode.className = 'zone-host'
        const inner = document.createElement('div')
        inner.className = 'zone-inner'
        domNode.appendChild(inner)
        for (const ev of STOPPED_EVENTS) domNode.addEventListener(ev, (e) => e.stopPropagation())
        const zone: monaco.editor.IViewZone = { afterLineNumber: spec.line, heightInPx: 60, domNode }
        const z: LiveZone = {
          wide: !!spec.wide,
          id: acc.addZone(zone),
          line: spec.line,
          zone,
          root: createRoot(inner),
          observer: new ResizeObserver(() => {
            const h = Math.ceil(inner.getBoundingClientRect().height) + 10
            if (Math.abs(h - (zone.heightInPx ?? 0)) < 2) return
            zone.heightInPx = h
            editor.changeViewZones((a) => a.layoutZone(z.id))
          })
        }
        z.observer.observe(inner)
        fitWidth(editor, inner, z.wide)
        live.set(spec.key, z)
      }
    })
    for (const spec of specs) live.get(spec.key)?.root.render(spec.node)
  }, [editor, specs])

  // Keep zones as wide as the visible editor (they live in the scrolling content area).
  useEffect(() => {
    if (!editor) return
    const d = editor.onDidLayoutChange(() => zones.current.forEach((z) => fitWidth(editor, z.zone.domNode.firstElementChild as HTMLElement, z.wide)))
    return () => d.dispose()
  }, [editor])

  // Remove everything when the editor goes away or the component unmounts.
  useEffect(() => {
    const live = zones.current
    return () => {
      if (editor) {
        try {
          editor.changeViewZones((acc) => live.forEach((z) => acc.removeZone(z.id)))
        } catch {
          /* editor already disposed */
        }
      }
      live.forEach((z) => {
        z.observer.disconnect()
        setTimeout(() => z.root.unmount())
      })
      live.clear()
    }
  }, [editor])
}

function fitWidth(editor: CodeEditor, inner: HTMLElement | null, wide = false): void {
  if (!inner) return
  const { contentWidth, verticalScrollbarWidth } = editor.getLayoutInfo()
  inner.style.width = `${Math.max(240, Math.min(wide ? Infinity : 760, contentWidth - verticalScrollbarWidth - 16))}px`
}

// ---- Content of a zone ----

export interface CommentActions {
  onReply: (thread: ReviewThread, body: string) => Promise<void>
  onResolve: (thread: ReviewThread, resolved: boolean) => Promise<void>
  onSaveDraft: (draft: DraftComment) => void
  onDeleteDraft: (id: string) => void
  onCancelCompose: () => void
  onAddDraft: (body: string) => void
  onOpenUrl: (url: string) => void
  onCodeRef: (path: string, line: number) => void
}

function Avatar({ src }: { src: string }) {
  return src ? <img className="avatar-sm" src={src} alt="" /> : <span className="avatar-sm" />
}

function Box({
  placeholder,
  initial = '',
  submitLabel,
  onSubmit,
  onCancel,
  autoFocus
}: {
  placeholder: string
  initial?: string
  submitLabel: string
  onSubmit: (text: string) => Promise<void> | void
  onCancel?: () => void
  autoFocus?: boolean
}) {
  const [text, setText] = useState(initial)
  // Monaco attaches view zones to the page after React renders them, so `autoFocus` fires too early.
  // Focus once attached, without letting the browser scroll the editor.
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    let tries = 0
    const t = setInterval(() => {
      if (area.current?.isConnected || ++tries > 20) {
        clearInterval(t)
        area.current?.focus({ preventScroll: true })
      }
    }, 30)
    return () => clearInterval(t)
  }, [autoFocus])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit() {
    if (!text.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text.trim())
      setText('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="comment-box">
      <textarea
        ref={area}
        rows={3}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit()
          if (e.key === 'Escape') onCancel?.()
        }}
      />
      <div className="row end">
        {error && <span className="small error spacer">{error}</span>}
        {onCancel && <button onClick={onCancel}>Cancel</button>}
        <button className="primary" disabled={busy || !text.trim()} onClick={submit} title="⌘/Ctrl + Enter">
          {busy ? 'Sending…' : submitLabel}
        </button>
      </div>
    </div>
  )
}

function Thread({ thread, actions }: { thread: ReviewThread; actions: CommentActions }) {
  const [open, setOpen] = useState(!thread.resolved)
  const [replying, setReplying] = useState(false)
  const first = thread.comments[0]
  return (
    <div className={`thread ${thread.resolved ? 'resolved' : ''}`}>
      <div className="thread-head small">
        <button className="link muted" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {thread.comments.length} comment{thread.comments.length > 1 ? 's' : ''}
        </button>
        {thread.resolved && <span className="tag">resolved</span>}
        {!open && first && <span className="muted ellipsis">{first.author}: {plainPreview(first.body)}</span>}
        <span className="spacer" />
        <BusyButton className="link" busyLabel={thread.resolved ? 'Unresolving' : 'Resolving'} onClick={() => actions.onResolve(thread, !thread.resolved)}>
          {thread.resolved ? 'Unresolve' : 'Resolve'}
        </BusyButton>
        {first && (
          <button className="link" onClick={() => actions.onOpenUrl(first.url)}>
            GitHub ↗
          </button>
        )}
      </div>
      {open && (
        <>
          {thread.comments.map((c) => (
            <div key={c.id} className="comment">
              <div className="comment-meta small">
                <Avatar src={c.authorAvatar} /> <strong>{c.author}</strong> <span className="muted">{timeAgo(c.createdAt)}</span>
              </div>
              <Markdown text={c.body} onCodeRef={actions.onCodeRef} onLink={actions.onOpenUrl} />
            </div>
          ))}
          {replying ? (
            <Box
              autoFocus
              placeholder="Reply (sent right away)…"
              submitLabel="Reply"
              onSubmit={async (t) => {
                await actions.onReply(thread, t)
                setReplying(false)
              }}
              onCancel={() => setReplying(false)}
            />
          ) : (
            <button className="reply-stub small" onClick={() => setReplying(true)}>
              Reply…
            </button>
          )}
        </>
      )}
    </div>
  )
}

function Draft({ draft, stale, actions }: { draft: DraftComment; stale: boolean; actions: CommentActions }) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="thread draft">
      <div className="thread-head small">
        <span className="tag pending">pending</span>
        {draft.outside && (
          <span className="tag" title="This line isn't in the diff, so GitHub gets it as a comment on the file, starting with a link to the line (shown as a code snippet)">
            file comment
          </span>
        )}
        {draft.startLine && <span className="muted">lines {draft.startLine}–{draft.line}</span>}
        {stale && <span className="warn-chip">written on an older commit: check the line</span>}
        <span className="spacer" />
        <button className="link" onClick={() => setEditing(!editing)}>
          {editing ? 'Cancel' : 'Edit'}
        </button>
        <button className="link danger" onClick={() => actions.onDeleteDraft(draft.id)}>
          Delete
        </button>
      </div>
      {editing ? (
        <Box
          autoFocus
          initial={draft.body}
          placeholder="Comment"
          submitLabel="Save"
          onSubmit={(t) => {
            actions.onSaveDraft({ ...draft, body: t })
            setEditing(false)
          }}
        />
      ) : (
        <div className="comment">
          <Markdown text={draft.body} onCodeRef={actions.onCodeRef} />
        </div>
      )}
    </div>
  )
}

export function LineComments({
  threads,
  drafts,
  composing,
  headSha,
  actions
}: {
  threads: ReviewThread[]
  drafts: DraftComment[]
  composing: { startLine?: number; line: number; outside?: boolean } | null
  headSha: string
  actions: CommentActions
}) {
  return (
    <div className="line-comments">
      {threads.map((t) => (
        <Thread key={t.id} thread={t} actions={actions} />
      ))}
      {drafts.map((d) => (
        <Draft key={d.id} draft={d} stale={d.headSha !== headSha} actions={actions} />
      ))}
      {composing && (
        <div className="thread composing">
          {composing.startLine && !composing.outside && (
            <div className="small muted">
              Lines {composing.startLine}–{composing.line}
            </div>
          )}
          {composing.outside && (
            <div className="small muted">
              {composing.startLine ? `Lines ${composing.startLine}–${composing.line} aren’t` : `Line ${composing.line} isn’t`} in the diff, and GitHub
              only takes line comments there: this goes as a comment on the file, starting with a link to{' '}
              {composing.startLine ? 'them' : 'it'} (GitHub shows it as a code snippet).
            </div>
          )}
          <Box
            autoFocus
            placeholder="Leave a comment. It is sent with your review."
            submitLabel="Add to review"
            onSubmit={(t) => actions.onAddDraft(t)}
            onCancel={actions.onCancelCompose}
          />
        </div>
      )}
    </div>
  )
}
