import { useEffect, useState } from 'react'
import type { AiEffort, AiProviderId, AiSettings, AiStatus } from '../../../shared/types'
import { errorText } from '../util'

const api = window.prway

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable, slowest)' }
]

const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function AiSettingsDialog({ onClose, embedded }: { onClose: () => void; embedded?: boolean }) {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.ai.getSettings().then(setSettings, (e) => setError(errorText(e)))
  }, [])

  if (!settings) return null
  const update = (patch: Partial<AiSettings>) => setSettings({ ...settings, ...patch })
  const customModel = !MODELS.some((m) => m.id === settings.model)

  async function save(andTest: boolean) {
    if (!settings) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const { hasApiKey: _ignored, ...rest } = settings
      setSettings(await api.ai.saveSettings(rest, apiKey.trim() ? apiKey : undefined))
      setApiKey('')
      if (andTest) setStatus(await api.ai.test())
      else onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const body = (
    <>
        <p className="small muted">Used for the review guide, file walkthroughs and chat. PRway only sends the PR (description, commits, diff) and repository context.</p>

        <fieldset>
          <legend className="small muted">Provider</legend>
          {(
            [
              ['claude-code', 'Claude Code — your Claude subscription', 'Uses the "claude" command already signed in on this computer. No API key needed.'],
              ['anthropic-api', 'Anthropic API key', 'Billed per token on your Anthropic Console account.']
            ] as [AiProviderId, string, string][]
          ).map(([id, label, hint]) => (
            <label key={id} className="radio">
              <input type="radio" checked={settings.provider === id} onChange={() => update({ provider: id })} />
              <span>
                {label}
                <span className="small muted block">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {settings.provider === 'anthropic-api' && (
          <label className="field">
            <span className="small muted">API key {settings.hasApiKey && '(saved — leave empty to keep it)'}</span>
            <div className="row">
              <input type="password" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              {settings.hasApiKey && (
                <button
                  onClick={async () => {
                    const { hasApiKey: _ignored, ...rest } = settings
                    setSettings(await api.ai.saveSettings(rest, null))
                  }}
                >
                  Remove key
                </button>
              )}
            </div>
          </label>
        )}

        <label className="field">
          <span className="small muted">Model</span>
          <select
            value={customModel ? 'custom' : settings.model}
            onChange={(e) => update({ model: e.target.value === 'custom' ? '' : e.target.value })}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
            <option value="custom">Other model id…</option>
          </select>
          {customModel && (
            <input placeholder="model id" value={settings.model} onChange={(e) => update({ model: e.target.value })} />
          )}
        </label>

        <label className="field">
          <span className="small muted">Effort (higher = more thorough, slower, uses more of your quota)</span>
          <select value={settings.effort} onChange={(e) => update({ effort: e.target.value as AiEffort })}>
            {EFFORTS.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>

        {status && <p className={status.ok ? 'ok small' : 'error small'}>{status.detail}</p>}
        {error && <p className="error small">{error}</p>}

        <div className="row end">
          <button onClick={onClose}>Close</button>
          <button disabled={busy} onClick={() => save(true)}>
            {busy ? 'Testing…' : 'Save and test'}
          </button>
          <button className="primary" disabled={busy} onClick={() => save(false)}>
            Save
          </button>
        </div>
    </>
  )
  if (embedded) return <div className="settings-section">{body}</div>
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card dialog">
        <h3>AI settings</h3>
        {body}
      </div>
    </div>
  )
}
