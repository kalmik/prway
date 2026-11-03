import { useEffect, useState } from 'react'
import type { AuthState, PrNotification } from '../../shared/types'
import { Login } from './components/Login'
import { PrList } from './components/PrList'
import { PrView } from './components/PrView'
import { TopBar } from './components/TopBar'
import { storage } from './util'

const api = window.prway

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [repo, setRepo] = useState<string | null>(null)
  const [prNumber, setPrNumber] = useState<number | null>(null)
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
    setPrNumber(null)
    void api.repos.setSelected(fullName)
  }

  function openPr(fullName: string, number: number) {
    setRepo(fullName)
    void api.repos.setSelected(fullName)
    setPrNumber(number)
  }

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
              <PrList repo={repo} selected={prNumber} onSelect={setPrNumber} onCollapse={() => setSidebarOpen(false)} />
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
          {repo && prNumber ? (
            <PrView key={`${repo}#${prNumber}`} repo={repo} number={prNumber} />
          ) : (
            <div className="center muted">Select a pull request to start reviewing.</div>
          )}
        </main>
      </div>
    </div>
  )
}
