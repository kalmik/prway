// Chat about the PR: the conversation (Chat tab) and the prompt bar under the bottom panel.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatCodeRef, ChatMessage } from '../../../shared/types'
import { Markdown } from './Markdown'
import { Loading } from './Loading'

const fileName = (path: string) => path.split('/').pop() ?? path
const lines = (r: ChatCodeRef) => (r.startLine === r.endLine ? `${r.startLine}` : `${r.startLine}–${r.endLine}`)

/** A chip for attached code: "file.ex:10–14", the old version marked. */
function RefChip({ r, onOpen, onRemove }: { r: ChatCodeRef; onOpen: () => void; onRemove?: () => void }) {
  return (
    <span className="chat-ref" title={`${r.path}, lines ${lines(r)}${r.side === 'base' ? ' (before the PR)' : ''}`}>
      <button className="link" onClick={onOpen}>
        {fileName(r.path)}:{lines(r)}
        {r.side === 'base' && <span className="muted"> (old)</span>}
      </button>
      {onRemove && (
        <button className="chat-ref-remove" onClick={onRemove} title="Remove">
          ×
        </button>
      )}
    </span>
  )
}

export function ChatLog({
  messages,
  busy,
  error,
  onCodeRef,
  onOpenRef,
  onOpenUrl,
  onClear,
  onAsk,
  account
}: {
  /** The AI account that will answer (its name). */
  account?: string
  messages: ChatMessage[]
  busy: boolean
  error: string | null
  onCodeRef: (path: string, line: number) => void
  onOpenRef: (ref: ChatCodeRef) => void
  onOpenUrl: (url: string) => void
  onClear: () => void
  onAsk: (q: string) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  // Braces matter: scrollIntoView returns a Promise in recent Chromium, and an effect must return nothing or a cleanup.
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, busy])

  if (!messages.length && !busy) {
    return (
      <div className="panel-body chat-empty small muted">
        <p>Ask anything about this PR. The diff, the guide and the repository context are sent with your question.</p>
        <p>
          To ask about specific lines, click a line number in the code (drag for several) and pick Ask in Chat, or select the code and press <kbd>⌘L</kbd>.
        </p>
        <div className="suggestions">
          {[
            'What could break in production with this change?',
            'Which callers are affected, and are they tested?',
            'Is anything in the diff not explained by the description?'
          ].map((q) => (
            <button key={q} className="chip" onClick={() => onAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className="panel-body chat-log">
      {messages.map((m, i) => (
        <div key={i} className={`msg ${m.role}`}>
          {m.role === 'user' ? (
            <>
              {!!m.refs?.length && (
                <div className="chat-refs">
                  {m.refs.map((r, j) => (
                    <RefChip key={j} r={r} onOpen={() => onOpenRef(r)} />
                  ))}
                </div>
              )}
              <p>{m.text}</p>
            </>
          ) : (
            <>
              <Markdown text={m.text} onCodeRef={onCodeRef} onLink={onOpenUrl} />
              {m.account && <div className="msg-via small muted">via {m.account}</div>}
            </>
          )}
        </div>
      ))}
      {busy && (
        <div className="msg assistant small">
          <Loading elapsed>Thinking{account ? ` (${account})` : ''}…</Loading>
        </div>
      )}
      {error && <p className="small error">{error}</p>}
      {messages.length > 0 && !busy && (
        <button className="link small" onClick={onClear}>
          Clear conversation
        </button>
      )}
      <div ref={end} />
    </div>
  )
}

export function ChatBar({
  busy,
  onSend,
  refs,
  focus,
  onRemoveRef,
  onOpenRef,
  badge
}: {
  /** Shows which AI account answers. */
  badge?: ReactNode
  busy: boolean
  onSend: (text: string) => void
  refs: ChatCodeRef[]
  /** Focuses the box whenever it changes (after code is attached). */
  focus: number
  onRemoveRef: (ref: ChatCodeRef) => void
  onOpenRef: (ref: ChatCodeRef) => void
}) {
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (focus) box.current?.focus()
  }, [focus])
  function send() {
    if (!text.trim() || busy) return
    onSend(text.trim())
    setText('')
  }
  return (
    <div className="chat-bar">
      <div className="chat-input">
        {refs.length > 0 && (
          <div className="chat-refs">
            {refs.map((r, i) => (
              <RefChip key={i} r={r} onOpen={() => onOpenRef(r)} onRemove={() => onRemoveRef(r)} />
            ))}
          </div>
        )}
        <textarea
          ref={box}
          rows={1}
          placeholder={
            refs.length
              ? 'Ask about the attached lines…  (Enter to send, Shift+Enter for a new line)'
              : 'Ask about this PR…  (Enter to send, Shift+Enter for a new line; click a line number to ask about it)'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
      </div>
      {badge}
      <button className="primary" disabled={busy || !text.trim()} onClick={send}>
        {busy ? '…' : 'Ask'}
      </button>
    </div>
  )
}
