// Settings page: AI provider and model, and per-repository review prompts.

import { useState } from 'react'
import { AiSettingsDialog } from './AiSettingsDialog'
import { PromptSettings } from './PromptSettings'

export type SettingsTab = 'ai' | 'prompts'

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
            AI
          </button>
          <button className={tab === 'prompts' ? 'active' : ''} onClick={() => setTab('prompts')}>
            Review prompts
          </button>
        </div>
        <div className="settings-body">
          {tab === 'ai' ? <AiSettingsDialog embedded onClose={onClose} /> : <PromptSettings initialRepo={repo} />}
        </div>
      </div>
    </div>
  )
}

/** Opens the settings page from anywhere (e.g. "Customise prompts for this repo"). */
export function openSettings(tab: SettingsTab, repo?: string | null): void {
  window.dispatchEvent(new CustomEvent('prway-open-settings', { detail: { tab, repo: repo ?? null } }))
}
