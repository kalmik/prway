// AI accounts (Claude Code sign-ins or API keys, each with its model and effort), the default one, and which
// account each GitHub organization uses. Plus the badge that shows which account a PR's AI requests use.

import { useEffect, useState } from 'react'
import type { AiAccount, AiConfig, AiEffort, AiInUse, AiProviderId, AiStatus, ClaudeSignIn } from '../../../shared/types'
import { errorText } from '../util'
import { openSettings } from './SettingsDialog'

const api = window.prway

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (faster)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable, slowest)' }
]
const EFFORTS: AiEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** Tells every badge to reload after a change in the settings. */
const CHANGED = 'prway-ai-changed'
const announce = () => window.dispatchEvent(new Event(CHANGED))

/** "you@work.com (Acme)" for a Claude Code sign-in, or a hint when nobody is signed in there. */
export function signInText(s: ClaudeSignIn | null | undefined): string {
  if (!s) return ''
  if (!s.email) return `not signed in (${s.dir})`
  return s.organization && !s.organization.includes(s.email) ? `${s.email} (${s.organization})` : s.email
}

/** One line about an account: how it reaches Claude and who it bills. */
export function accountDetail(a: AiAccount, signIn?: ClaudeSignIn | null): string {
  return a.provider === 'claude-code'
    ? `Claude Code · ${signInText(signIn) || 'default sign-in'}`
    : `API key${a.hasApiKey ? '' : ' (missing)'}`
}

// ---- Which account a repository uses ----

/** The account AI requests on `repo` use; follows changes in the settings. */
export function useAiInUse(repo: string | null): AiInUse | null {
  const [inUse, setInUse] = useState<AiInUse | null>(null)
  useEffect(() => {
    if (!repo) return
    let live = true
    const load = () => api.ai.forRepo(repo).then((x) => live && setInUse(x), () => undefined)
    load()
    window.addEventListener(CHANGED, load)
    return () => {
      live = false
      window.removeEventListener(CHANGED, load)
    }
  }, [repo])
  return inUse
}

/** "AI: Work" chip: which account (subscription) PRway uses for this repository. Click to change it. */
export function AiBadge({ repo, compact, inline }: { repo: string; compact?: boolean; inline?: boolean }) {
  const inUse = useAiInUse(repo)
  if (!inUse) return null
  const { account, signIn, org, source } = inUse
  const who = account.provider === 'claude-code' ? signInText(signIn) : 'Anthropic API key'
  const why = source === 'org' ? `linked to ${org}` : `the default account (${org} has no link)`
  return (
    <button
      className={`ai-badge ${compact ? 'compact' : ''} ${inline ? 'inline' : ''}`}
      onClick={() => openSettings('orgs', repo)}
      title={`AI requests for ${org} use "${account.name}": ${who}, ${account.model}, ${account.effort} effort. It's ${why}. Click to change.`}
    >
      <span className="ai-badge-dot" />
      {compact ? account.name : `AI: ${account.name}`}
      {!compact && who && <span className="muted"> · {who}</span>}
    </button>
  )
}

// ---- Accounts page ----

const blank = (): Omit<AiAccount, 'hasApiKey'> => ({
  id: '',
  name: '',
  provider: 'claude-code',
  claudeConfigDir: null,
  model: 'claude-opus-5-5',
  effort: 'high'
})

export function AiAccountsSettings() {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [editing, setEditing] = useState<(Omit<AiAccount, 'hasApiKey'> & { hasApiKey?: boolean }) | null>(null)
  const [status, setStatus] = useState<Record<string, AiStatus | 'testing'>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.ai.config().then(setConfig, (e) => setError(errorText(e)))
  }, [])

  const apply = async (p: Promise<AiConfig>) => {
    setError(null)
    try {
      setConfig(await p)
      announce()
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    }
  }

  async function test(id: string) {
    setStatus((s) => ({ ...s, [id]: 'testing' }))
    const r = await api.ai.test(id).catch((e) => ({ ok: false, detail: errorText(e) }))
    setStatus((s) => ({ ...s, [id]: r }))
  }

  if (!config) return error ? <p className="error small">{error}</p> : null
  const usedBy = (id: string) => Object.entries(config.orgs).filter(([, a]) => a === id).map(([o]) => o)

  return (
    <div className="settings-section ai-accounts">
      <p className="small muted">
        Each account is one way to reach Claude: a Claude Code sign-in (your subscription) or an API key, with its own model and
        effort. The default account is used everywhere; link organizations to other accounts in the Organizations tab.
      </p>

      <ul className="account-list">
        {config.accounts.map((a) => {
          const st = status[a.id]
          const orgs = usedBy(a.id)
          return (
            <li key={a.id} className="account-card">
              <div className="row">
                <strong>{a.name}</strong>
                {config.defaultAccount === a.id && <span className="tag">default</span>}
                <span className="spacer" />
                <button className="small" disabled={st === 'testing'} onClick={() => void test(a.id)}>
                  {st === 'testing' ? 'Testing…' : 'Test'}
                </button>
                <button className="small" onClick={() => setEditing({ ...a })}>
                  Edit
                </button>
                {config.defaultAccount !== a.id && (
                  <>
                    <button className="small" onClick={() => void apply(api.ai.setDefault(a.id))}>
                      Make default
                    </button>
                    <button className="small" onClick={() => void apply(api.ai.deleteAccount(a.id))} title="Organizations linked to it go back to the default">
                      Delete
                    </button>
                  </>
                )}
              </div>
              <div className="small muted">
                {accountDetail(a, config.signIns[a.id])} · {a.model} · {a.effort} effort
              </div>
              <div className="small muted">
                {config.defaultAccount === a.id
                  ? `Used by every organization without a link${orgs.length ? `, and linked to ${orgs.join(', ')}` : ''}`
                  : orgs.length
                    ? `Linked to ${orgs.join(', ')}`
                    : 'Not linked to any organization yet'}
              </div>
              {st && st !== 'testing' && <p className={`small ${st.ok ? 'ok' : 'error'}`}>{st.detail}</p>}
            </li>
          )
        })}
      </ul>
      {!editing && (
        <button onClick={() => setEditing(blank())} className="small">
          + Add account
        </button>
      )}
      {error && <p className="error small">{error}</p>}

      {editing && (
        <AccountEditor
          account={editing}
          onCancel={() => setEditing(null)}
          onSave={async (acc, apiKey) => {
            if (await apply(api.ai.saveAccount(acc, apiKey))) setEditing(null)
          }}
        />
      )}
    </div>
  )
}

function AccountEditor({
  account,
  onSave,
  onCancel
}: {
  account: Omit<AiAccount, 'hasApiKey'> & { hasApiKey?: boolean }
  onSave: (a: Omit<AiAccount, 'hasApiKey'>, apiKey?: string | null) => Promise<void>
  onCancel: () => void
}) {
  const [a, setA] = useState(account)
  const [apiKey, setApiKey] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [signIn, setSignIn] = useState<ClaudeSignIn | null>(null)
  const [busy, setBusy] = useState(false)
  const update = (patch: Partial<typeof a>) => setA({ ...a, ...patch })
  const customModel = !MODELS.some((m) => m.id === a.model)

  // Show who the folder is signed in as while you type it.
  useEffect(() => {
    if (a.provider !== 'claude-code') return
    const t = setTimeout(() => api.ai.inspectClaudeDir(a.claudeConfigDir || null).then(setSignIn, () => setSignIn(null)), 250)
    return () => clearTimeout(t)
  }, [a.provider, a.claudeConfigDir])

  const dirExample = a.claudeConfigDir?.trim() || '~/.claude-work'
  return (
    <div className="account-editor card">
      <h4>{account.id ? `Edit ${account.name}` : 'New account'}</h4>
      <label className="field">
        <span className="small muted">Name</span>
        <input autoFocus placeholder="e.g. Work, Personal" value={a.name} onChange={(e) => update({ name: e.target.value })} />
      </label>

      <fieldset>
        <legend className="small muted">How it reaches Claude</legend>
        {(
          [
            ['claude-code', 'Claude Code — a Claude subscription', 'Uses the "claude" command signed in on this computer. No API key needed.'],
            ['anthropic-api', 'Anthropic API key', 'Billed per token on an Anthropic Console account.']
          ] as [AiProviderId, string, string][]
        ).map(([id, label, hint]) => (
          <label key={id} className="radio">
            <input type="radio" checked={a.provider === id} onChange={() => update({ provider: id })} />
            <span>
              {label}
              <span className="small muted block">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {a.provider === 'claude-code' && (
        <label className="field">
          <span className="small muted">Claude Code config folder (empty: Claude Code's default sign-in)</span>
          <input
            placeholder="~/.claude"
            value={a.claudeConfigDir ?? ''}
            onChange={(e) => update({ claudeConfigDir: e.target.value || null })}
          />
          <span className={`small ${signIn?.email ? 'ok' : 'muted'}`}>
            {signIn ? (signIn.email ? `Signed in as ${signInText(signIn)}` : `Nobody is signed in at ${signIn.dir} yet.`) : ' '}
          </span>
          <span className="small muted">
            Each folder holds its own sign-in. To add another subscription, run this once in a terminal and use /login:{' '}
            <code>CLAUDE_CONFIG_DIR={dirExample} claude</code>
          </span>
        </label>
      )}

      {a.provider === 'anthropic-api' && (
        <label className="field">
          <span className="small muted">API key {a.hasApiKey && !removeKey && '(saved — leave empty to keep it)'}</span>
          <div className="row">
            <input type="password" placeholder="sk-ant-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            {a.hasApiKey && !removeKey && <button onClick={() => setRemoveKey(true)}>Remove key</button>}
          </div>
        </label>
      )}

      <label className="field">
        <span className="small muted">Model</span>
        <select value={customModel ? 'custom' : a.model} onChange={(e) => update({ model: e.target.value === 'custom' ? '' : e.target.value })}>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          <option value="custom">Other model id…</option>
        </select>
        {customModel && <input placeholder="model id" value={a.model} onChange={(e) => update({ model: e.target.value })} />}
      </label>

      <label className="field">
        <span className="small muted">Effort (higher = more thorough, slower, uses more of the quota)</span>
        <select value={a.effort} onChange={(e) => update({ effort: e.target.value as AiEffort })}>
          {EFFORTS.map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
      </label>

      <div className="row end">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={busy || !a.name.trim()}
          onClick={async () => {
            setBusy(true)
            const { hasApiKey: _ignored, ...rest } = a
            await onSave(rest, removeKey ? null : apiKey.trim() ? apiKey : undefined)
            setBusy(false)
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
}

// ---- Organizations page ----

export function AiOrgsSettings({ repo }: { repo: string | null }) {
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [orgs, setOrgs] = useState<string[]>([])
  const [adding, setAdding] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.ai.config().then(setConfig, (e) => setError(errorText(e)))
    // Organizations you have repositories in, plus the one of the open PR.
    api.repos.list().then(
      (l) => setOrgs((o) => [...new Set([...o, ...l.repos.map((r) => r.fullName.split('/')[0])])]),
      () => undefined
    )
  }, [])

  const apply = async (p: Promise<AiConfig>) => {
    setError(null)
    try {
      setConfig(await p)
      announce()
    } catch (e) {
      setError(errorText(e))
    }
  }

  if (!config) return error ? <p className="error small">{error}</p> : null
  const current = repo?.split('/')[0]
  const all = [...new Set([...(current ? [current] : []), ...Object.keys(config.orgs), ...orgs])].sort((x, y) =>
    x === current ? -1 : y === current ? 1 : x.localeCompare(y)
  )
  const def = config.accounts.find((a) => a.id === config.defaultAccount)
  const nameOf = (id: string) => config.accounts.find((a) => a.id === id)?.name ?? '?'

  return (
    <div className="settings-section ai-orgs">
      <label className="field">
        <span className="small muted">Default account (every organization without a link)</span>
        <select value={config.defaultAccount} onChange={(e) => void apply(api.ai.setDefault(e.target.value))}>
          {config.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} — {accountDetail(a, config.signIns[a.id])}
            </option>
          ))}
        </select>
      </label>

      <table className="org-table">
        <thead>
          <tr>
            <th>Organization</th>
            <th>AI account</th>
          </tr>
        </thead>
        <tbody>
          {all.map((org) => (
            <tr key={org} className={org === current ? 'current' : ''}>
              <td>
                {org}
                {org === current && <span className="small muted"> (this PR)</span>}
              </td>
              <td>
                <select value={config.orgs[org] ?? ''} onChange={(e) => void apply(api.ai.linkOrg(org, e.target.value || null))}>
                  <option value="">Default ({def?.name})</option>
                  {config.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                {config.orgs[org] && !config.accounts.some((a) => a.id === config.orgs[org]) && (
                  <span className="small error"> {nameOf(config.orgs[org])} was deleted</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <input placeholder="Another organization or user" value={adding} onChange={(e) => setAdding(e.target.value)} />
        <button
          disabled={!adding.trim()}
          onClick={() => {
            setOrgs((o) => [...new Set([...o, adding.trim()])])
            setAdding('')
          }}
        >
          Add
        </button>
      </div>
      <p className="small muted">An account can be linked to any number of organizations. Manage accounts in the AI accounts tab.</p>
      {error && <p className="error small">{error}</p>}
    </div>
  )
}
