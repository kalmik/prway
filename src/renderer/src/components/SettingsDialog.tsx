// Settings page: AI accounts, which account each organization uses, and per-repository review prompts.

import { useState } from 'react'
import { AiAccountsSettings, AiOrgsSettings } from './AiAccounts'
import { PromptSettings } from './PromptSettings'
import { SetupPanel } from './Setup'
import { LearnedSettings } from './Learned'

export type SettingsTab = 'ai' | 'orgs' | 'prompts' | 'learned' | 'setup'

export function SettingsDialog({ tab: initialTab, repo, onClose }: { tab: SettingsTab; repo: string | null; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card dialog settings-dialog">
        <div className="row">
          <h3 className="spacer">Settings</h3>
          <button className="icon" title="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tabs settings-tabs">
          <button className={tab === 'ai' ? 'active' : ''} onClick={() => setTab('ai')}>
            AI accounts
          </button>
          <button className={tab === 'orgs' ? 'active' : ''} onClick={() => setTab('orgs')}>
            Organizations
          </button>
          <button className={tab === 'prompts' ? 'active' : ''} onClick={() => setTab('prompts')}>
            Review prompts
          </button>
          <button className={tab === 'learned' ? 'active' : ''} onClick={() => setTab('learned')}>
            Learned
          </button>
          <button className={tab === 'setup' ? 'active' : ''} onClick={() => setTab('setup')}>
            Setup
          </button>
        </div>
        <div className="settings-body">
          {tab === 'ai' && <AiAccountsSettings />}
          {tab === 'orgs' && <AiOrgsSettings repo={repo} />}
          {tab === 'prompts' && <PromptSettings initialRepo={repo} />}
          {tab === 'learned' && <LearnedSettings repo={repo} />}
          {tab === 'setup' && <SetupPanel onOpenTab={setTab} />}
        </div>
      </div>
    </div>
  )
}

/** Opens the settings page from anywhere (e.g. "Customise prompts for this repo"). */
export function openSettings(tab: SettingsTab, repo?: string | null): void {
  window.dispatchEvent(new CustomEvent('prway-open-settings', { detail: { tab, repo: repo ?? null } }))
}
