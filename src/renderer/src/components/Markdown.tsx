// Tiny, safe markdown for comments and chat answers: fenced code, inline code, bold, links and
// clickable "path:line" references. Builds React elements (no innerHTML), so nothing can inject HTML.

import { Fragment, type ReactNode } from 'react'

interface Props {
  text: string
  /** Called for "path/to/file.ext:123" references; links are shown only when given. */
  onCodeRef?: (path: string, line: number) => void
  onLink?: (url: string) => void
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https:\/\/[^)\s]+\))|((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]{1,10}:\d+)/g

function inline(text: string, props: Props, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyBase}-${i++}`
    const [all, code, bold, link, ref] = m
    if (code) out.push(<code key={key}>{code.slice(1, -1)}</code>)
    else if (bold) out.push(<strong key={key}>{bold.slice(2, -2)}</strong>)
    else if (link) {
      const lm = /^\[([^\]]+)\]\((.+)\)$/.exec(link)!
      out.push(
        props.onLink ? (
          <button key={key} className="link" onClick={() => props.onLink!(lm[2])}>
            {lm[1]}
          </button>
        ) : (
          lm[1]
        )
      )
    } else if (ref && props.onCodeRef) {
      const at = ref.lastIndexOf(':')
      out.push(
        <button key={key} className="link code-ref" onClick={() => props.onCodeRef!(ref.slice(0, at), Number(ref.slice(at + 1)))}>
          {ref}
        </button>
      )
    } else out.push(all)
    last = m.index + all.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** GitHub bodies (bots especially) carry HTML comments and tags; keep only their text. */
function stripHtml(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(details|summary|p|div|span|sub|sup|b|i|em|strong|img|a|table|thead|tbody|tr|td|th|ul|ol|li|h\d|blockquote|code|pre)\b[^>]*>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function Markdown(props: Props) {
  const parts = stripHtml(props.text).split(/```[\w-]*\n?/)
  return (
    <div className="md">
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <pre key={i}>
            <code>{part.replace(/\n$/, '')}</code>
          </pre>
        ) : (
          <Fragment key={i}>
            {part
              .split(/\n{2,}/)
              .filter((p) => p.trim())
              .map((para, j) => {
                const lines = para.split('\n')
                const isList = lines.every((l) => /^\s*([-*]|\d+\.)\s/.test(l) || !l.trim())
                if (isList) {
                  return (
                    <ul key={j} className="bullets">
                      {lines
                        .filter((l) => l.trim())
                        .map((l, k) => (
                          <li key={k}>{inline(l.replace(/^\s*([-*]|\d+\.)\s/, ''), props, `${i}-${j}-${k}`)}</li>
                        ))}
                    </ul>
                  )
                }
                const heading = /^#{1,4}\s+(.*)$/.exec(para)
                if (heading && lines.length === 1) return <h5 key={j}>{inline(heading[1], props, `${i}-${j}`)}</h5>
                return (
                  <p key={j}>
                    {lines.map((l, k) => (
                      <Fragment key={k}>
                        {k > 0 && <br />}
                        {inline(l, props, `${i}-${j}-${k}`)}
                      </Fragment>
                    ))}
                  </p>
                )
              })}
          </Fragment>
        )
      )}
    </div>
  )
}
