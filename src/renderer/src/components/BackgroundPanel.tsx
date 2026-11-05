// Background tab: how the code this PR changes worked before, and why. For each core concept the guide found,
// PRway traces it through the code (callers up to entry points, callees, data, tests) and explains it, citing
// code and earlier PRs. Every traced function has a card you can correct; your edits win from then on.

import { useEffect, useState } from 'react'
import type { Briefing, BriefingClaim, BriefingCite, BriefingConcept, FunctionCard, ReviewGuide, TraceNode, TraceRole } from '../../../shared/types'
import { errorText, timeAgo } from '../util'

const api = window.prway

const ROLE_ORDER: TraceRole[] = ['entry', 'caller', 'seed', 'callee', 'data', 'test']
const ROLE_LABEL: Record<TraceRole, string> = {
  entry: 'entry point',
  caller: 'caller',
  seed: 'core',
  callee: 'calls',
  data: 'data',
  test: 'tests'
}
const KIND_LABEL: Record<BriefingConcept['kind'], string> = {
  behavior: 'behaviour change',
  feature: 'new feature',
  refactor: 'refactor',
  plumbing: 'plumbing'
}

const fileName = (p: string) => p.split('/').pop() ?? p

type OpenAt = (path: string, line: number | null, side: 'LEFT' | 'RIGHT') => void

export function BackgroundPanel({
  repo,
  number,
  headSha,
  guide,
  guideBusy,
  onGenerateGuide,
  onOpen,
  onOpenUrl,
  onBriefing
}: {
  repo: string
  number: number
  headSha: string
  guide: ReviewGuide | null
  guideBusy: boolean
  onGenerateGuide: () => void
  onOpen: OpenAt
  onOpenUrl: (url: string) => void
  /** A new briefing was built: pre-approval uses it. */
  onBriefing?: (b: Briefing) => void
}) {
  const [briefing, setBriefing] = useState<Briefing | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const [started, setStarted] = useState(0)
  const [, tick] = useState(0)

  useEffect(() => api.onBriefingProgress((p) => p.pr === `${repo}#${number}` && setStep(p.step)), [repo, number])
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [busy])

  useEffect(() => {
    let current = true
    setLoaded(false)
    api.briefing.get(repo, number).then(
      (b) => {
        if (!current) return
        setBriefing(b)
        setLoaded(true)
      },
      (err) => current && (setError(errorText(err)), setLoaded(true))
    )
    return () => {
      current = false
    }
  }, [repo, number, headSha])

  async function build() {
    setBusy(true)
    setError(null)
    setStep('Starting')
    setStarted(Date.now())
    try {
      const b = await api.briefing.generate(repo, number)
      setBriefing(b)
      onBriefing?.(b)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveCard(card: Pick<FunctionCard, 'id' | 'key' | 'summary' | 'rules'>) {
    const saved = await api.briefing.saveCard(repo, card)
    setBriefing((b) => (b ? { ...b, cards: { ...b.cards, [card.key]: saved } } : b))
  }

  const hasConcepts = !!guide?.concepts?.length
  const outdated = briefing && (briefing.headSha !== headSha || (guide && briefing.guideCreatedAt !== guide.createdAt))

  return (
    <div className="panel-body bg-panel">
      <div className="row bg-head">
        <span className="spacer small muted">
          {briefing
            ? `Traced ${briefing.stats.nodes} functions${briefing.stats.traceSeconds !== undefined ? ` in ${briefing.stats.traceSeconds}s` : ''} · ${briefing.stats.cardsReused} cards reused, ${briefing.stats.cardsNew} new · ${briefing.stats.seconds}s in total · ${briefing.model} · ${timeAgo(briefing.createdAt)}`
            : 'How the code this PR changes worked before, and why.'}
          {outdated && <span className="tag pending">{briefing.headSha !== headSha ? 'new commits since' : 'guide changed since'}</span>}
        </span>
        {hasConcepts && (
          <button className={briefing ? '' : 'primary'} disabled={busy} onClick={build}>
            {busy ? 'Tracing…' : briefing ? 'Rebuild' : 'Build background'}
          </button>
        )}
      </div>
      {error && <p className="small error">{error}</p>}

      {!guide && (
        <p className="small muted">
          The background starts from the core concepts the guide finds.{' '}
          <button className="link" disabled={guideBusy} onClick={onGenerateGuide}>
            {guideBusy ? 'Generating the guide…' : 'Generate the guide'}
          </button>
        </p>
      )}
      {guide && !hasConcepts && (
        <p className="small muted">
          This guide was made before PRway looked for core concepts.{' '}
          <button className="link" disabled={guideBusy} onClick={onGenerateGuide}>
            {guideBusy ? 'Regenerating…' : 'Regenerate the guide'}
          </button>{' '}
          to get them.
        </p>
      )}
      {hasConcepts && !briefing && loaded && !busy && (
        <div className="small muted">
          <p>The guide found {guide!.concepts!.length} core concept{guide!.concepts!.length > 1 ? 's' : ''}:</p>
          <ul className="bullets">
            {guide!.concepts!.map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong> <span className="tag">{KIND_LABEL[c.kind]}</span> — {c.question}
              </li>
            ))}
          </ul>
          <p>
            Build the background to trace them through the code (who calls them, what they call, the data and tests) and explain how they
            worked before this PR. Tracing is cached, so later PRs on the same code are faster.
          </p>
        </div>
      )}
      {busy && (
        <p className="small muted bg-progress">
          {step ?? 'Working'}… {Math.round((Date.now() - started) / 1000)}s
        </p>
      )}

      {briefing?.concepts.map((c, i) => (
        <ConceptView key={i} concept={c} cards={briefing.cards} onOpen={onOpen} onOpenUrl={onOpenUrl} onSaveCard={saveCard} />
      ))}

    </div>
  )
}

function ConceptView({
  concept: c,
  cards,
  onOpen,
  onOpenUrl,
  onSaveCard
}: {
  concept: BriefingConcept
  cards: Record<string, FunctionCard>
  onOpen: OpenAt
  onOpenUrl: (url: string) => void
  onSaveCard: (card: Pick<FunctionCard, 'id' | 'key' | 'summary' | 'rules'>) => Promise<void>
}) {
  const claims = (list: BriefingClaim[]) => (
    <ul className="bg-claims">
      {list.map((cl, i) => (
        <li key={i}>
          {cl.text}{' '}
          {cl.cites.map((ct, j) => (
            <Cite key={j} cite={ct} onOpen={onOpen} onOpenUrl={onOpenUrl} />
          ))}
        </li>
      ))}
    </ul>
  )
  const traced = c.trace.base.length + c.trace.head.length > 0
  return (
    <section className="bg-concept">
      <h3>
        {c.name} <span className="tag">{KIND_LABEL[c.kind]}</span>
      </h3>
      {c.question && <p className="small muted bg-question">{c.question}</p>}
      {c.change && (
        <p className="bg-change">
          <span className="bg-label">Change</span> {c.change}
        </p>
      )}
      {c.before.length > 0 && (
        <>
          <h4>Before this PR</h4>
          {claims(c.before)}
        </>
      )}
      {traced && (
        <>
          <h4>Why it was that way</h4>
          {c.why.length ? claims(c.why) : <p className="small muted">No earlier PR, review comment or test explains it.</p>}
        </>
      )}
      {c.watchOut.length > 0 && (
        <div className="bg-watch">
          <h4>Watch out</h4>
          {claims(c.watchOut)}
        </div>
      )}
      {c.trace.prs.length > 0 && (
        <p className="small muted">
          Earlier PRs on this code:{' '}
          {c.trace.prs.map((p, i) => (
            <span key={p.number}>
              {i > 0 && ', '}
              <button className="link" onClick={() => onOpenUrl(p.url)} title={p.title}>
                #{p.number}
              </button>{' '}
              {p.title}
            </span>
          ))}
        </p>
      )}
      {traced && <TraceView concept={c} cards={cards} onOpen={onOpen} onSaveCard={onSaveCard} />}
    </section>
  )
}

function Cite({ cite, onOpen, onOpenUrl }: { cite: BriefingCite; onOpen: OpenAt; onOpenUrl: (url: string) => void }) {
  if (cite.kind === 'pr') {
    return (
      <button className="bg-cite" onClick={() => cite.url && onOpenUrl(cite.url)}>
        #{cite.pr}
      </button>
    )
  }
  return (
    <button
      className={`bg-cite ${cite.side === 'base' ? 'base' : ''}`}
      title={`${cite.path}:${cite.line} (${cite.side === 'base' ? 'before the PR' : 'in the PR'})`}
      onClick={() => onOpen(cite.path!, cite.line!, cite.side === 'base' ? 'LEFT' : 'RIGHT')}
    >
      {fileName(cite.path!)}:{cite.line}
      {cite.side === 'base' && <span className="muted"> before</span>}
    </button>
  )
}

/** The traced functions, grouped by role; each with its card. Shows the PR's version, plus functions it removed. */
function TraceView({
  concept: c,
  cards,
  onOpen,
  onSaveCard
}: {
  concept: BriefingConcept
  cards: Record<string, FunctionCard>
  onOpen: OpenAt
  onSaveCard: (card: Pick<FunctionCard, 'id' | 'key' | 'summary' | 'rules'>) => Promise<void>
}) {
  const baseById = new Map(c.trace.base.map((n) => [n.id, n]))
  const headIds = new Set(c.trace.head.map((n) => n.id))
  const rows: { node: TraceNode; state: 'same' | 'changed' | 'new' | 'removed' }[] = [
    ...c.trace.head.map((n) => {
      const before = baseById.get(n.id)
      return { node: n, state: !before ? ('new' as const) : before.cardKey === n.cardKey ? ('same' as const) : ('changed' as const) }
    }),
    ...c.trace.base.filter((n) => !headIds.has(n.id)).map((n) => ({ node: n, state: 'removed' as const }))
  ].sort((a, b) => ROLE_ORDER.indexOf(a.node.role) - ROLE_ORDER.indexOf(b.node.role) || a.node.depth - b.node.depth)
  return (
    <details className="bg-trace">
      <summary className="small">
        Traced code: {rows.filter((r) => r.node.role !== 'test').length} functions
        {rows.some((r) => r.node.role === 'entry') && `, up to ${rows.filter((r) => r.node.role === 'entry').length} entry point(s)`} · cards you can
        correct
      </summary>
      <ul>
        {rows.map(({ node, state }) => (
          <TraceRow
            key={`${state}:${node.id}`}
            node={node}
            state={state}
            card={node.cardKey ? cards[node.cardKey] : undefined}
            onOpen={onOpen}
            onSaveCard={onSaveCard}
          />
        ))}
      </ul>
    </details>
  )
}

function TraceRow({
  node: n,
  state,
  card,
  onOpen,
  onSaveCard
}: {
  node: TraceNode
  state: 'same' | 'changed' | 'new' | 'removed'
  card: FunctionCard | undefined
  onOpen: OpenAt
  onSaveCard: (card: Pick<FunctionCard, 'id' | 'key' | 'summary' | 'rules'>) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [summary, setSummary] = useState('')
  const [rules, setRules] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function edit() {
    setSummary(card?.summary ?? '')
    setRules(card?.rules.join('\n') ?? '')
    setEditing(true)
    setError(null)
  }
  async function save() {
    setSaving(true)
    try {
      await onSaveCard({ id: n.id, key: n.cardKey, summary, rules: rules.split('\n') })
      setEditing(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const side = state === 'removed' ? 'LEFT' : 'RIGHT'
  return (
    <li className={`bg-node role-${n.role}`}>
      <div className="row">
        <span className="bg-role">{ROLE_LABEL[n.role]}</span>
        {n.role === 'test' ? (
          <button className="link mono" onClick={() => onOpen(n.path, 1, 'RIGHT')}>
            {fileName(n.path)}
          </button>
        ) : (
          <button className="link mono" title={`${n.path}:${n.line}`} onClick={() => onOpen(n.path, n.line, side)}>
            {n.container ? `${n.container.split('.').pop()}.` : ''}
            {n.name}
          </button>
        )}
        <span className="small muted spacer">{n.role !== 'test' && fileName(n.path)}</span>
        {state !== 'same' && <span className={`tag bg-state ${state}`}>{state === 'changed' ? 'changed in this PR' : state === 'new' ? 'new' : 'removed'}</span>}
        {n.cardKey && !editing && (
          <button className="link small" onClick={edit}>
            {card ? 'Edit' : 'Add note'}
          </button>
        )}
      </div>
      {n.tests && (
        <ul className="bg-tests small muted">
          {n.tests.map((t) => (
            <li key={t}>“{t}”</li>
          ))}
        </ul>
      )}
      {card && !editing && (
        <div className="bg-card small">
          {card.summary}
          {card.rules.length > 0 && (
            <ul>
              {card.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {card.source === 'edited' && <span className="tag">{card.outdated ? 'your note, for an older version' : 'edited by you'}</span>}
        </div>
      )}
      {editing && (
        <div className="bg-edit small">
          <label>
            What it does
            <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
          <label>
            Rules it enforces (one per line)
            <textarea rows={3} value={rules} onChange={(e) => setRules(e.target.value)} />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <span className="spacer muted">Your version is used in every later PR while this code stays the same.</span>
            <button onClick={() => setEditing(false)}>Cancel</button>
            <button className="primary" disabled={saving || !summary.trim()} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
