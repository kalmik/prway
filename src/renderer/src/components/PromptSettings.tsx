// Settings → Review prompts: add repository context and instructions to the AI prompts, for all repositories
// or one repository, or replace a prompt's built-in instructions. The team's .prway.json rules show read-only.

import { useEffect, useState } from 'react'
import type { PromptKind, PromptLayer, PromptSettingsView } from '../../../shared/types'
import { errorText } from '../util'
import { Loading } from './Loading'

const api = window.prway

const KINDS: { kind: PromptKind; title: string; hint: string; placeholder: string }[] = [
  {
    kind: 'guide',
    title: 'Review guide',
    hint: 'The PR-level guide: intent, business rules, reading order, risks.',
    placeholder: 'e.g. Treat anything touching Ecto.Multi or building_id scoping as high risk. Flag API changes that are not in signal.open-api.yaml.'
  },
  {
    kind: 'walkthrough',
    title: 'File walkthroughs',
    hint: 'The file-by-file explanations, and what counts as trivial (pre-approved).',
    placeholder: 'e.g. Changes to priv/gettext and test descriptions are trivial. Always mention missing @spec on public functions.'
  },
  {
    kind: 'chat',
    title: 'Chat',
    hint: 'Answers to your questions about the PR.',
    placeholder: 'e.g. Answer in Portuguese. Prefer pointing at the code over long explanations.'
  }
]

function LayerSummary({ title, layer }: { title: string; layer: PromptLayer }) {
  const parts = [
    layer.context && ['Repository context', layer.context],
    ...KINDS.map(({ kind, title }) => layer[kind] && [`${title}${layer.replace[kind] ? ' (replaces the built-in)' : ''}`, layer[kind]])
  ].filter(Boolean) as [string, string][]
  if (!parts.length) return null
  return (
    <details className="layer-summary">
      <summary className="small">{title}</summary>
      {parts.map(([t, text]) => (
        <div key={t}>
          <div className="small muted">{t}</div>
          <pre>{text}</pre>
        </div>
      ))}
    </details>
  )
}

export function PromptSettings({ initialRepo }: { initialRepo: string | null }) {
  const [repo, setRepo] = useState<string | null>(initialRepo)
  const [view, setView] = useState<PromptSettingsView | null>(null)
  const [draft, setDraft] = useState<PromptLayer | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [preview, setPreview] = useState<{ kind: PromptKind; text: string } | null>(null)

  useEffect(() => {
    setView(null)
    setPreview(null)
    setMessage(null)
    api.prompts.get(repo).then(
      (v) => {
        setView(v)
        setDraft(v.personal)
      },
      (e) => setMessage({ ok: false, text: errorText(e) })
    )
  }, [repo])

  if (!view || !draft) return <p className="small">
        <Loading>Loading…</Loading>
      </p>
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.personal)
  const set = (patch: Partial<PromptLayer>) => setDraft({ ...draft, ...patch })

  async function save() {
    try {
      const v = await api.prompts.save(repo, draft!)
      setView(v)
      setDraft(v.personal)
      setMessage({ ok: true, text: 'Saved. New guides and walkthroughs use it; existing ones are marked so you can regenerate them.' })
    } catch (e) {
      setMessage({ ok: false, text: errorText(e) })
    }
  }

  async function showPreview(kind: PromptKind) {
    if (dirty) await save()
    setPreview({ kind, text: await api.prompts.preview(repo, kind) })
  }

  return (
    <div className="settings-section prompt-settings">
      <div className="row">
        <label className="field spacer">
          <span className="small muted">Applies to</span>
          <select value={repo ?? ''} onChange={(e) => setRepo(e.target.value || null)}>
            <option value="">All repositories</option>
            {view.repos.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted">
        {repo
          ? `Added after your "All repositories" settings and the team's .prway.json, so this repo's rules come last.`
          : 'Used for every repository, before anything a repository adds.'}
      </p>

      {view.global && <LayerSummary title="Also applied: your settings for all repositories" layer={view.global} />}
      {view.team ? (
        <LayerSummary title={`Also applied: team rules from ${view.teamSource}`} layer={view.team} />
      ) : (
        repo && (
          <p className="small muted">
            Teams can share rules by committing them in <code>.prway.json</code> under <code>"prompts"</code> (same fields as below, plus{' '}
            <code>"replace": {'{'} "guide": true {'}'}</code>).{view.teamSource ? ` ${view.teamSource}` : ''}
          </p>
        )
      )}

      <label className="field">
        <span>
          <strong>Repository context</strong> <span className="small muted">— what the system does, domain terms, conventions. Sent with every request.</span>
        </span>
        <textarea
          rows={4}
          className="mono"
          placeholder="e.g. WMS for 3PL warehouses (Elixir/Phoenix). Everything is scoped by building_id; LPN = license plate number. Ecto.Multi for multi-step writes."
          value={draft.context}
          onChange={(e) => set({ context: e.target.value })}
        />
      </label>

      {KINDS.map(({ kind, title, hint, placeholder }) => (
        <div key={kind} className="field prompt-kind">
          <div className="row">
            <span className="spacer">
              <strong>{title}</strong> <span className="small muted">— {hint}</span>
            </span>
            <label className="small">
              <input
                type="checkbox"
                checked={!!draft.replace[kind]}
                onChange={(e) => set({ replace: { ...draft.replace, [kind]: e.target.checked } })}
              />{' '}
              Replace the built-in instructions
            </label>
          </div>
          <textarea
            rows={draft.replace[kind] ? 12 : 3}
            className="mono"
            placeholder={draft.replace[kind] ? 'Your full instructions for this prompt (the output format stays the same).' : placeholder}
            value={draft[kind]}
            onChange={(e) => set({ [kind]: e.target.value } as Partial<PromptLayer>)}
          />
          <div className="row small">
            <details className="spacer">
              <summary className="muted">Built-in instructions</summary>
              <pre>{view.builtIn[kind]}</pre>
              {draft.replace[kind] && !draft[kind] && (
                <button className="link" onClick={() => set({ [kind]: view.builtIn[kind] } as Partial<PromptLayer>)}>
                  Start from the built-in text
                </button>
              )}
            </details>
            <button className="link" onClick={() => showPreview(kind)}>
              Preview what is sent
            </button>
          </div>
          {preview?.kind === kind && (
            <div className="prompt-preview">
              <div className="row small">
                <span className="spacer muted">System prompt for {title.toLowerCase()}{repo ? ` in ${repo}` : ''}</span>
                <button className="link" onClick={() => setPreview(null)}>
                  close
                </button>
              </div>
              <pre>{preview.text}</pre>
            </div>
          )}
        </div>
      ))}

      {message && <p className={`small ${message.ok ? 'ok' : 'error'}`}>{message.text}</p>}
      <div className="row end">
        <button
          disabled={!draft.context && !draft.guide && !draft.walkthrough && !draft.chat}
          onClick={() => setDraft({ context: '', guide: '', walkthrough: '', chat: '', replace: {} })}
          title="Clear everything for this scope (then Save)"
        >
          Reset to defaults
        </button>
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}
