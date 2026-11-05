import { useEffect, useState } from 'react'
import type { AuthState, PrNotification } from '../../shared/types'
import { Login } from './components/Login'
import { PrList } from './components/PrList'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PrTabs, type PrTab } from './components/PrTabs'
import { PrView, type PrStatus } from './components/PrView'
import { TopBar } from './components/TopBar'
import { useFirstRunSetup } from './components/Setup'
import { storage } from './util'

const api = window.prway

/** Open PRs stay mounted (hidden) so switching tabs keeps scroll, drafts and panels. */
const MAX_TABS = 10
const tabKey = (t: { repo: string; number: number }) => `${t.repo}#${t.number}`

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [tabs, setTabsState] = useState<PrTab[]>(() => storage.get<PrTab[]>('ui.tabs', []))
  const [activeKey, setActiveKeyState] = useState<string | null>(() => storage.get<string | null>('ui.activeTab', null))
  const setTabs = (update: (t: PrTab[]) => PrTab[]) =>
    setTabsState((prev) => {
      const next = update(prev)
      storage.set('ui.tabs', next)
      return next
    })
  const setActiveKey = (key: string | null) => {
    setActiveKeyState(key)
    storage.set('ui.activeTab', key)
  }
  const active = tabs.find((t) => tabKey(t) === activeKey) ?? null
  const [notifications, setNotifications] = useState<PrNotification[]>([])
  const [sidebarOpen, setSidebarOpenState] = useState(() => storage.get('ui.sidebarOpen', true))
  const setSidebarOpen = (open: boolean) => {
    setSidebarOpenState(open)
    storage.set('ui.sidebarOpen', open)
  }

  useEffect(() => {
    void api.auth.state().then(setAuth)
    void api.repos.getSelected().then(setRepo)
    void api.notifications.list().then(setNotifications)
    const offNotes = api.onNotifications(setNotifications)
    // Clicking a desktop notification opens that PR.
    const offOpen = api.onOpenPr(({ repo, number }) => openPr(repo, number))
    return () => {
      offNotes()
      offOpen()
    }
  }, [])

  function selectRepo(fullName: string) {
    setRepo(fullName)
    void api.repos.setSelected(fullName)
  }

  /** Opens a PR in a tab, or switches to its tab when it is already open. */
  function openPr(fullName: string, number: number, title?: string) {
    const key = tabKey({ repo: fullName, number })
    setTabs((ts) => {
      if (ts.some((t) => tabKey(t) === key)) return ts
      const next = [...ts, { repo: fullName, number, title: title ?? `#${number}` }]
      // Too many tabs: drop the oldest ones that are not the one being opened.
      return next.length > MAX_TABS ? next.slice(next.length - MAX_TABS) : next
    })
    setActiveKey(key)
  }

  function closeTab(key: string) {
    const index = tabs.findIndex((t) => tabKey(t) === key)
    const rest = tabs.filter((t) => tabKey(t) !== key)
    setTabs(() => rest)
    if (key === activeKey) {
      const next = rest[Math.min(index, rest.length - 1)]
      setActiveKey(next ? tabKey(next) : null)
    }
  }

  function updateTab(key: string, status: PrStatus) {
    setTabs((ts) => {
      const t = ts.find((x) => tabKey(x) === key)
      if (!t || (t.title === status.title && t.drafts === status.drafts && t.waiting === status.waiting)) return ts
      return ts.map((x) => (tabKey(x) === key ? { ...x, ...status } : x))
    })
  }

  useFirstRunSetup(!!auth?.user)

  if (!auth) return <div className="center muted">Loading…</div>
  if (!auth.user) return <Login state={auth} onSignedIn={setAuth} />

  return (
    <div className="app">
      <TopBar
        user={auth.user}
        repo={repo}
        onSelectRepo={selectRepo}
        notifications={notifications}
        onOpenNotification={(n) => {
          if (n.prNumber) openPr(n.repo, n.prNumber)
          void api.notifications.markRead(n.id)
        }}
        onLogout={async () => {
          await api.auth.logout()
          setAuth(await api.auth.state())
        }}
      />
      {!auth.tokenPersisted && (
        <div className="banner">No system keyring found: you will need to sign in again next time you open PRway.</div>
      )}
      <div className="workspace">
        {sidebarOpen ? (
          <aside className="sidebar">
            {repo ? (
              <PrList
                repo={repo}
                selected={active?.repo === repo ? active.number : null}
                open={new Set(tabs.filter((t) => t.repo === repo).map((t) => t.number))}
                me={auth.user.login}
                onSelect={(p) => openPr(p.repo, p.number, p.title)}
                onCollapse={() => setSidebarOpen(false)}
              />
            ) : (
              <p className="muted pad">Pick a repository at the top to see its open pull requests.</p>
            )}
          </aside>
        ) : (
          <aside className="sidebar-rail">
            <button className="icon" title="Show pull requests" onClick={() => setSidebarOpen(true)}>
              »
            </button>
            <span className="rail-label">Pull requests</span>
          </aside>
        )}
        <main className="main">
          {tabs.length > 0 && (
            <PrTabs tabs={tabs} activeKey={activeKey} currentRepo={repo} onSelect={setActiveKey} onClose={closeTab} />
          )}
          {tabs.map((t) => (
            <div key={tabKey(t)} className="tab-page" hidden={tabKey(t) !== activeKey}>
              <ErrorBoundary label={`#${t.number}`}>
                <PrView repo={t.repo} number={t.number} me={auth.user?.login ?? ''} onStatus={(s) => updateTab(tabKey(t), s)} />
              </ErrorBoundary>
            </div>
          ))}
          {!active && <div className="center muted">Select a pull request to start reviewing.</div>}
        </main>
      </div>
    </div>
  )
}
