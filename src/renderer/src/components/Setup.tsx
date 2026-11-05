// Setup: what PRway needs outside itself (git, and Claude Code for subscription accounts), with a fix for each.
// Shown once after the first sign-in when something is missing, and always under Settings → Setup.

import { useEffect, useRef, useState } from 'react'
import type { AiConfig, SetupCheck } from '../../../shared/types'
import { errorText, storage } from '../util'
import { openSettings } from './SettingsDialog'
import { signInText } from './AiAccounts'

const api = window.prway

/** Whether setup needs attention: git missing, or the default account uses Claude Code and it isn't ready. */
export function needsSetup(check: SetupCheck, config: AiConfig): boolean {
  const def = config.accounts.find((a) => a.id === config.defaultAccount)
  const usesClaude = def?.provider === 'claude-code'
  return !check.git.ok || (usesClaude && (!check.claude.ok || !check.signIn?.email))
}

/** After the first sign-in: opens Settings → Setup once if something is missing. */
export function useFirstRunSetup(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn || storage.get('ui.setupSeen', false)) return
    void Promise.all([api.setup.check(), api.ai.config()]).then(([check, config]) => {
      storage.set('ui.setupSeen', true)
      if (needsSetup(check, config)) openSettings('setup')
    }, () => undefined)
  }, [signedIn])
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="small"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

export function SetupPanel({ onOpenTab = openSettings }: { onOpenTab?: (tab: 'ai') => void }) {
  const [check, setCheck] = useState<SetupCheck | null>(null)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState<'git' | 'claude' | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [waitingLogin, setWaitingLogin] = useState(false)

  async function recheck() {
    setChecking(true)
    try {
      const [c, cfg] = await Promise.all([api.setup.check(), api.ai.config()])
      setCheck(c)
      setConfig(cfg)
      return c
    } catch (e) {
      setError(errorText(e))
      return null
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void recheck()
    return api.setup.onProgress((line) => setLog((l) => [...l.slice(-7), line]))
  }, [])

  // After "Sign in…": check every few seconds until the sign-in shows up (for up to 5 minutes).
  const waitStarted = useRef(0)
  useEffect(() => {
    if (!waitingLogin) return
    waitStarted.current = Date.now()
    const t = setInterval(async () => {
      const c = await api.setup.check().catch(() => null)
      if (c) setCheck(c)
      if (c?.signIn?.email || Date.now() - waitStarted.current > 5 * 60_000) setWaitingLogin(false)
    }, 3000)
    return () => clearInterval(t)
  }, [waitingLogin])

  async function fixGit() {
    setBusy('git')
    setError(null)
    setNote(null)
    try {
      setNote(await api.setup.fixGit())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  async function installClaude() {
    setBusy('claude')
    setError(null)
    setLog([])
    try {
      setCheck(await api.setup.installClaude())
      setNote('Claude Code is installed.')
    } catch (e) {
      setError(`The installer failed: ${errorText(e)}`)
    } finally {
      setBusy(null)
    }
  }

  async function signIn() {
    setError(null)
    try {
      await api.setup.openClaudeLogin()
      setWaitingLogin(true)
    } catch (e) {
      setError(errorText(e))
    }
  }

  if (!check || !config) return <div className="settings-section">{error ? <p className="error small">{error}</p> : <p className="small muted">Checking…</p>}</div>
  const def = config.accounts.find((a) => a.id === config.defaultAccount)
  const usesClaude = def?.provider === 'claude-code'
  const ready = !needsSetup(check, config)

  return (
    <div className="settings-section setup">
      <p className="small muted">
        PRway needs git to check out pull requests, and Claude Code for AI accounts that use a Claude subscription (or an API key
        instead). Nothing is installed without your click.
      </p>

      <ul className="setup-list">
        <li className={check.git.ok ? 'ok' : 'missing'}>
          <span className="setup-mark">{check.git.ok ? '✓' : '✗'}</span>
          <div className="setup-body">
            <strong>Git</strong> <span className="small muted">{check.git.ok ? check.git.version : 'not found'}</span>
            {!check.git.ok && (
              <div className="setup-fix">
                {check.gitAutoFix ? (
                  <>
                    <button className="primary small" disabled={busy !== null} onClick={() => void fixGit()}>
                      {busy === 'git' ? 'Installing…' : 'Install git'}
                    </button>
                    <span className="small muted">
                      runs <code>{check.gitFix}</code>
                      {check.platform === 'darwin' ? ' (Apple’s Command Line Tools)' : ''}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="small muted">Run in a terminal (needs your password):</span> <code>{check.gitFix}</code> <Copy text={check.gitFix} />
                  </>
                )}
              </div>
            )}
          </div>
        </li>

        <li className={check.claude.ok ? 'ok' : usesClaude ? 'missing' : 'optional'}>
          <span className="setup-mark">{check.claude.ok ? '✓' : usesClaude ? '✗' : '–'}</span>
          <div className="setup-body">
            <strong>Claude Code</strong>{' '}
            <span className="small muted">{check.claude.ok ? check.claude.version : usesClaude ? 'not found' : 'not found (not needed: your default account uses an API key)'}</span>
            {!check.claude.ok && (
              <div className="setup-fix">
                <button className={usesClaude ? 'primary small' : 'small'} disabled={busy !== null} onClick={() => void installClaude()}>
                  {busy === 'claude' ? 'Installing…' : 'Install Claude Code'}
                </button>
                <span className="small muted">
                  runs Anthropic’s installer: <code>{check.claudeInstall}</code>
                </span>
                {usesClaude && (
                  <span className="small muted">
                    {' '}
                    · or{' '}
                    <button className="link small" onClick={() => onOpenTab('ai')}>
                      use an API key instead
                    </button>
                  </span>
                )}
              </div>
            )}
            {busy === 'claude' && log.length > 0 && <pre className="setup-log">{log.join('\n')}</pre>}
          </div>
        </li>

        {check.claude.ok && usesClaude && (
          <li className={check.signIn?.email ? 'ok' : 'missing'}>
            <span className="setup-mark">{check.signIn?.email ? '✓' : '✗'}</span>
            <div className="setup-body">
              <strong>Claude sign-in</strong>{' '}
              <span className="small muted">
                {def?.name}: {check.signIn?.email ? signInText(check.signIn) : `nobody signed in (${check.signIn?.dir ?? 'default folder'})`}
              </span>
              {!check.signIn?.email && (
                <div className="setup-fix">
                  <button className="primary small" onClick={() => void signIn()}>
                    Sign in…
                  </button>
                  <span className="small muted">
                    {waitingLogin
                      ? 'In the terminal that opened, type /login and finish in the browser. This updates by itself.'
                      : 'opens a terminal running claude, where you type /login'}
                  </span>
                </div>
              )}
            </div>
          </li>
        )}
      </ul>

      {note && <p className="small ok">{note}</p>}
      {error && <p className="small error setup-error">{error}</p>}

      <div className="row end">
        {ready && <span className="small ok spacer">Everything PRway needs is ready.</span>}
        <button disabled={checking} onClick={() => void recheck()}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  )
}
