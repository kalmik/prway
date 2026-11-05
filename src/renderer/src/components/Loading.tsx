// Loading feedback: a spinner for anything that waits, and the activity strip in the PR header that lists the work
// running in the background (guide, AI review, file notes, Background, chat) wherever you are in the PR.

import { useEffect, useState, type ReactNode } from 'react'

/** Seconds since it appeared. */
export function Elapsed() {
  const [s, setS] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setS((x) => x + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span>{s}s</span>
}

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />
}

/** A line saying what is loading, with a spinner (and seconds elapsed, for slow work). */
export function Loading({ children, elapsed, className = '' }: { children: ReactNode; elapsed?: boolean; className?: string }) {
  return (
    <span className={`loading ${className}`} role="status">
      <Spinner />
      <span>
        {children}
        {elapsed && (
          <>
            {' '}
            <span className="muted">
              <Elapsed />
            </span>
          </>
        )}
      </span>
    </span>
  )
}

export interface ActivityItem {
  key: string
  label: string
  title?: string
  onClick?: () => void
}

/** Work in progress for this PR. Each item counts its own seconds and jumps to where it shows. */
export function ActivityStrip({ items }: { items: ActivityItem[] }) {
  if (!items.length) return null
  return (
    <div className="activity" role="status">
      {items.map((i) => (
        <button key={i.key} className="activity-item" onClick={i.onClick} disabled={!i.onClick} title={i.title}>
          <Spinner />
          {i.label}{' '}
          <span className="muted">
            <Elapsed />
          </span>
        </button>
      ))}
    </div>
  )
}

/** A button whose action is async: disabled with a spinner and `busyLabel` until it finishes. */
export function BusyButton({
  onClick,
  busyLabel,
  className,
  title,
  children
}: {
  onClick: () => Promise<unknown>
  busyLabel: string
  className?: string
  title?: string
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={className}
      title={title}
      disabled={busy}
      onClick={() => {
        setBusy(true)
        onClick().finally(() => setBusy(false))
      }}
    >
      {busy ? <Loading>{busyLabel}</Loading> : children}
    </button>
  )
}
