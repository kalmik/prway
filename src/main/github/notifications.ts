// Polls GitHub's notifications API and keeps the unread pull request notifications.
// GitHub asks clients to respect X-Poll-Interval and to send If-Modified-Since,
// which makes "nothing changed" responses (304) free of rate limit.

import type { PrNotification } from '../../shared/types'
import type { GitHub } from './api'

interface RawThread {
  id: string
  reason: string
  updated_at: string
  subject: { title: string; url: string | null; type: string }
  repository: { full_name: string }
}

export interface PollerEvents {
  /** Full current list, sent on every change. */
  onChange(items: PrNotification[]): void
  /** Only the items that are new since the last poll (never called on the first poll). */
  onNew(items: PrNotification[], firstPoll: boolean): void
}

function toNotification(t: RawThread): PrNotification {
  const prNumber = Number(/\/pulls\/(\d+)$/.exec(t.subject.url ?? '')?.[1]) || null
  const repo = t.repository.full_name
  return {
    id: t.id,
    repo,
    prNumber,
    title: t.subject.title,
    reason: t.reason,
    updatedAt: t.updated_at,
    url: prNumber ? `https://github.com/${repo}/pull/${prNumber}` : `https://github.com/${repo}`
  }
}

export class NotificationPoller {
  private timer: NodeJS.Timeout | null = null
  private lastModified: string | null = null
  private items: PrNotification[] = []
  private seen = new Map<string, string>() // id -> updated_at
  private firstPoll = true
  private stopped = false

  constructor(
    private gh: GitHub,
    private events: PollerEvents
  ) {}

  start(): void {
    void this.poll()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  list(): PrNotification[] {
    return this.items
  }

  async markRead(id: string): Promise<void> {
    await this.gh.request(`/notifications/threads/${id}`, { method: 'PATCH' })
    this.items = this.items.filter((n) => n.id !== id)
    this.events.onChange(this.items)
  }

  private async poll(): Promise<void> {
    let intervalSec = 60
    try {
      const res = await this.gh.request<RawThread[]>('/notifications?per_page=50', {
        headers: this.lastModified ? { 'If-Modified-Since': this.lastModified } : {}
      })
      intervalSec = Math.max(60, Number(res.headers.get('x-poll-interval')) || 60)

      if (res.status !== 304) {
        this.lastModified = res.headers.get('last-modified')
        this.items = res.data.filter((t) => t.subject.type === 'PullRequest').map(toNotification)

        const fresh = this.items.filter((n) => this.seen.get(n.id) !== n.updatedAt)
        this.seen = new Map(this.items.map((n) => [n.id, n.updatedAt]))

        this.events.onChange(this.items)
        if (fresh.length) this.events.onNew(fresh, this.firstPoll)
        this.firstPoll = false
      }
    } catch (err) {
      // Network or token problems: keep the last list and try again later.
      console.warn('[notifications] poll failed:', (err as Error).message)
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.poll(), intervalSec * 1000)
  }
}
