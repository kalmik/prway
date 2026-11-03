// Tabs for the PRs you have open. Middle-click or × closes a tab; the worktree stays on disk.

export interface PrTab {
  repo: string
  number: number
  title: string
  drafts?: number
}

const key = (t: PrTab) => `${t.repo}#${t.number}`

export function PrTabs({
  tabs,
  activeKey,
  currentRepo,
  onSelect,
  onClose
}: {
  tabs: PrTab[]
  activeKey: string | null
  /** Tabs from other repos show the repo name. */
  currentRepo: string | null
  onSelect: (key: string) => void
  onClose: (key: string) => void
}) {
  return (
    <div className="pr-tabs" role="tablist">
      {tabs.map((t) => {
        const k = key(t)
        return (
          <div
            key={k}
            role="tab"
            aria-selected={k === activeKey}
            className={`pr-tab ${k === activeKey ? 'active' : ''}`}
            title={`${t.repo} #${t.number}\n${t.title}`}
            onClick={() => onSelect(k)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault()
                onClose(k)
              }
            }}
          >
            {t.repo !== currentRepo && <span className="tab-repo">{t.repo.split('/')[1]}</span>}
            <span className="tab-number">#{t.number}</span>
            <span className="tab-title">{t.title}</span>
            {!!t.drafts && (
              <span className="tab-drafts" title={`${t.drafts} pending comment${t.drafts > 1 ? 's' : ''} not sent yet`}>
                {t.drafts}
              </span>
            )}
            <button
              className="tab-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                onClose(k)
              }}
            >
              ×
            </button>
          </div>
        )
      })}
    </div>
  )
}
