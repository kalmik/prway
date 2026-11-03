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

/** localStorage can throw (private mode, blocked storage); never let that break the app. */
export const storage = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key)
      return v ? (JSON.parse(v) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* ignore */
    }
  }
}
