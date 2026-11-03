// GitHub OAuth "device flow": the app shows a short code, the user approves it on github.com.
// No callback server and no client secret are needed.
// Docs: https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow

import type { DeviceCode } from '../../shared/types'

export const CLIENT_ID: string =
  import.meta.env.MAIN_VITE_GITHUB_CLIENT_ID || process.env.PRWAY_GITHUB_CLIENT_ID || ''

// repo: read private repos and PRs, submit reviews. notifications: relay GitHub notifications.
const SCOPES = 'repo read:org notifications'

interface PendingFlow {
  deviceCode: string
  intervalSec: number
  expiresAt: number
  cancelled: boolean
}

let pending: PendingFlow | null = null

async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  })
  if (!res.ok) throw new Error(`GitHub login failed (${res.status})`)
  return (await res.json()) as T
}

export async function startDeviceFlow(): Promise<DeviceCode> {
  if (!CLIENT_ID) throw new Error('No GitHub OAuth client ID configured (see README).')
  if (pending) pending.cancelled = true

  const r = await postForm<{
    device_code: string
    user_code: string
    verification_uri: string
    expires_in: number
    interval: number
    error_description?: string
  }>('https://github.com/login/device/code', { client_id: CLIENT_ID, scope: SCOPES })
  if (!r.device_code) throw new Error(r.error_description ?? 'Could not start GitHub login')

  pending = {
    deviceCode: r.device_code,
    intervalSec: r.interval,
    expiresAt: Date.now() + r.expires_in * 1000,
    cancelled: false
  }
  return { userCode: r.user_code, verificationUri: r.verification_uri, expiresIn: r.expires_in }
}

/** Polls GitHub until the user approves the code. Resolves with the access token. */
export async function waitForDeviceFlow(): Promise<string> {
  const flow = pending
  if (!flow) throw new Error('Login was not started')

  while (!flow.cancelled && Date.now() < flow.expiresAt) {
    await new Promise((r) => setTimeout(r, flow.intervalSec * 1000))
    if (flow.cancelled) break

    const r = await postForm<{ access_token?: string; error?: string; interval?: number }>(
      'https://github.com/login/oauth/access_token',
      {
        client_id: CLIENT_ID,
        device_code: flow.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }
    )
    if (r.access_token) {
      pending = null
      return r.access_token
    }
    if (r.error === 'authorization_pending') continue
    if (r.error === 'slow_down') {
      flow.intervalSec = r.interval ?? flow.intervalSec + 5
      continue
    }
    pending = null
    throw new Error(r.error === 'access_denied' ? 'Login was denied on GitHub' : `Login failed: ${r.error}`)
  }
  pending = null
  throw new Error(flow.cancelled ? 'Login cancelled' : 'The login code expired, try again')
}

export function cancelDeviceFlow(): void {
  if (pending) pending.cancelled = true
  pending = null
}
