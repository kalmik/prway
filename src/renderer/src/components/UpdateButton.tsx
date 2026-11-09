// Top bar chip that appears when a newer PRway release is out: download it, then restart into it.

import { useEffect, useRef, useState } from 'react'
import type { UpdateState } from '../../../shared/types'
import { timeAgo } from '../util'

const api = window.prway

export function UpdateButton() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.updates.state().then(setState)
    return api.updates.onState(setState)
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  if (!state) return null
  const s = state.status
  const offer = s === 'available' || s === 'downloading' || s === 'ready' || s === 'installing'
  const label =
    s === 'downloading'
      ? `Downloading ${Math.round((state.progress ?? 0) * 100)}%`
      : s === 'ready'
        ? 'Restart to update'
        : s === 'installing'
          ? 'Restarting…'
          : `Update to ${state.latest}`

  return (
    <div className="dropdown" ref={ref}>
      {offer ? (
        <button className={`update-chip ${s === 'ready' ? 'ready' : ''}`} onClick={() => setOpen((o) => !o)}>
          ⬆ {label}
        </button>
      ) : (
        <button className="link small muted" title="Check for a newer PRway" onClick={() => setOpen((o) => !o)}>
          v{state.current}
        </button>
      )}
      {open && (
        <div className="menu update-menu pad">
          <p>
            <strong>PRway {state.current}</strong>
            {offer && state.latest && <> · {state.latest} is available</>}
            {s === 'current' && <span className="muted"> · up to date</span>}
          </p>
          {state.checkedAt && <p className="small muted">Checked {timeAgo(state.checkedAt)}</p>}
          {state.manualOnly && <p className="small muted">{state.manualOnly}</p>}
          {state.error && <p className="small error">{state.error}</p>}
          {s === 'downloading' && (
            <div className="update-progress">
              <div style={{ width: `${Math.round((state.progress ?? 0) * 100)}%` }} />
            </div>
          )}
          <div className="row end">
            {state.releaseUrl && (
              <button className="link small" onClick={() => api.openExternal(state.releaseUrl!)}>
                Release page ↗
              </button>
            )}
            {!offer && !state.manualOnly?.startsWith('Development') && (
              <button disabled={s === 'checking'} onClick={() => void api.updates.check()}>
                {s === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            )}
            {s === 'available' && !state.manualOnly && (
              <button className="primary" onClick={() => void api.updates.download()}>
                Download {state.latest}
              </button>
            )}
            {s === 'ready' && (
              <button className="primary" onClick={() => void api.updates.install()}>
                Restart now
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
