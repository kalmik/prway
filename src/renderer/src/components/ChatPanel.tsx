// Chat about the PR: the conversation (Chat tab) and the prompt bar under the bottom panel.

import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '../../../shared/types'
import { Markdown } from './Markdown'

export function ChatLog({
  messages,
  busy,
  error,
  onCodeRef,
  onOpenUrl,
  onClear,
  onAsk
}: {
  messages: ChatMessage[]
  busy: boolean
  error: string | null
  onCodeRef: (path: string, line: number) => void
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
          {m.role === 'user' ? <p>{m.text}</p> : <Markdown text={m.text} onCodeRef={onCodeRef} onLink={onOpenUrl} />}
        </div>
      ))}
      {busy && <div className="msg assistant muted small">Thinking…</div>}
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

export function ChatBar({ busy, onSend }: { busy: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('')
  function send() {
    if (!text.trim() || busy) return
    onSend(text.trim())
    setText('')
  }
  return (
    <div className="chat-bar">
      <textarea
        rows={1}
        placeholder="Ask about this PR…  (Enter to send, Shift+Enter for a new line)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
          }
        }}
      />
      <button className="primary" disabled={busy || !text.trim()} onClick={send}>
        {busy ? '…' : 'Ask'}
      </button>
    </div>
  )
}
