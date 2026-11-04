import { useCallback, useEffect, useState } from 'react'
/** Electron wraps errors from the main process as "Error invoking remote method 'x': Error: msg". Keep only msg. */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  const units: [number, string][] = [[60, 'm'], [3600, 'h'], [86400, 'd'], [2592000, 'mo']]
  let out = `${Math.floor(s / 60)}m`
  for (const [size, label] of units) if (s >= size) out = `${Math.floor(s / size)}${label}`
  return `${out} ago`
}

/**
 * UI state that survives restarts: open tabs, drafts, chat, viewed files, layout.
 * Saved by the main process in ui-state.json (written on every change), read once at startup.
 */
const state: Record<string, unknown> = (() => {
  try {
    const saved = window.prway.state.loadAll()
    if (Object.keys(saved).length) return { ...saved }
    // First run with ui-state.json: bring over what earlier versions kept in localStorage.
    const migrated: Record<string, unknown> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!
      try {
        migrated[k] = JSON.parse(localStorage.getItem(k)!)
        window.prway.state.set(k, migrated[k])
      } catch {
        /* not ours */
      }
    }
    return migrated
  } catch {
    return {}
  }
})()

export const storage = {
  get<T>(key: string, fallback: T): T {
    return key in state ? (state[key] as T) : fallback
  },
  set(key: string, value: unknown): void {
    const empty = value === null || value === undefined || (Array.isArray(value) && value.length === 0)
    if (empty) delete state[key]
    else state[key] = value
    window.prway.state.set(key, empty ? null : value)
  }
}

/** State that survives restarts (saved by the main process), per key. Every open tab using the same key stays in sync. */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => storage.get(key, initial))
  useEffect(() => {
    const onChange = (e: Event) => {
      const { key: k, value: v } = (e as CustomEvent<{ key: string; value: T }>).detail
      if (k === key) setValue(v)
    }
    window.addEventListener('prway-stored', onChange)
    return () => window.removeEventListener('prway-stored', onChange)
  }, [key])
  const set = useCallback(
    (v: T) => {
      storage.set(key, v)
      window.dispatchEvent(new CustomEvent('prway-stored', { detail: { key, value: v } }))
    },
    [key]
  )
  return [value, set]
}
