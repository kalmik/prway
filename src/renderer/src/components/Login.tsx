import { useState } from 'react'
import { SettingsDialog } from './SettingsDialog'
import type { AuthState, DeviceCode } from '../../../shared/types'
import { errorText } from '../util'

const api = window.prway

export function Login({ state, onSignedIn }: { state: AuthState; onSignedIn: (s: AuthState) => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [setup, setSetup] = useState(false)

  async function deviceLogin() {
    setError(null)
    setBusy(true)
    try {
      const c = await api.auth.startDeviceFlow()
      setCode(c)
      void api.openExternal(c.verificationUri)
      onSignedIn(await api.auth.waitForDeviceFlow())
    } catch (err) {
      setError(errorText(err))
      setCode(null)
    } finally {
      setBusy(false)
    }
  }

  async function tokenLogin(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      onSignedIn(await api.auth.loginWithToken(token))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="center">
      <div className="card login">
        <h1>PRway</h1>
        <p className="muted">Code review that focuses on what changed and why.</p>

        {state.deviceFlowAvailable && !code && (
          <button className="primary wide" disabled={busy} onClick={deviceLogin}>
            Sign in with GitHub
          </button>
        )}

        {code && (
          <div className="device-code">
            <p>Enter this code on GitHub:</p>
            <div className="code">{code.userCode}</div>
            <div className="row">
              <button onClick={() => navigator.clipboard.writeText(code.userCode)}>Copy code</button>
              <button onClick={() => api.openExternal(code.verificationUri)}>Open GitHub</button>
              <button
                onClick={() => {
                  void api.auth.cancelDeviceFlow()
                  setCode(null)
                }}
              >
                Cancel
              </button>
            </div>
            <p className="muted small">Waiting for you to approve…</p>
          </div>
        )}

        {!code && (
          <form onSubmit={tokenLogin} className="token-form">
            <label className="small muted">
              {state.deviceFlowAvailable ? 'Or use' : 'Sign in with'} a classic personal access token (scopes: repo,
              read:org, notifications)
            </label>
            <div className="row">
              <input
                type="password"
                placeholder="ghp_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus={!state.deviceFlowAvailable}
              />
              <button type="submit" disabled={busy || !token.trim()}>
                Sign in
              </button>
            </div>
            <button
              type="button"
              className="link small"
              onClick={() =>
                api.openExternal(
                  'https://github.com/settings/tokens/new?scopes=repo,read:org,notifications&description=PRway'
                )
              }
            >
              Create a token on GitHub
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}
        <button type="button" className="link small login-setup" onClick={() => setSetup(true)}>
          Check what PRway needs (git, Claude Code)
        </button>
      </div>
      {setup && <SettingsDialog tab="setup" repo={null} onClose={() => setSetup(false)} />}
    </div>
  )
}
